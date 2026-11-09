import { describe, expect, it, vi } from "vitest";
import {
  buildLaunchPreflightReport,
  classifyLaunchTarget,
  runLaunchPreflightCli,
  type LaunchPreflightAdapters,
} from "../../scripts/launch-preflight";

const expectedMigrations = ["20261108120000", "20261108130000", "20261108140000"];
const expectedCategories = [
  "developer-tools", "ai-machine-learning", "productivity", "design", "analytics",
  "infrastructure", "data-databases", "communication", "self-hosted",
  "security-privacy", "automation-workflows",
];
const productionProjectRef = "hvunezhzpnpdkfiqgaaa";

function localEnvironment(overrides: Record<string, string | undefined> = {}) {
  return {
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "local-publishable-key",
    SUPABASE_SECRET_KEY: "local-secret-key",
    OUTLIST_SUPABASE_ENVIRONMENT: "local",
    ...overrides,
  };
}

function productionEnvironment(overrides: Record<string, string | undefined> = {}) {
  return {
    NEXT_PUBLIC_SUPABASE_URL: `https://${productionProjectRef}.supabase.co`,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "production-publishable-key",
    SUPABASE_SECRET_KEY: "production-secret-key",
    OUTLIST_SUPABASE_ENVIRONMENT: "production",
    GITHUB_TOKEN: "production-github-token",
    ...overrides,
  };
}

function readyAdapters(overrides: Partial<LaunchPreflightAdapters> = {}): LaunchPreflightAdapters {
  const operatorReport = {
    report_version: "m1-10-v3",
    schema: { migration_table_available: true, applied_migrations: expectedMigrations, ready: true },
    categories: { active_count: 11, missing_slugs: [], ready: true },
    storage_bucket: { exists: true, public: true, file_size_limit: 2_097_152, mime_types: ["image/png", "image/jpeg", "image/webp"] },
    inventory: { published_projects: 2, pending_review_project_drafts: 1 },
    running_jobs: [], active_leases: { discovery: 0, enrichment: 0, assessment: 0, logo_approval: 0 },
    integrity_findings: [],
  };
  return {
    readOperatorReport: vi.fn(async () => ({ data: operatorReport })),
    countAllowlistedAdmins: vi.fn(async () => ({ count: 1 })),
    countUnpublishedProjects: vi.fn(async () => ({ count: 4 })),
    countAnonymousProjects: vi.fn(async () => ({ count: 2 })),
    readAnonymousCategories: vi.fn(async () => ({ data: expectedCategories.map((slug) => ({ slug })) })),
    searchAnonymousCatalog: vi.fn(async () => ({ data: { items: [], page: 1, pageSize: 1, sort: "newest", totalCount: 2, hasMore: true } })),
    readAuthSettings: vi.fn(async () => ({ data: { disable_signup: true, external: { email: true } } })),
    readGitHubRateLimit: vi.fn(async () => ({ data: { resources: {
      core: { limit: 5000, remaining: 4900, reset: 1_800_000_000 },
      search: { limit: 30, remaining: 25, reset: 1_800_000_000 },
    } } })),
    ...overrides,
  };
}

