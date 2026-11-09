import { describe, expect, it, vi } from "vitest";
import type { AssessmentCliDependencies } from "./assess";
import { parseAssessmentRecoveryArguments, runAssessmentRecoveryCli } from "./recover-assessment";

const jobId = "88704b50-ed03-4d46-b7f3-90ac7c477864";
const baseArgs = ["--execute", "--resume", "--allow-hosted-writes", "--confirm-project-ref", "hvunezhzpnpdkfiqgaaa", "--job-id", jobId, "--max-assessments", "4"];
const env = {
  url: "https://hvunezhzpnpdkfiqgaaa.supabase.co",
  secretKey: "fixture-secret",
  label: "production",
};

function createDatabase(options: { activeAssessmentLeases?: number; job?: Record<string, unknown> | null } = {}) {
  let operatorCalls = 0;
  const report = {
    schema: { ready: true }, categories: { ready: true },
    active_leases: { assessment: options.activeAssessmentLeases ?? 0 }, running_jobs: [],
    inventory: { discovered_candidates: 26, successfully_enriched_public_repositories: 4, source_observation_count: 18 },
  };
  const rpc = vi.fn(async (name: string) => {
    if (name === "pipeline_operator_report") {
      operatorCalls += 1;
      return { data: report, error: null };
    }
    return { data: null, error: { code: "unexpected_rpc" } };
  });
  const from = vi.fn((table: string) => {
    let columns = "";
    const query = {
      select(value: string) { columns = value; return query; },
      eq() { return query; },
      in() { return query; },
      limit() { return query; },
      then(resolve: (result: { data: unknown; error: null }) => unknown, reject?: (error: unknown) => unknown) {
        const data = table === "ingestion_jobs"
          ? columns === "id,job_type,provider,status"
            ? options.job === null ? [] : [options.job ?? { id: jobId, job_type: "github_assessment", provider: "github", status: "running" }]
            : columns === "id,job_type"
              ? [{ id: jobId, job_type: "github_assessment" }]
              : [{ id: jobId, job_type: "github_assessment", provider: "github", status: "succeeded", items_processed: 4, items_created: 4, items_failed: 0, items_skipped: 0, finished_at: "2026-11-09T21:00:00Z" }]
          : table === "repository_assessments"
            ? ["assessed", "needs_review", "assessed", "needs_review"].map((status, index) => ({ id: `assessment-${index}`, status, attempts: 1, max_attempts: 5, lease_expires_at: null }))
            : [];
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return query;
  });
  return { rpc, from, operatorCalls: () => operatorCalls };
}

describe("assessment recovery CLI guards", () => {
  it("requires explicit execution, resume, hosted write confirmation, exact job, and a four-item budget", () => {
    expect(parseAssessmentRecoveryArguments(baseArgs)).toMatchObject({
      execute: true, resume: true, allowHostedWrites: true, confirmProjectRef: "hvunezhzpnpdkfiqgaaa",
      jobId, maxAssessments: 4,
    });
    for (const args of [
      baseArgs.filter((arg) => arg !== "--execute"),
      baseArgs.filter((arg) => arg !== "--resume"),
      baseArgs.filter((arg) => arg !== "--allow-hosted-writes"),
      baseArgs.slice(0, -2).concat("--max-assessments", "5"),
      baseArgs.filter((arg) => arg !== "--job-id" && arg !== jobId),
    ]) expect(() => parseAssessmentRecoveryArguments(args)).toThrow();
  });

  it("requires the production label and exact hosted project before database writes", async () => {
    const db = createDatabase();
    const stdout: string[] = [];
    const runWorker = vi.fn();
    const status = await runAssessmentRecoveryCli(baseArgs, {
      supabase: db as never, environment: { ...env, label: "staging" }, runWorker,
      writeStdout: (text) => stdout.push(text),
    });
    expect(status).toBe(1);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ outcome_class: "rejected", stage: "environment", mutation_started: false });
    expect(db.rpc).not.toHaveBeenCalled();
    expect(runWorker).not.toHaveBeenCalled();
  });

  it("rejects a nonmatching project confirmation before database writes", async () => {
    const db = createDatabase();
    const stdout: string[] = [];
    const status = await runAssessmentRecoveryCli([
      ...baseArgs.slice(0, baseArgs.indexOf("--confirm-project-ref")),
      "--confirm-project-ref", "some-other-project", ...baseArgs.slice(baseArgs.indexOf("--confirm-project-ref") + 2),
    ], {
      supabase: db as never, environment: env,
      writeStdout: (text) => stdout.push(text),
    });
    expect(status).toBe(1);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ outcome_class: "rejected", stage: "project_ref", mutation_started: false });
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("rejects an active assessment lease before invoking the worker", async () => {
    const db = createDatabase({ activeAssessmentLeases: 1 });
    const stdout: string[] = [];
    const runWorker = vi.fn();
    const status = await runAssessmentRecoveryCli(baseArgs, {
      supabase: db as never, environment: env, runWorker,
      writeStdout: (text) => stdout.push(text),
    });
    expect(status).toBe(1);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ outcome_class: "rejected", stage: "active_ingestion_lease", mutation_started: false });
    expect(runWorker).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null],
    ["different", { id: "11111111-1111-4111-8111-111111111111", job_type: "github_assessment", provider: "github", status: "running" }],
  ])("rejects a %s or different assessment job ID", async (_label, job) => {
    const db = createDatabase({ job });
    const stdout: string[] = [];
    const runWorker = vi.fn();
    const status = await runAssessmentRecoveryCli(baseArgs, {
      supabase: db as never, environment: env, runWorker,
      writeStdout: (text) => stdout.push(text),
    });
    expect(status).toBe(1);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ outcome_class: "rejected", stage: "job_verification", mutation_started: false });
    expect(runWorker).not.toHaveBeenCalled();
  });

  it("reuses the specified job and reports persisted results without involving other stages", async () => {
    const db = createDatabase();
    const stdout: string[] = [];
    const runWorker = vi.fn(async (args: string[], dependencies: AssessmentCliDependencies) => {
      expect(args).toEqual(["--execute", "--resume", "--max-repositories", "4"]);
      expect(dependencies.recoveryJobId).toBe(jobId);
      dependencies.writeStdout?.(`${JSON.stringify({ event: "assessment_recovery_summary", job_id: jobId, outcome_class: "completed", job_status: "succeeded", outcomes: { completed: 4 } })}\n`);
      return 0;
    });
    const status = await runAssessmentRecoveryCli(baseArgs, {
      supabase: db as never, environment: env, runWorker: runWorker as never,
      writeStdout: (text) => stdout.push(text),
    });
    const report = JSON.parse(stdout.join("")) as Record<string, unknown>;
    expect(status).toBe(0);
    expect(report).toMatchObject({
      event: "assessment_recovery_report", outcome_class: "completed", requested_job_id: jobId,
      initial_job_status: "running", final_job_status: "succeeded",
      assessments: { total: 4, completed: 4 },
      verification: { requested_existing_job_reused: true, no_new_ingestion_jobs: true, no_discovery_or_enrichment_work: true, assessment_count_within_limit: true, verified: true },
      publication_or_logo_approval_performed: false,
    });
    expect(db.rpc.mock.calls.map(([name]) => name)).toEqual(["pipeline_operator_report", "pipeline_operator_report"]);
  });
});
