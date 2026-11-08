import { describe, expect, it } from "vitest";
import { parsePipelineArguments, summarizePersistedSmoke } from "../../scripts/pipeline";

describe("unified pipeline CLI arguments", () => {
  it("defaults to bounded dry-run budgets", () => {
    expect(parsePipelineArguments([])).toMatchObject({
      mode: "dry-run",
      resume: false,
      liveSmoke: false,
      maxQueries: 1,
      maxPages: 1,
      maxCandidates: 10,
      maxEnrichments: 5,
      maxAssessments: 5,
      maxLogoProjects: 5,
    });
  });

  it("accepts the documented bounded execute and resume commands", () => {
    expect(parsePipelineArguments(["--execute", "--max-queries", "1", "--max-pages", "1", "--max-candidates", "10"]))
      .toMatchObject({ mode: "execute", maxQueries: 1, maxPages: 1, maxCandidates: 10 });
    expect(parsePipelineArguments(["--resume", "--execute", "--max-candidates", "10"]))
      .toMatchObject({ mode: "execute", resume: true, maxCandidates: 10 });
  });

  it("requires explicit execute for resume and live smoke", () => {
    expect(() => parsePipelineArguments(["--resume"])).toThrow(/requires --execute/);
    expect(() => parsePipelineArguments(["--live-smoke"])).toThrow(/requires --execute/);
    expect(parsePipelineArguments(["--live-smoke", "--execute"]).liveSmoke).toBe(true);
  });

  it("rejects smoke budgets above their ceilings", () => {
    expect(() => parsePipelineArguments(["--live-smoke", "--execute", "--max-pages", "2"]))
      .toThrow(/cannot exceed/);
    expect(() => parsePipelineArguments(["--live-smoke", "--execute", "--max-candidates", "11"]))
      .toThrow(/cannot exceed/);
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
    expect(summarizePersistedSmoke({ pipeline_run_id: "run-empty" })).toMatchObject({
      inspected: true,
      success: false,
      records: { discovered_candidates: 0, enriched_repositories: 0, assessments: 0, project_drafts: 0, logo_candidates: 0 },
      validated_lineage_count: 0,
    });
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
