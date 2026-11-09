import { describe, expect, it, vi } from "vitest";
import { classifyLiveSmokeResult, parsePipelineArguments, runPipelineCli, summarizePersistedSmoke, summarizeStage } from "../../scripts/pipeline";
import { SEARCH_PAGE_SIZE } from "./discovery/plans";

describe("unified pipeline CLI arguments", () => {
  it("defaults to bounded dry-run budgets", () => {
    expect(parsePipelineArguments([])).toMatchObject({
      mode: "dry-run",
      resume: false,
      liveSmoke: false,
      maxQueries: 1,
      maxPages: 1,
      maxCandidates: SEARCH_PAGE_SIZE,
      maxEnrichments: 5,
      maxAssessments: 5,
      maxLogoProjects: 5,
    });
  });

  it("accepts the documented bounded execute and resume commands", () => {
    expect(parsePipelineArguments(["--execute", "--max-queries", "1", "--max-pages", "1", "--max-candidates", "100"]))
      .toMatchObject({ mode: "execute", maxQueries: 1, maxPages: 1, maxCandidates: SEARCH_PAGE_SIZE });
    expect(parsePipelineArguments(["--resume", "--execute", "--max-candidates", "100"]))
      .toMatchObject({ mode: "execute", resume: true, maxCandidates: SEARCH_PAGE_SIZE });
  });

  it("requires explicit execute for resume and live smoke", () => {
    expect(() => parsePipelineArguments(["--resume"])).toThrow(/requires --execute/);
    expect(() => parsePipelineArguments(["--live-smoke"])).toThrow(/requires --execute/);
    expect(parsePipelineArguments(["--live-smoke", "--execute"]).liveSmoke).toBe(true);
  });

  it("rejects smoke budgets above their ceilings", () => {
    expect(() => parsePipelineArguments(["--live-smoke", "--execute", "--max-pages", "2"]))
      .toThrow(/cannot exceed/);
    expect(() => parsePipelineArguments(["--live-smoke", "--execute", "--max-candidates", "101"]))
      .toThrow(/from 1 to 100/);
    expect(parsePipelineArguments(["--live-smoke", "--execute"]))
      .toMatchObject({ maxQueries: 1, maxPages: 1, maxCandidates: 100, maxEnrichments: 5, maxAssessments: 5, maxLogoProjects: 5 });
  });

  it("requires both remote write confirmation flags", () => {
    expect(() => parsePipelineArguments(["--execute", "--allow-hosted-writes"]))
      .toThrow(/require both/);
    expect(() => parsePipelineArguments(["--execute", "--confirm-project-ref", "project-ref-01"]))
      .toThrow(/require both/);
    expect(parsePipelineArguments(["--execute", "--allow-hosted-writes", "--confirm-project-ref", "project-ref-01"]))
      .toMatchObject({ allowHostedWrites: true, confirmProjectRef: "project-ref-01" });
  });

  it("keeps status and audit read-only modes separate from worker options", () => {
    expect(parsePipelineArguments(["--status"]).mode).toBe("status");
    expect(parsePipelineArguments(["--audit"]).mode).toBe("audit");
    expect(() => parsePipelineArguments(["--status", "--execute"])).toThrow(/exactly one pipeline mode/);
    expect(() => parsePipelineArguments(["--audit", "--max-pages", "1"]))
      .toThrow(/do not accept execution or budget options/);
  });

  it("does not call a live smoke successful when no persisted rows were inspected", () => {
    const emptyLineage = summarizePersistedSmoke({ pipeline_run_id: "run-empty" });
    expect(emptyLineage).toMatchObject({
      inspected: true,
      success: false,
      records: { discovered_candidates: 0, enriched_repositories: 0, assessments: 0, project_drafts: 0, logo_candidates: 0 },
      validated_lineage_count: 0,
    });
    expect(classifyLiveSmokeResult(emptyLineage, [{ status: "complete" }]))
      .toEqual({ success: false, runStatus: "partial" });
  });

  it("reports a discovery page budget mismatch as partial, not successful or rate-limited", () => {
    const stage = summarizeStage("discovery", [
      { event: "candidate_budget_limited", page: 1, page_size: 100, checkpoint_preserved: true },
      { event: "discovery_summary", status: "partial", budget_limited: true, budget_diagnostic: {
        code: "candidate_budget_below_fetched_page", remaining_candidate_budget: 10, unique_public_candidates: 100,
        recommended_max_candidates: 100, checkpoint_preserved: true,
      } },
    ], [], "execute", 1, 15);
    expect(stage).toMatchObject({ stage: "discovery", status: "partial", exit_code: 1 });
    expect(stage.error_events).toContainEqual(expect.objectContaining({
      event: "candidate_budget_limited", code: "candidate_budget_below_fetched_page", checkpoint_preserved: true,
    }));
    expect(stage.last_durable_checkpoint).toMatchObject({ pages_committed: 0 });
  });

  it("blocks a hosted smoke budget smaller than one approved page before creating a job", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://hvunezhzpnpdkfiqgaaa.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "fixture-secret");
    vi.stubEnv("OUTLIST_SUPABASE_ENVIRONMENT", "production");
    const report = {
      schema: { ready: true }, categories: { ready: true },
      storage_bucket: { exists: true, public: true, file_size_limit: 2_097_152, mime_types: ["image/png", "image/jpeg", "image/webp"] },
      inventory: {}, running_jobs: [], active_leases: {}, integrity_findings: [],
    };
    const rpc = vi.fn(async (name: string) => name === "pipeline_operator_report"
      ? { data: report, error: null }
      : { data: null, error: null });
    const github = {
      getRateLimit: vi.fn(async () => ({
        kind: "ok",
        data: {
          resources: { search: { limit: 30, remaining: 20, reset: 1, used: 10 } },
          rate: { limit: 5000, remaining: 4900, reset: 1, used: 100 },
        },
      })),
    } as never;
    const stdout: string[] = [];
    try {
      const status = await runPipelineCli([
        "--live-smoke", "--execute", "--max-candidates", "50",
        "--allow-hosted-writes", "--confirm-project-ref", "hvunezhzpnpdkfiqgaaa",
      ], {
        supabase: { rpc, storage: { listBuckets: vi.fn() } } as never,
        github,
        writeStdout: (text) => stdout.push(text),
      });
      const preflight = JSON.parse(stdout.join("")) as Record<string, unknown>;
      expect(status).toBe(1);
      expect(preflight).toMatchObject({ event: "pipeline_preflight", mutation_started: false });
      expect(preflight.blockers).toContainEqual(expect.objectContaining({ code: "discovery_candidate_budget_below_page_size" }));
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledWith("pipeline_operator_report");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("stops later workers and reports partial when discovery cannot fit a fetched page", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("SUPABASE_SECRET_KEY", "local-fixture-secret");
    vi.stubEnv("OUTLIST_SUPABASE_ENVIRONMENT", "local");
    const operatorReport = {
      schema: { ready: true }, categories: { ready: true },
      storage_bucket: { exists: true, public: true, file_size_limit: 2_097_152, mime_types: ["image/png", "image/jpeg", "image/webp"] },
      inventory: {}, running_jobs: [], active_leases: {}, checkpoints: [], retry_schedule: [], integrity_findings: [],
    };
    const rpc = vi.fn(async (name: string, _args?: Record<string, unknown>) => {
      void _args;
      if (name === "pipeline_operator_report") return { data: operatorReport, error: null };
      if (name === "start_discovery_job") return { data: "job-budget-limited", error: null };
      if (name === "claim_discovery_partitions") return { data: [{
        id: "query-budget-limited", partition_key: "budget-limited-query", query_text: "topic:fixture is:public",
        query_parameters: { sort: "stars", order: "desc", per_page: SEARCH_PAGE_SIZE },
        query_fingerprint: "budget-limited-fingerprint", cursor: null, total_count: null,
        incomplete_results: false, lease_token: "00000000-0000-0000-0000-000000000099",
      }], error: null };
      if (name === "pipeline_operator_verify_run") return { data: {
        pipeline_run_id: "run-budget-limited", discovered_candidates: [], enriched_repositories: [],
        assessments: [], project_drafts: [], logo_candidates: [], validated_lineages: [],
      }, error: null };
      return { data: null, error: null };
    });
    const github = {
      getRateLimit: vi.fn(async () => ({ kind: "ok", data: {
        resources: { search: { limit: 30, remaining: 29, reset: 1, used: 1 } },
        rate: { limit: 5000, remaining: 4900, reset: 1, used: 100 },
      } })),
      searchRepositories: vi.fn(async () => ({ data: {
        items: Array.from({ length: SEARCH_PAGE_SIZE }, (_, index) => ({ id: index + 1, isPrivate: false })),
        totalCount: SEARCH_PAGE_SIZE, incompleteResults: false,
      }, provenance: {} })),
    } as never;
    const stdout: string[] = [];
    const supabase = {
      rpc,
      from: () => ({ select: () => ({
        eq: () => ({ eq: () => Promise.resolve({ data: [{ status: "pending" }], error: null }) }),
      }) }),
      storage: { listBuckets: vi.fn() },
    } as never;
    try {
      const status = await runPipelineCli([
        "--execute", "--max-queries", "1", "--max-pages", "1", "--max-candidates", "10",
      ], { supabase, github, githubSource: "fixture", writeStdout: (text) => stdout.push(text) });
      const report = JSON.parse(stdout.join("")) as Record<string, unknown>;
      const stages = report.stages as Array<Record<string, unknown>>;
      expect(status).toBe(1);
      expect(report).toMatchObject({ run_status: "partial", execution_status: "partial", data_status: "empty" });
      expect(stages).toEqual(expect.arrayContaining([
        expect.objectContaining({ stage: "discovery", status: "partial", persisted_record_count: 0 }),
        expect.objectContaining({ stage: "enrichment", status: "skipped" }),
        expect.objectContaining({ stage: "assessment", status: "skipped" }),
        expect.objectContaining({ stage: "logo_candidates", status: "skipped" }),
      ]));
      expect(report.warnings).toContainEqual(expect.objectContaining({ code: "discovery_candidate_budget_limited" }));
      expect(rpc.mock.calls.some(([name]) => ["start_github_enrichment_job", "start_repository_assessment_job"].includes(name))).toBe(false);
      expect(rpc.mock.calls.some(([name]) => name === "commit_discovery_page")).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("requires one complete joined lineage with repository, candidate, assessment, project, and logo IDs", () => {
    const report = summarizePersistedSmoke({
      pipeline_run_id: "run-valid",
      discovered_candidates: [{ id: "candidate-1", source_observation_valid: true }],
      enriched_repositories: [{ id: "repo-1", public_eligible: true, enrichment_succeeded: true }],
      assessments: [{ id: "assessment-1", assessment_complete: true, provenance_valid: true, review_relationship_valid: true }],
      project_drafts: [{ id: "project-1", draft_valid: true, category_evidence_count: 1 }],
      logo_candidates: [{ id: "logo-1", logo_candidate_valid: true, review_relationship_valid: true }],
      validated_lineages: [{
        candidate_id: "candidate-1", repository_id: "repo-1", assessment_id: "assessment-1",
        project_id: "project-1", logo_id: "logo-1", complete: true, eligible_for_run_success: true,
        evidence: {
          candidate_provenance_valid: true, candidate_state_valid: true,
          candidate_repository_identity_valid: true, public_repository_eligible: true, enrichment_succeeded: true,
          assessment_source_provenance_valid: true, assessment_review_relationship_valid: true,
          draft_primary_repository_valid: true, draft_category_evidence_valid: true,
          pending_logo_review_relationship_valid: true, no_automatic_approval_or_publication: true,
        },
      }],
    });
    expect(report).toMatchObject({
      success: true, publication_or_approval_performed: false, validated_lineage_count: 1,
      matching_lineage: { candidate_id: "candidate-1", repository_id: "repo-1", assessment_id: "assessment-1", project_id: "project-1", logo_id: "logo-1" },
    });
  });

  it("rejects five valid but unrelated stage records when no joined lineage is returned", () => {
    const report = summarizePersistedSmoke({
      pipeline_run_id: "run-unrelated",
      discovered_candidates: [{ id: "candidate-a", source_observation_valid: true }],
      enriched_repositories: [{ id: "repo-b", public_eligible: true, enrichment_succeeded: true }],
      assessments: [{ id: "assessment-c", assessment_complete: true, provenance_valid: true, review_relationship_valid: true }],
      project_drafts: [{ id: "project-d", draft_valid: true, category_evidence_count: 1 }],
      logo_candidates: [{ id: "logo-e", logo_candidate_valid: true, review_relationship_valid: true }],
      validated_lineages: [],
    });
    expect(report).toMatchObject({ success: false, validated_lineage_count: 0 });
  });

  it("does not validate a draft without category evidence or a pending logo review", () => {
    const base = {
      candidate_id: "candidate-1", repository_id: "repo-1", assessment_id: "assessment-1",
      project_id: "project-1", logo_id: "logo-1", complete: false,
      evidence: {
        candidate_provenance_valid: true, candidate_state_valid: true,
        candidate_repository_identity_valid: true, public_repository_eligible: true, enrichment_succeeded: true,
        assessment_source_provenance_valid: true, assessment_review_relationship_valid: true,
        draft_primary_repository_valid: true, draft_category_evidence_valid: false,
        pending_logo_review_relationship_valid: false, no_automatic_approval_or_publication: true,
      },
    };
    expect(summarizePersistedSmoke({ validated_lineages: [base] })).toMatchObject({ success: false, validated_lineage_count: 0 });
  });
});