describe("launch preflight", () => {
  it("classifies local, staging, production, and unclassified remote targets", () => {
    expect(classifyLaunchTarget("http://127.0.0.1:54321", "local")).toMatchObject({ kind: "local", environment: "local", projectRef: null });
    expect(classifyLaunchTarget("https://stage-ref.supabase.co", "staging")).toMatchObject({ kind: "hosted", environment: "staging", projectRef: "stage-ref" });
    expect(classifyLaunchTarget("https://prod-ref.supabase.co", "production")).toMatchObject({ kind: "hosted", environment: "production", projectRef: "prod-ref" });
    expect(classifyLaunchTarget("https://db.example.test", "production")).toMatchObject({ kind: "unclassified_remote", environment: "production", projectRef: null });
  });

  it("fails with actionable missing environment names without contacting configured services", async () => {
    const adapters = readyAdapters();
    const report = await buildLaunchPreflightReport({ help: false }, {}, adapters, { expectedMigrations });
    expect(report.exit_code).toBe(1);
    expect(report.blockers.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "missing_next_public_supabase_url", "missing_next_public_supabase_publishable_key",
      "missing_supabase_secret_key", "environment_label_missing",
    ]));
    expect(adapters.readOperatorReport).not.toHaveBeenCalled();
  });

  it("rejects an incorrect hosted project confirmation", async () => {
    const adapters = readyAdapters();
    const report = await buildLaunchPreflightReport(
      { help: false, confirmProjectRef: "other-ref" },
      {
        NEXT_PUBLIC_SUPABASE_URL: "https://prod-ref.supabase.co",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "public-key",
        SUPABASE_SECRET_KEY: "server-key",
        OUTLIST_SUPABASE_ENVIRONMENT: "production",
      }, adapters, { expectedMigrations },
    );
    expect(report.target.project_ref).toBe("prod-ref");
    expect(report.target.confirmation).toBe("mismatch");
    expect(report.blockers.map(({ code }) => code)).toContain("project_ref_confirmation_mismatch");
    expect(adapters.readOperatorReport).not.toHaveBeenCalled();
  });

  it("reports missing migration versions", async () => {
    const adapters = readyAdapters({ readOperatorReport: vi.fn(async () => ({ data: {
      schema: { migration_table_available: true, applied_migrations: expectedMigrations.slice(0, 2), ready: false },
      categories: { active_count: 11, missing_slugs: [], ready: true },
      storage_bucket: { exists: true, public: true, file_size_limit: 2_097_152, mime_types: ["image/png", "image/jpeg", "image/webp"] },
      inventory: { published_projects: 2, pending_review_project_drafts: 1 },
      running_jobs: [], active_leases: { discovery: 0 }, integrity_findings: [],
    } })) });
    const report = await buildLaunchPreflightReport({ help: false, purpose: "ingestion", confirmProjectRef: productionProjectRef }, productionEnvironment(), adapters, { expectedMigrations });
    expect(report.migrations).toMatchObject({ status: "incomplete", missing: ["20261108140000"] });
    expect(report.blockers.map(({ code }) => code)).toContain("migrations_missing");
    expect(report.ingestion_ready).toBe(false);
  });

  it("blocks a missing or incorrectly configured public logo bucket", async () => {
    const adapters = readyAdapters({ readOperatorReport: vi.fn(async () => ({ data: {
      schema: { migration_table_available: true, applied_migrations: expectedMigrations, ready: true },
      categories: { active_count: 11, missing_slugs: [], ready: true },
      storage_bucket: { exists: false }, inventory: { published_projects: 2, pending_review_project_drafts: 1 },
      running_jobs: [], active_leases: { discovery: 0 }, integrity_findings: [],
    } })) });
    const report = await buildLaunchPreflightReport({ help: false, purpose: "ingestion", confirmProjectRef: productionProjectRef }, productionEnvironment(), adapters, { expectedMigrations });
    expect(report.storage.status).toBe("incomplete");
    expect(report.blockers.map(({ code }) => code)).toContain("logo_storage_not_ready");
    expect(report.ingestion_ready).toBe(false);
  });

  it("blocks a missing category taxonomy", async () => {
    const adapters = readyAdapters({ readOperatorReport: vi.fn(async () => ({ data: {
      schema: { migration_table_available: true, applied_migrations: expectedMigrations, ready: true },
      categories: { active_count: 10, missing_slugs: ["analytics"], ready: false },
      storage_bucket: { exists: true, public: true, file_size_limit: 2_097_152, mime_types: ["image/png", "image/jpeg", "image/webp"] },
      inventory: { published_projects: 2, pending_review_project_drafts: 1 },
      running_jobs: [], active_leases: { discovery: 0 }, integrity_findings: [],
    } })) });
    const report = await buildLaunchPreflightReport({ help: false, purpose: "ingestion", confirmProjectRef: productionProjectRef }, productionEnvironment(), adapters, { expectedMigrations });
    expect(report.categories).toMatchObject({ status: "incomplete", missing: ["analytics"] });
    expect(report.blockers.map(({ code }) => code)).toContain("category_taxonomy_incomplete");
    expect(report.ingestion_ready).toBe(false);
  });

  it("checks anonymous RLS reads against public search totals", async () => {
    const adapters = readyAdapters({ countAnonymousProjects: vi.fn(async () => ({ count: 1 })) });
    const report = await buildLaunchPreflightReport({ help: false }, localEnvironment(), adapters, { expectedMigrations });
    expect(report.public_catalog).toMatchObject({ status: "incomplete", search_ready: true, rls_read_ready: false });
    expect(report.blockers.map(({ code }) => code)).toContain("public_rls_read_unavailable");
  });

  it("blocks critical integrity findings while retaining safe summaries", async () => {
    const adapters = readyAdapters({ readOperatorReport: vi.fn(async () => ({ data: {
      schema: { migration_table_available: true, applied_migrations: expectedMigrations, ready: true },
      categories: { active_count: 11, missing_slugs: [], ready: true },
      storage_bucket: { exists: true, public: true, file_size_limit: 2_097_152, mime_types: ["image/png", "image/jpeg", "image/webp"] },
      inventory: { published_projects: 2, pending_review_project_drafts: 1 },
      running_jobs: [], active_leases: { discovery: 0 },
      integrity_findings: [{ code: "restricted_repository_assessed", severity: "critical", affected_count: 1, affected_record_ids: ["private-record-id"] }],
    } })) });
    const report = await buildLaunchPreflightReport({ help: false, purpose: "ingestion", confirmProjectRef: productionProjectRef }, productionEnvironment(), adapters, { expectedMigrations });
    expect(report.integrity.findings).toEqual([{ code: "restricted_repository_assessed", severity: "critical", affected_count: 1 }]);
    expect(report.blockers.map(({ code }) => code)).toContain("integrity_restricted_repository_assessed");
    expect(report.ingestion_ready).toBe(false);
    expect(JSON.stringify(report)).not.toContain("private-record-id");
  });

  it("remains read-only and never invokes ingestion", async () => {
    const adapters = readyAdapters();
    const report = await buildLaunchPreflightReport({ help: false, purpose: "ingestion", confirmProjectRef: productionProjectRef }, productionEnvironment({ GITHUB_TOKEN: "github-token-canary" }), adapters, { expectedMigrations });
    expect(report.read_only).toBe(true);
    expect(report.mutations_performed).toBe(false);
    expect(report.ingestion_started).toBe(false);
    expect(report.ingestion_ready).toBe(true);
    expect(adapters.readOperatorReport).toHaveBeenCalledTimes(1);
    expect(adapters.searchAnonymousCatalog).toHaveBeenCalledTimes(1);
    expect(adapters.readGitHubRateLimit).toHaveBeenCalledTimes(1);
  });

  it("reports ingestion ready without a website origin while launch remains blocked", async () => {
    const adapters = readyAdapters();
    const report = await buildLaunchPreflightReport(
      { help: false, purpose: "ingestion", confirmProjectRef: productionProjectRef },
      productionEnvironment(), adapters, { expectedMigrations },
    );

    expect(report.purpose).toBe("ingestion");
    expect(report.environment.OUTLIST_PUBLIC_ORIGIN).toMatchObject({ configured: false, required: false });
    expect(report.ingestion_ready).toBe(true);
    expect(report.launch_ready).toBe(false);
    expect(report.ingestion_blockers).toEqual([]);
    expect(report.launch_only_blockers.map(({ code }) => code)).toContain("hosted_manual_checks_incomplete");
    expect(report.hosted_verification).toBe("partial");
    expect(report.exit_code).toBe(0);
  });

  it("accepts the ingestion CLI purpose and returns success without an origin", async () => {
    let stdout = "";
    const exitCode = await runLaunchPreflightCli(
      ["--purpose", "ingestion", "--confirm-project-ref", productionProjectRef],
      {
        environment: productionEnvironment(),
        adapters: readyAdapters(),
        expectedMigrations,
        writeStdout: (line) => { stdout += line; },
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      purpose: "ingestion",
      ingestion_ready: true,
      launch_ready: false,
      hosted_verification: "partial",
      read_only: true,
      mutations_performed: false,
      ingestion_started: false,
    });
  });

  it("keeps the default launch purpose blocked without the deployed HTTPS origin", async () => {
    const report = await buildLaunchPreflightReport(
      { help: false, confirmProjectRef: productionProjectRef },
      productionEnvironment(), readyAdapters(), { expectedMigrations },
    );

    expect(report.purpose).toBe("launch");
    expect(report.ingestion_ready).toBe(true);
    expect(report.launch_ready).toBe(false);
    expect(report.blockers.map(({ code }) => code)).toContain("hosted_manual_checks_incomplete");
    expect(report.hosted_verification).toBe("partial");
    expect(report.exit_code).toBe(1);
  });

  it("rejects ingestion checks for a different production project reference", async () => {
    const adapters = readyAdapters();
    const wrongRef = "other-production-project";
    const report = await buildLaunchPreflightReport(
      { help: false, purpose: "ingestion", confirmProjectRef: wrongRef },
      productionEnvironment({ NEXT_PUBLIC_SUPABASE_URL: `https://${wrongRef}.supabase.co` }),
      adapters, { expectedMigrations },
    );

    expect(report.target.confirmation).toBe("matched");
    expect(report.ingestion_ready).toBe(false);
    expect(report.ingestion_blockers.map(({ code }) => code)).toContain("production_project_ref_mismatch");
    expect(adapters.readOperatorReport).not.toHaveBeenCalled();
  });

  it("blocks ingestion when GitHub authentication fails or the bounded budget is too low", async () => {
    const failedApi = await buildLaunchPreflightReport(
      { help: false, purpose: "ingestion", confirmProjectRef: productionProjectRef },
      productionEnvironment(),
      readyAdapters({ readGitHubRateLimit: vi.fn(async () => ({ error: new Error("token must stay private") })) }),
      { expectedMigrations },
    );
    const lowBudget = await buildLaunchPreflightReport(
      { help: false, purpose: "ingestion", confirmProjectRef: productionProjectRef },
      productionEnvironment(),
      readyAdapters({ readGitHubRateLimit: vi.fn(async () => ({ data: { resources: {
        core: { limit: 5000, remaining: 30, reset: 1_800_000_000 },
        search: { limit: 30, remaining: 1, reset: 1_800_000_000 },
      } } })) }),
      { expectedMigrations },
    );

    expect(failedApi.ingestion_ready).toBe(false);
    expect(failedApi.ingestion_blockers.map(({ code }) => code)).toContain("github_rate_limit_unavailable");
    expect(lowBudget.ingestion_ready).toBe(false);
    expect(lowBudget.ingestion_blockers.map(({ code }) => code)).toContain("github_rate_limit_budget_insufficient");
  });

  it("blocks ingestion on active leases and unavailable or unauthorized administrator settings", async () => {
    const activeLease = await buildLaunchPreflightReport(
      { help: false, purpose: "ingestion", confirmProjectRef: productionProjectRef },
      productionEnvironment(),
      readyAdapters({ readOperatorReport: vi.fn(async () => ({ data: {
        report_version: "m1-10-v3",
        schema: { migration_table_available: true, applied_migrations: expectedMigrations, ready: true },
        categories: { active_count: 11, missing_slugs: [], ready: true },
        storage_bucket: { exists: true, public: true, file_size_limit: 2_097_152, mime_types: ["image/png", "image/jpeg", "image/webp"] },
        inventory: { published_projects: 2, pending_review_project_drafts: 1 },
        running_jobs: [], active_leases: { discovery: 1 }, integrity_findings: [],
      } })) }),
      { expectedMigrations },
    );
    const unavailableAdmin = await buildLaunchPreflightReport(
      { help: false, purpose: "ingestion", confirmProjectRef: productionProjectRef },
      productionEnvironment(),
      readyAdapters({ readAuthSettings: vi.fn(async () => ({ error: true })) }),
      { expectedMigrations },
    );
    const unauthorizedAdmin = await buildLaunchPreflightReport(
      { help: false, purpose: "ingestion", confirmProjectRef: productionProjectRef },
      productionEnvironment(),
      readyAdapters({ countAllowlistedAdmins: vi.fn(async () => ({ count: 0 })) }),
      { expectedMigrations },
    );

    expect(activeLease.ingestion_blockers.map(({ code }) => code)).toContain("pipeline_already_active");
    expect(unavailableAdmin.ingestion_blockers.map(({ code }) => code)).toContain("auth_settings_unavailable");
    expect(unauthorizedAdmin.ingestion_blockers.map(({ code }) => code)).toContain("admin_allowlist_empty");
  });

  it("rejects write flags and does not contact Supabase or GitHub", async () => {
    const adapters = readyAdapters();
    let stderr = "";
    const exitCode = await runLaunchPreflightCli(["--execute"], {
      environment: localEnvironment(), adapters, expectedMigrations,
      writeStderr: (message) => { stderr += message; },
    });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("Invalid launch preflight arguments");
    expect(adapters.readOperatorReport).not.toHaveBeenCalled();
    expect(adapters.readGitHubRateLimit).not.toHaveBeenCalled();
  });

  it("returns structured output when configured client values cannot initialize", async () => {
    let stdout = "";
    const exitCode = await runLaunchPreflightCli([], {
      environment: localEnvironment({ NEXT_PUBLIC_SUPABASE_URL: "not-a-url" }),
      expectedMigrations,
      writeStdout: (message) => { stdout += message; },
      writeStderr: () => { throw new Error("Expected a JSON report on stdout."); },
    });
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({
      read_only: true,
      ingestion_started: false,
      exit_code: 1,
      blockers: expect.arrayContaining([expect.objectContaining({ code: "preflight_adapter_configuration_invalid" })]),
    });
  });

  it("redacts public keys, service keys, and GitHub tokens from every report path", async () => {
    const canaries = ["publishable-secret-canary", "service-secret-canary", "github-secret-canary"];
    const reportText: string[] = [];
    const adapters = readyAdapters({
      readOperatorReport: vi.fn(async () => ({ error: new Error(canaries[1]) })),
      readAuthSettings: vi.fn(async () => ({ error: new Error(canaries[0]) })),
      readGitHubRateLimit: vi.fn(async () => ({ error: new Error(canaries[2]) })),
    });
    await buildLaunchPreflightReport({ help: false }, localEnvironment({
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: canaries[0], SUPABASE_SECRET_KEY: canaries[1], GITHUB_TOKEN: canaries[2],
    }), adapters, { expectedMigrations });
    reportText.push(JSON.stringify(await buildLaunchPreflightReport({ help: false }, localEnvironment({
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: canaries[0], SUPABASE_SECRET_KEY: canaries[1], GITHUB_TOKEN: canaries[2],
    }), adapters, { expectedMigrations })));
    for (const canary of canaries) expect(reportText.join("\n")).not.toContain(canary);
  });

  it("passes a correctly initialized read-only local Supabase preflight", async () => {
    const adapters = readyAdapters();
    const report = await buildLaunchPreflightReport({ help: false }, localEnvironment(), adapters, { expectedMigrations });
    expect(report.exit_code).toBe(0);
    expect(report.launch_ready).toBe(true);
    expect(report.migrations.status).toBe("verified");
    expect(report.categories.status).toBe("ready");
    expect(report.storage.status).toBe("ready");
    expect(report.public_catalog).toMatchObject({ status: "ready", public_item_count: 2 });
    expect(report.admin_authorization).toMatchObject({
      status: "ready",
      allowlisted_admin_count: 1,
      signups_disabled: true,
      email_password_enabled: true,
    });
    expect(report.unpublished_projects).toBe(4);
    expect(report.pending_review_projects).toBe(1);
    expect(report.hosted_verification).toBe("not_performed");
  });

  it("blocks password sign-in launch when public signup is enabled or the email provider is disabled", async () => {
    const signupEnabled = await buildLaunchPreflightReport(
      { help: false },
      localEnvironment(),
      readyAdapters({
        readAuthSettings: vi.fn(async () => ({
          data: { disable_signup: false, external: { email: true } },
        })),
      }),
      { expectedMigrations },
    );
    const emailProviderDisabled = await buildLaunchPreflightReport(
      { help: false },
      localEnvironment(),
      readyAdapters({
        readAuthSettings: vi.fn(async () => ({
          data: { disable_signup: true, external: { email: false } },
        })),
      }),
      { expectedMigrations },
    );

    expect(signupEnabled.blockers.map(({ code }) => code)).toContain("auth_signup_enabled");
    expect(emailProviderDisabled.blockers.map(({ code }) => code)).toContain("auth_email_password_disabled");
  });
});
