import { describe, expect, it, vi } from "vitest";
import { GitHubApiError } from "../github/errors";
import { parseEnrichmentArguments, runEnrichmentCli, type EnrichmentCliDependencies } from "../../../scripts/enrich";

describe("enrichment CLI", () => {
  it("defaults to a dry run and validates bounded execution arguments", () => {
    expect(parseEnrichmentArguments([])).toEqual({
      mode: "dry-run",
      resume: false,
      maxCandidates: 5,
      maxReleases: 20,
      recoveryCandidateIds: [],
      help: false,
    });
    expect(parseEnrichmentArguments(["--execute", "--resume", "--max-candidates", "5", "--max-releases", "20"]))
      .toMatchObject({ mode: "execute", resume: true, maxCandidates: 5, maxReleases: 20 });
    expect(() => parseEnrichmentArguments(["--execute", "--dry-run"])).toThrow(/either/);
    expect(() => parseEnrichmentArguments(["--resume"])).toThrow(/requires --execute/);
    expect(() => parseEnrichmentArguments(["--max-candidates", "0"])).toThrow(/integer from/);
    expect(() => parseEnrichmentArguments(["--max-candidates", "1e2"])).toThrow(/decimal number/);
    expect(() => parseEnrichmentArguments(["--max-releases", "101"])).toThrow(/integer from/);
    expect(() => parseEnrichmentArguments(["--max-pages", "999"])).toThrow(/Unknown/);
    expect(parseEnrichmentArguments(["--execute", "--recover-candidate-id", "00000000-0000-4000-8000-000000000101"]))
      .toMatchObject({ mode: "execute", maxCandidates: 1, maxReleases: 5, recoveryCandidateIds: ["00000000-0000-4000-8000-000000000101"] });
    expect(() => parseEnrichmentArguments(["--recover-candidate-id", "00000000-0000-4000-8000-000000000101"]))
      .toThrow(/requires --execute/);
    expect(() => parseEnrichmentArguments(["--execute", "--recover-candidate-id", "00000000-0000-4000-8000-000000000101", "--recover-candidate-id", "00000000-0000-4000-8000-000000000101"]))
      .toThrow(/unique/);
  });

  it("prints a safe dry-run plan without touching the database or GitHub", async () => {
    const rpc = vi.fn();
    const getRepositoryById = vi.fn();
    const stdout: string[] = [];
    const status = await runEnrichmentCli([], {
      supabase: { rpc } as unknown as NonNullable<EnrichmentCliDependencies["supabase"]>,
      github: { getRepositoryById } as unknown as NonNullable<EnrichmentCliDependencies["github"]>,
      writeStdout: (text) => stdout.push(text),
      writeStderr: () => undefined,
    });
    expect(status).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
    expect(getRepositoryById).not.toHaveBeenCalled();
    expect(stdout.join("")).toContain('"mode": "dry-run"');
    expect(stdout.join("")).toContain('"concurrency": 1');
  });

  it("persists a safe terminal source failure and returns nonzero", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let claimed = false;
    const rpc = vi.fn(async (name: string) => {
      if (name === "start_github_enrichment_job") return { data: "job-fixture", error: null };
      if (name === "claim_github_enrichment_candidates" && !claimed) {
        claimed = true;
        return {
          data: [{
            candidate_id: "00000000-0000-4000-8000-000000000101",
            provider_repository_id: "912345",
            full_name: "acme/widget",
            owner_login: "acme",
            enrichment_attempts: 1,
            enrichment_max_attempts: 5,
            lease_token: "00000000-0000-4000-8000-000000000102",
            lease_expires_at: "2026-11-05T12:15:00.000Z",
          }],
          error: null,
        };
      }
      if (name === "claim_github_enrichment_candidates") return { data: [], error: null };
      if (name === "fail_github_repository_enrichment") return { data: { status: "failed" }, error: null };
      return { data: null, error: null };
    });
    const github = {
      getRepositoryById: vi.fn(async () => {
        throw new GitHubApiError("not_found", "GitHub returned 404. Deletion is not established.", { status: 404 });
      }),
    } as unknown as NonNullable<EnrichmentCliDependencies["github"]>;
    const status = await runEnrichmentCli(["--execute", "--max-candidates", "1"], {
      supabase: { rpc } as unknown as NonNullable<EnrichmentCliDependencies["supabase"]>,
      github,
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text),
    });
    expect(status).toBe(1);
    expect(github.getRepositoryById).toHaveBeenCalledWith(912345, expect.any(Object));
    expect(rpc).toHaveBeenCalledWith("fail_github_repository_enrichment", expect.objectContaining({
      p_error_summary: "not_found HTTP 404",
      p_retryable: false,
      p_failure_provenance: expect.objectContaining({ http_status: 404, error_kind: "not_found" }),
    }));
    expect(stderr.join("")).toContain('"event":"candidate_failed"');
    expect(stderr.join("")).not.toContain("Deletion is not established");
    expect(stdout.join("")).toContain('"event":"enrichment_summary"');
    expect(rpc).toHaveBeenCalledWith("finish_github_enrichment_job", expect.objectContaining({ p_status: "partial" }));
  });

  it("uses the explicit recovery RPCs only for the supplied candidate allowlist", async () => {
    const candidateId = "00000000-0000-4000-8000-000000000101";
    const stdout: string[] = [];
    let claimed = false;
    const rpc = vi.fn(async (name: string) => {
      if (name === "begin_github_enrichment_recovery") return { data: { job_id: "recovery-job", terminal_failures: 0 }, error: null };
      if (name === "claim_github_enrichment_candidates_for_recovery" && !claimed) {
        claimed = true;
        return { data: [{
          candidate_id: candidateId, provider_repository_id: "912345", full_name: "acme/widget", owner_login: "acme",
          enrichment_attempts: 1, enrichment_max_attempts: 1, lease_token: "00000000-0000-4000-8000-000000000102",
          lease_expires_at: "2026-11-05T12:15:00.000Z",
        }], error: null };
      }
      if (name === "claim_github_enrichment_candidates_for_recovery") return { data: [], error: null };
      if (name === "fail_github_repository_enrichment") return { data: { status: "failed" }, error: null };
      return { data: null, error: null };
    });
    const github = { getRepositoryById: vi.fn(async () => {
      throw new GitHubApiError("not_found", "GitHub returned 404.", { status: 404 });
    }) } as unknown as NonNullable<EnrichmentCliDependencies["github"]>;
    const status = await runEnrichmentCli(["--execute", "--recover-candidate-id", candidateId], {
      supabase: { rpc } as unknown as NonNullable<EnrichmentCliDependencies["supabase"]>,
      github, writeStdout: (text) => stdout.push(text), writeStderr: () => undefined,
    });
    expect(status).toBe(1);
    expect(rpc).toHaveBeenCalledWith("begin_github_enrichment_recovery", expect.objectContaining({
      p_candidate_ids: [candidateId], p_max_releases: 5,
    }));
    expect(rpc).toHaveBeenCalledWith("claim_github_enrichment_candidates_for_recovery", expect.objectContaining({ p_job_id: "recovery-job" }));
    expect(rpc).not.toHaveBeenCalledWith("start_github_enrichment_job", expect.anything());
    expect(rpc).not.toHaveBeenCalledWith("claim_github_enrichment_candidates", expect.anything());
  });
});
