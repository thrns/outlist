import { describe, expect, it, vi } from "vitest";
import { parseAssessmentArguments, runAssessmentCli, type AssessmentCliDependencies } from "./assess";

function categoriesQuery(): NonNullable<AssessmentCliDependencies["supabase"]>["from"] {
  const query = {
    select: () => query,
    eq: () => query,
    in: () => query,
    order: () => query,
    limit: () => Promise.resolve({ data: [], error: null }),
  };
  return vi.fn((table: string) => {
    if (table !== "categories") throw new Error(`Unexpected assessment query: ${table}`);
    return query;
  }) as unknown as NonNullable<AssessmentCliDependencies["supabase"]>["from"];
}

describe("assessment CLI", () => {
  it("defaults to a mutation-free dry run", async () => {
    const rpc = vi.fn(); const lines: string[] = [];
    const status = await runAssessmentCli([], { supabase: { rpc, from: vi.fn() } as unknown as AssessmentCliDependencies["supabase"], writeStdout: (line) => lines.push(line) });
    expect(status).toBe(0); expect(rpc).not.toHaveBeenCalled(); expect(lines.join("")).toContain('"mode": "dry-run"');
  });
  it("parses bounded execution options", () => {
    expect(parseAssessmentArguments(["--execute", "--resume", "--max-repositories", "5"])).toMatchObject({ mode: "execute", resume: true, maxRepositories: 5 });
  });
  it("rejects an unbounded repository limit", () => {
    expect(() => parseAssessmentArguments(["--execute", "--max-repositories", "101"])).toThrow();
  });
  it("requires execute mode to resume", () => {
    expect(() => parseAssessmentArguments(["--resume"])).toThrow();
  });

  it.each([
    { label: "serialization failure", code: "40001", outcome: "stale_worker_ownership", failureCode: "40001" },
    { label: "lock contention", code: "55P03", outcome: "retryable_failure", failureCode: "55P03" },
    { label: "connection failure", code: "08006", outcome: "database_operation_failure", failureCode: "08006" },
    { label: "free-form text", code: "private database code", outcome: "database_operation_failure", failureCode: null },
    { label: "malformed SQLSTATE", code: "PGRST000", outcome: "database_operation_failure", failureCode: null },
    { label: "short SQLSTATE", code: "4000", outcome: "database_operation_failure", failureCode: null },
    { label: "punctuated SQLSTATE", code: "55P0!", outcome: "database_operation_failure", failureCode: null },
  ])("reports a $label failure at the claiming stage and finalizes the job", async ({ code, outcome, failureCode }) => {
    const rpc = vi.fn(async (name: string) => {
      if (name === "start_github_repository_assessment_job") return { data: "job-existing", error: null };
      if (name === "claim_github_repository_assessments") return { data: null, error: { code, message: "private database connection detail" } };
      if (name === "finish_github_repository_assessment_job") return { data: { status: "partial", open_assessments: 4 }, error: null };
      return { data: null, error: null };
    });
    const stdout: string[] = [];
    const from = categoriesQuery();
    const status = await runAssessmentCli(["--execute", "--max-repositories", "4"], {
      supabase: { rpc, from } as unknown as AssessmentCliDependencies["supabase"],
      writeStdout: (line) => stdout.push(line),
    });
    const summary = JSON.parse(stdout.at(-1)!) as Record<string, unknown>;
    expect(status).toBe(1);
    expect(from).toHaveBeenCalledWith("categories");
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "start_github_repository_assessment_job",
      "claim_github_repository_assessments",
      "finish_github_repository_assessment_job",
    ]);
    expect(summary).toMatchObject({
      event: "assessment_summary", job_id: "job-existing", outcome_class: outcome,
      failure_stage: "claim", failure_code: failureCode, job_status: "partial",
      finalization: { attempted: true, ok: true, status: "partial", openAssessments: 4 },
      source_details_omitted: true, automatic_publication: false, automatic_logo_approval: false,
    });
    expect(stdout.join("")).not.toContain("private database connection detail");
    if (failureCode === null) expect(stdout.join("")).not.toContain(code);
  });

  it("recovers only the injected existing job through scoped RPCs", async () => {
    const jobId = "88704b50-ed03-4d46-b7f3-90ac7c477864";
    const rpc = vi.fn(async (name: string) => {
      if (name === "begin_github_repository_assessment_recovery") return { data: { job_id: jobId, status: "running" }, error: null };
      if (name === "claim_github_repository_assessments_for_recovery") return { data: [], error: null };
      if (name === "finish_github_repository_assessment_recovery") return { data: { status: "succeeded", job_status: "succeeded", open_assessments: 0 }, error: null };
      return { data: null, error: { code: "unexpected_rpc" } };
    });
    const stdout: string[] = [];
    const status = await runAssessmentCli(["--execute", "--resume", "--max-repositories", "4"], {
      supabase: {
        rpc,
        from: () => ({ select: () => ({ eq: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }) }) }),
      } as unknown as AssessmentCliDependencies["supabase"],
      recoveryJobId: jobId,
      writeStdout: (line) => stdout.push(line),
    });
    const summary = JSON.parse(stdout.at(-1)!) as Record<string, unknown>;
    expect(status).toBe(0);
    expect(summary).toMatchObject({ event: "assessment_recovery_summary", job_id: jobId, outcome_class: "completed", job_status: "succeeded" });
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "begin_github_repository_assessment_recovery",
      "claim_github_repository_assessments_for_recovery",
      "finish_github_repository_assessment_recovery",
    ]);
    expect(rpc.mock.calls.some(([name]) => ["start_github_repository_assessment_job", "claim_github_repository_assessments"].includes(name))).toBe(false);
  });

  it("refuses an assessment recovery worker budget above four before starting", async () => {
    const rpc = vi.fn();
    const status = await runAssessmentCli(["--execute", "--resume", "--max-repositories", "5"], {
      supabase: { rpc, from: vi.fn() } as unknown as AssessmentCliDependencies["supabase"],
      recoveryJobId: "88704b50-ed03-4d46-b7f3-90ac7c477864",
    });
    expect(status).toBe(1);
    expect(rpc).not.toHaveBeenCalled();
  });
});
