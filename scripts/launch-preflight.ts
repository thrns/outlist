import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "../src/lib/supabase/admin";
import type { Database } from "../src/lib/supabase/database.types";
import { GitHubClient } from "../src/lib/github/client";

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));
const PRODUCTION_PROJECT_REF = "hvunezhzpnpdkfiqgaaa";
const INGESTION_GITHUB_BUDGET = { core: 31, search: 1 } as const;
const EXPECTED_CATEGORIES = [
  "developer-tools", "ai-machine-learning", "productivity", "design", "analytics",
  "infrastructure", "data-databases", "communication", "self-hosted",
  "security-privacy", "automation-workflows",
];
const REQUIRED_ENVIRONMENT_VARIABLES = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "OUTLIST_SUPABASE_ENVIRONMENT",
] as const;

type Environment = Record<string, string | undefined>;
type ReadResult = { data?: unknown; count?: number | null; error?: unknown };
type RateLimitData = {
  resources?: Record<string, { limit: number; remaining: number; reset: number }>;
  rate?: { limit: number; remaining: number; reset: number };
};

export type LaunchPreflightAdapters = {
  readOperatorReport(): Promise<ReadResult>;
  countAllowlistedAdmins(): Promise<ReadResult>;
  countUnpublishedProjects(): Promise<ReadResult>;
  countAnonymousProjects(): Promise<ReadResult>;
  readAnonymousCategories(): Promise<ReadResult>;
  searchAnonymousCatalog(): Promise<ReadResult>;
  readAuthSettings(): Promise<ReadResult>;
  readGitHubRateLimit(): Promise<ReadResult>;
};

export type LaunchPreflightPurpose = "launch" | "ingestion";

export type LaunchPreflightArguments = {
  purpose?: LaunchPreflightPurpose;
  confirmProjectRef?: string;
  help: boolean;
};

export type LaunchPreflightReport = {
  schema: "outlist.launch-preflight.v2";
  generated_at: string;
  purpose: LaunchPreflightPurpose;
  read_only: true;
  mutations_performed: false;
  ingestion_started: false;
  target: {
    kind: "local" | "hosted" | "unclassified_remote" | "unknown";
    host: string | null;
    project_ref: string | null;
    environment: "local" | "development" | "staging" | "production" | "unknown";
    environment_label: string | null;
    confirmation: "not_required_local" | "matched" | "not_supplied" | "mismatch" | "not_verifiable";
  };
  environment: Record<string, { configured: boolean; required: boolean }>;
  migrations: {
    status: "verified" | "incomplete" | "unavailable" | "not_checked";
    expected: string[];
    applied: string[];
    missing: string[];
  };
  categories: { status: "ready" | "incomplete" | "unavailable" | "not_checked"; active_count: number | null; missing: string[] };
  storage: { status: "ready" | "incomplete" | "unavailable" | "not_checked"; bucket: string; public: boolean | null; file_size_limit: number | null; mime_types: string[] };
  public_catalog: {
    status: "ready" | "incomplete" | "unavailable" | "not_checked";
    search_ready: boolean | null;
    rls_read_ready: boolean | null;
    public_item_count: number | null;
    active_category_count: number | null;
  };
  admin_authorization: {
    status: "ready" | "incomplete" | "unavailable" | "not_checked";
    allowlisted_admin_count: number | null;
    signups_disabled: boolean | null;
    email_password_enabled: boolean | null;
  };
  pipeline: {
    status: "ready" | "blocked" | "unavailable" | "not_checked";
    schema_ready: boolean | null;
    running_jobs: number | null;
    active_leases: number | null;
    inventory: Record<string, unknown> | null;
  };
  integrity: { status: "clean" | "findings" | "unavailable" | "not_checked"; findings: Array<{ code: string; severity: string; affected_count: number }> };
  github_rate_limit: {
    status: "checked" | "not_configured" | "unavailable" | "not_checked";
    authentication: "authenticated" | "unauthenticated" | "unknown";
    core_remaining: number | null;
    core_limit: number | null;
    core_resets_at: string | null;
    search_remaining: number | null;
    search_limit: number | null;
    search_resets_at: string | null;
  };
  unpublished_projects: number | null;
  pending_review_projects: number | null;
  manual_checks_required: string[];
  blockers: Array<{ code: string; message: string }>;
  ingestion_blockers: Array<{ code: string; message: string }>;
  launch_only_blockers: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
  ingestion_ready: boolean;
  launch_ready: boolean;
  hosted_verification: "completed" | "not_performed" | "partial";
  exit_code: 0 | 1;
};

const ENVIRONMENT_NAMES = ["local", "development", "staging", "production"] as const;
type EnvironmentName = (typeof ENVIRONMENT_NAMES)[number];

function parseArguments(args: string[]): LaunchPreflightArguments {
  let purpose: LaunchPreflightPurpose = "launch";
  let confirmProjectRef: string | undefined;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--purpose") {
      const value = args[index + 1];
      if (value !== "launch" && value !== "ingestion") {
        throw new TypeError("--purpose must be launch or ingestion.");
      }
      purpose = value;
      index += 1;
    }
    else if (arg === "--confirm-project-ref") {
      const value = args[index + 1];
      if (!value || value.startsWith("--") || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(value)) {
        throw new TypeError("--confirm-project-ref requires a Supabase project reference.");
      }
      confirmProjectRef = value;
      index += 1;
    } else {
      throw new TypeError("Unknown launch preflight option. Use --help to see supported options.");
    }
  }
  return { purpose, confirmProjectRef, help };
}

export function classifyLaunchTarget(rawUrl: string | undefined, environmentLabel: string | undefined) {
  let parsedUrl: URL | null = null;
  try {
    if (rawUrl) parsedUrl = new URL(rawUrl);
  } catch {
    // The caller reports invalid configuration; never echo the supplied URL.
  }
  const host = parsedUrl?.hostname.toLowerCase() ?? null;
  const localHost = host !== null && (host === "localhost" || host.endsWith(".localhost")
    || host === "::1" || host === "[::1]" || host.startsWith("127.") || host === "host.docker.internal");
  const projectRef = host && /^[a-z0-9-]+\.supabase\.co$/.test(host)
    ? host.slice(0, -".supabase.co".length) : null;
  const kind: LaunchPreflightReport["target"]["kind"] = !host
    ? "unknown" : localHost ? "local" : projectRef ? "hosted" : "unclassified_remote";
  const rawLabel = environmentLabel?.trim().toLowerCase() ?? "";
  const label = (ENVIRONMENT_NAMES as readonly string[]).includes(rawLabel) ? rawLabel as EnvironmentName : null;
  const environment: LaunchPreflightReport["target"]["environment"] = label
    ?? (kind === "local" ? "local" : "unknown");
  return {
    kind,
    host,
    projectRef,
    environment,
    environmentLabel: label,
    labelValid: rawLabel === "" || label !== null,
    localMismatch: kind === "local" && label !== null && label !== "local" && label !== "development",
    remoteLocalMismatch: kind !== "local" && kind !== "unknown" && label === "local",
  };
}

export async function readExpectedMigrations(directory = MIGRATIONS_DIRECTORY): Promise<string[]> {
  const files = await readdir(directory);
  return files
    .map((file) => /^([0-9]{14})_.*\.sql$/.exec(file)?.[1])
    .filter((version): version is string => Boolean(version))
    .sort();
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function safeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function checkResult(result: ReadResult | null, code: string, message: string, blockers: LaunchPreflightReport["blockers"]): boolean {
  if (!result || result.error) {
    blockers.push({ code, message });
    return false;
  }
  return true;
}

function readSafely(task: () => Promise<ReadResult>): Promise<ReadResult> {
  return task().catch(() => ({ error: true }));
}

function countActiveLeases(value: unknown): number | null {
  const record = object(value);
  if (!record) return null;
  const values = Object.values(record);
  if (values.some((item) => safeCount(item) === null)) return null;
  return values.reduce<number>((total, item) => total + (item as number), 0);
}

function countRunningJobs(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

function isoFromUnix(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000).toISOString();
}

function isHttpsOrigin(raw: string | undefined): boolean {
  try {
    const url = new URL(raw ?? "");
    return url.protocol === "https:" && url.origin === raw;
  } catch {
    return false;
  }
}

export async function buildLaunchPreflightReport(
  args: LaunchPreflightArguments,
  environment: Environment,
  adapters?: LaunchPreflightAdapters,
  options: { expectedMigrations?: string[]; generatedAt?: string } = {},
): Promise<LaunchPreflightReport> {
  const blockers: LaunchPreflightReport["blockers"] = [];
  const ingestionOnlyBlockers: LaunchPreflightReport["blockers"] = [];
  const launchOnlyBlockers: LaunchPreflightReport["blockers"] = [];
  const warnings: LaunchPreflightReport["warnings"] = [];
  const purpose = args.purpose ?? "launch";
  let verificationCompleted = false;
  const requiredEnvironment = Object.fromEntries(REQUIRED_ENVIRONMENT_VARIABLES.map((name) => [name, {
    configured: Boolean(environment[name]?.trim()), required: true,
  }]));
  requiredEnvironment.NEXT_PUBLIC_SUPABASE_URL = {
    configured: Boolean(environment.NEXT_PUBLIC_SUPABASE_URL?.trim()), required: true,
  };
  requiredEnvironment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = {
    configured: Boolean(environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim()), required: true,
  };
  requiredEnvironment.SUPABASE_SECRET_KEY = { configured: Boolean(environment.SUPABASE_SECRET_KEY?.trim()), required: true };
  requiredEnvironment.OUTLIST_SUPABASE_ENVIRONMENT = { configured: Boolean(environment.OUTLIST_SUPABASE_ENVIRONMENT?.trim()), required: true };
  requiredEnvironment.GITHUB_TOKEN = { configured: Boolean(environment.GITHUB_TOKEN?.trim()), required: purpose === "ingestion" };
  requiredEnvironment.OUTLIST_PUBLIC_ORIGIN = { configured: Boolean(environment.OUTLIST_PUBLIC_ORIGIN?.trim()), required: false };

  const targetInfo = classifyLaunchTarget(environment.NEXT_PUBLIC_SUPABASE_URL, environment.OUTLIST_SUPABASE_ENVIRONMENT);
  requiredEnvironment.OUTLIST_PUBLIC_ORIGIN = { configured: Boolean(environment.OUTLIST_PUBLIC_ORIGIN?.trim()), required: purpose === "launch" && targetInfo.kind === "hosted" };
  const target: LaunchPreflightReport["target"] = {
    kind: targetInfo.kind,
    host: targetInfo.host,
    project_ref: targetInfo.projectRef,
    environment: targetInfo.environment,
    environment_label: targetInfo.environmentLabel,
    confirmation: targetInfo.kind === "local" ? "not_required_local"
      : args.confirmProjectRef === undefined ? targetInfo.projectRef ? "not_supplied" : "not_verifiable"
        : targetInfo.projectRef === args.confirmProjectRef ? "matched" : "mismatch",
  };
  if (!targetInfo.labelValid) blockers.push({ code: "invalid_environment_label", message: "OUTLIST_SUPABASE_ENVIRONMENT must be local, development, staging, or production." });
  if (!environment.OUTLIST_SUPABASE_ENVIRONMENT?.trim()) blockers.push({ code: "environment_label_missing", message: "Set OUTLIST_SUPABASE_ENVIRONMENT to label this Supabase target before launch." });
  if (targetInfo.localMismatch || targetInfo.remoteLocalMismatch) blockers.push({ code: "target_environment_mismatch", message: "The declared Supabase environment does not match the URL-derived local or remote target." });
  if (targetInfo.kind === "unknown") blockers.push({ code: "supabase_url_missing_or_invalid", message: "Set NEXT_PUBLIC_SUPABASE_URL to a valid local or hosted Supabase API URL." });
  if (targetInfo.kind === "unclassified_remote") blockers.push({ code: "remote_project_reference_unverifiable", message: "The configured remote Supabase host does not expose a standard project reference; the launch target cannot be confirmed safely." });
  if (targetInfo.kind === "hosted" && args.confirmProjectRef && target.project_ref !== args.confirmProjectRef) blockers.push({ code: "project_ref_confirmation_mismatch", message: "The supplied project reference does not match the reference derived from NEXT_PUBLIC_SUPABASE_URL." });
  if (targetInfo.kind === "hosted" && !args.confirmProjectRef) blockers.push({ code: "hosted_project_confirmation_required", message: "Review the project reference in Supabase Dashboard, then pass it with --confirm-project-ref to verify the hosted target." });
  if (targetInfo.kind !== "hosted") ingestionOnlyBlockers.push({ code: "ingestion_requires_hosted_production", message: "Ingestion readiness is only available for the hosted production Supabase project." });
  else if (targetInfo.environment !== "production") ingestionOnlyBlockers.push({ code: "ingestion_requires_production_environment", message: "Set OUTLIST_SUPABASE_ENVIRONMENT=production before checking production ingestion readiness." });
  if (targetInfo.kind === "hosted" && targetInfo.projectRef !== PRODUCTION_PROJECT_REF) ingestionOnlyBlockers.push({ code: "production_project_ref_mismatch", message: "The configured Supabase URL does not point to the approved production project reference." });
  if (!environment.GITHUB_TOKEN?.trim()) ingestionOnlyBlockers.push({ code: "github_token_required_for_ingestion", message: "Configure a server-only GITHUB_TOKEN so the bounded production pilot uses authenticated GitHub API access." });

  let urlValid = false;
  try {
    const url = new URL(environment.NEXT_PUBLIC_SUPABASE_URL ?? "");
    urlValid = (url.protocol === "https:" || (targetInfo.kind === "local" && url.protocol === "http:"))
      && !url.username && !url.password;
  } catch {
    urlValid = false;
  }
  if (!urlValid && environment.NEXT_PUBLIC_SUPABASE_URL?.trim()) blockers.push({ code: "supabase_url_invalid", message: "NEXT_PUBLIC_SUPABASE_URL must be HTTPS for hosted targets, HTTP only for local development, and must not include embedded credentials." });
  for (const name of REQUIRED_ENVIRONMENT_VARIABLES) {
    if (!environment[name]?.trim()) blockers.push({ code: `missing_${name.toLowerCase()}`, message: `Set the required ${name} variable in the operator or deployment environment.` });
  }

  const configuredPublic = Boolean(environment.NEXT_PUBLIC_SUPABASE_URL?.trim() && environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() && urlValid);
  const configuredAdmin = Boolean(environment.NEXT_PUBLIC_SUPABASE_URL?.trim() && environment.SUPABASE_SECRET_KEY?.trim() && urlValid);
  const expectedMigrations = options.expectedMigrations ?? await readExpectedMigrations();
  const report: LaunchPreflightReport = {
    schema: "outlist.launch-preflight.v2",
    generated_at: options.generatedAt ?? new Date().toISOString(),
    purpose,
    read_only: true,
    mutations_performed: false,
    ingestion_started: false,
    target,
    environment: requiredEnvironment,
    migrations: { status: "not_checked", expected: expectedMigrations, applied: [], missing: expectedMigrations },
    categories: { status: "not_checked", active_count: null, missing: [...EXPECTED_CATEGORIES] },
    storage: { status: "not_checked", bucket: "project-logos", public: null, file_size_limit: null, mime_types: [] },
    public_catalog: { status: "not_checked", search_ready: null, rls_read_ready: null, public_item_count: null, active_category_count: null },
    admin_authorization: { status: "not_checked", allowlisted_admin_count: null, signups_disabled: null, email_password_enabled: null },
    pipeline: { status: "not_checked", schema_ready: null, running_jobs: null, active_leases: null, inventory: null },
    integrity: { status: "not_checked", findings: [] },
    github_rate_limit: { status: environment.GITHUB_TOKEN?.trim() ? "not_checked" : "not_configured", authentication: environment.GITHUB_TOKEN?.trim() ? "unknown" : "unauthenticated",
      core_remaining: null, core_limit: null, core_resets_at: null, search_remaining: null, search_limit: null, search_resets_at: null },
    unpublished_projects: null,
    pending_review_projects: null,
    manual_checks_required: [],
    blockers,
    ingestion_blockers: [],
    launch_only_blockers: [],
    warnings,
    ingestion_ready: false,
    launch_ready: false,
    hosted_verification: targetInfo.kind === "hosted" ? "partial" : "not_performed",
    exit_code: 1,
  };

  if (targetInfo.kind === "hosted") {
    const hasHttpsOrigin = isHttpsOrigin(environment.OUTLIST_PUBLIC_ORIGIN);
    report.manual_checks_required = hasHttpsOrigin ? [] : ["OUTLIST_PUBLIC_ORIGIN must be the deployed HTTPS origin"];
    if (!hasHttpsOrigin) launchOnlyBlockers.push({ code: "hosted_manual_checks_incomplete", message: "Set and verify the deployed HTTPS origin before declaring the hosted website launch-ready." });
  }

  const finalizeReport = () => {
    report.ingestion_blockers = [...blockers, ...ingestionOnlyBlockers];
    report.launch_only_blockers = [...launchOnlyBlockers];
    report.ingestion_ready = report.ingestion_blockers.length === 0;
    report.launch_ready = verificationCompleted && blockers.length === 0 && launchOnlyBlockers.length === 0;
    report.blockers = purpose === "ingestion"
      ? report.ingestion_blockers
      : [...blockers, ...launchOnlyBlockers];
    report.exit_code = purpose === "ingestion"
      ? report.ingestion_ready ? 0 : 1
      : report.launch_ready ? 0 : 1;
  };

  const targetSafeToInspect = targetInfo.kind === "local"
    ? targetInfo.labelValid && Boolean(environment.OUTLIST_SUPABASE_ENVIRONMENT?.trim()) && !targetInfo.localMismatch
    : targetInfo.kind === "hosted" && targetInfo.projectRef !== null
      && target.confirmation === "matched" && targetInfo.labelValid && !targetInfo.remoteLocalMismatch
      && targetInfo.environment !== "unknown";
  const ingestionTargetSafeToInspect = purpose !== "ingestion" || (targetInfo.kind === "hosted"
    && targetInfo.projectRef === PRODUCTION_PROJECT_REF && targetInfo.environment === "production"
    && target.confirmation === "matched");
  if (targetSafeToInspect && (configuredPublic || configuredAdmin) && !adapters) {
    blockers.push({ code: "preflight_adapters_unavailable", message: "Read-only preflight checks could not be initialized for the configured Supabase target." });
  }
  if (!targetSafeToInspect || !ingestionTargetSafeToInspect || (!configuredPublic && !configuredAdmin) || !adapters) {
    if (!configuredPublic && !environment.NEXT_PUBLIC_SUPABASE_URL?.trim()) report.public_catalog.status = "unavailable";
    if (!configuredAdmin && !environment.SUPABASE_SECRET_KEY?.trim()) report.pipeline.status = "unavailable";
    finalizeReport();
    return report;
  }

  let operatorResult: ReadResult;
  try { operatorResult = await adapters.readOperatorReport(); }
  catch { operatorResult = { error: true }; }
  const operatorReport = object(operatorResult.data);
  const schema = object(operatorReport?.schema);
  const categoryReport = object(operatorReport?.categories);
  const storageReport = object(operatorReport?.storage_bucket);
  const inventory = object(operatorReport?.inventory);
  const runningJobs = countRunningJobs(operatorReport?.running_jobs);
  const activeLeases = countActiveLeases(operatorReport?.active_leases);
  const rawFindings = Array.isArray(operatorReport?.integrity_findings) ? operatorReport.integrity_findings : [];
  report.integrity.findings = rawFindings.flatMap((item) => {
    const finding = object(item);
    if (!finding || typeof finding.code !== "string" || typeof finding.severity !== "string") return [];
    return [{ code: finding.code, severity: finding.severity, affected_count: safeCount(finding.affected_count) ?? 0 }];
  });
  report.integrity.status = operatorReport ? report.integrity.findings.length ? "findings" : "clean" : "unavailable";
  if (!checkResult(operatorResult, "operator_report_unavailable", "The read-only service report could not be read. Confirm Supabase connectivity and the server secret key.", blockers) || !operatorReport) {
    report.migrations.status = "unavailable";
    report.categories.status = "unavailable";
    report.storage.status = "unavailable";
    report.pipeline.status = "unavailable";
    report.integrity.status = "unavailable";
  } else {
    const appliedMigrations = safeStringArray(schema?.applied_migrations);
    report.migrations.applied = appliedMigrations;
    report.migrations.missing = expectedMigrations.filter((version) => !appliedMigrations.includes(version));
    const migrationTableAvailable = schema?.migration_table_available === true;
    report.migrations.status = migrationTableAvailable && report.migrations.missing.length === 0 ? "verified" : "incomplete";
    if (!migrationTableAvailable) blockers.push({ code: "migration_history_unavailable", message: "The Supabase migration history table is missing or inaccessible; migration completion cannot be verified." });
    if (report.migrations.missing.length > 0) blockers.push({ code: "migrations_missing", message: `The target is missing ${report.migrations.missing.length} repository migration(s): ${report.migrations.missing.join(", ")}.` });
    if (schema?.ready !== true) blockers.push({ code: "pipeline_schema_not_ready", message: "The operator report found missing schema objects, grants, or migration readiness requirements." });
    report.pipeline.schema_ready = schema?.ready === true;

    const missingCategories = safeStringArray(categoryReport?.missing_slugs);
    const activeCategoryCount = safeCount(categoryReport?.active_count);
    report.categories.active_count = activeCategoryCount;
    report.categories.missing = missingCategories;
    report.categories.status = categoryReport?.ready === true && activeCategoryCount === EXPECTED_CATEGORIES.length ? "ready" : "incomplete";
    if (report.categories.status !== "ready") blockers.push({ code: "category_taxonomy_incomplete", message: `The active category taxonomy must contain the expected 11 categories; ${missingCategories.length} expected category slug(s) are missing.` });

    const mimeTypes = safeStringArray(storageReport?.mime_types);
    const bucketPublic = storageReport?.public === true;
    const fileSizeLimit = safeCount(storageReport?.file_size_limit);
    report.storage.public = storageReport?.exists === true ? bucketPublic : false;
    report.storage.file_size_limit = fileSizeLimit;
    report.storage.mime_types = mimeTypes;
    const storageReady = storageReport?.exists === true && bucketPublic && fileSizeLimit === 2_097_152
      && ["image/png", "image/jpeg", "image/webp"].every((type) => mimeTypes.includes(type));
    report.storage.status = storageReady ? "ready" : "incomplete";
    if (!storageReady) blockers.push({ code: "logo_storage_not_ready", message: "The public project-logos bucket must exist with a 2 MiB limit and PNG, JPEG, and WebP MIME types." });

    report.pipeline.running_jobs = runningJobs;
    report.pipeline.active_leases = activeLeases;
    report.pipeline.inventory = inventory;
    report.pending_review_projects = safeCount(inventory?.pending_review_project_drafts);
    if (!inventory || safeCount(inventory.published_projects) === null || report.pending_review_projects === null) {
      blockers.push({ code: "pipeline_inventory_unavailable", message: "Published and pending-review inventory counts could not be read from the service-only report." });
    }
    if (runningJobs === null || activeLeases === null) blockers.push({ code: "pipeline_activity_unavailable", message: "Running jobs or active leases could not be inspected safely." });
    else if (runningJobs > 0 || activeLeases > 0) blockers.push({ code: "pipeline_already_active", message: "An ingestion job or unexpired worker lease is active; inspect checkpoints before starting a pilot." });

    for (const finding of report.integrity.findings) {
      if (finding.severity === "critical" && finding.affected_count > 0) blockers.push({ code: `integrity_${finding.code}`, message: `Critical integrity finding ${finding.code} affects ${finding.affected_count} record(s); resolve it before launch.` });
      else if (finding.affected_count > 0) warnings.push({ code: `integrity_${finding.code}`, message: `${finding.severity} integrity finding ${finding.code} affects ${finding.affected_count} record(s); review the full read-only audit.` });
    }
  }

  const [adminResult, unpublishedResult, publicCountResult, categoriesResult, searchResult, authResult] = await Promise.all([
    readSafely(() => adapters.countAllowlistedAdmins()),
    readSafely(() => adapters.countUnpublishedProjects()),
    readSafely(() => adapters.countAnonymousProjects()),
    readSafely(() => adapters.readAnonymousCategories()),
    readSafely(() => adapters.searchAnonymousCatalog()),
    readSafely(() => adapters.readAuthSettings()),
  ]);

  const adminCount = safeCount(adminResult.count);
  report.admin_authorization.allowlisted_admin_count = adminCount;
  const authSettings = object(authResult.data);
  const signupsDisabled = authSettings?.disable_signup === true;
  const emailProvider = object(authSettings?.external);
  const emailPasswordEnabled = typeof emailProvider?.email === "boolean"
    ? emailProvider.email
    : typeof authSettings?.email_enabled === "boolean"
      ? authSettings.email_enabled
      : null;
  report.admin_authorization.signups_disabled = authResult.error ? null : signupsDisabled;
  report.admin_authorization.email_password_enabled = authResult.error ? null : emailPasswordEnabled;
  if (authResult.error || !authSettings) blockers.push({ code: "auth_settings_unavailable", message: "Supabase Auth settings could not be read; verify that email/password authentication is available and public signup is disabled." });
  else if (!signupsDisabled) blockers.push({ code: "auth_signup_enabled", message: "Disable public account signup before enabling administrator password sign-in." });
  else if (emailPasswordEnabled === null) blockers.push({ code: "auth_email_password_unverified", message: "The Auth settings response did not confirm that the email provider is enabled." });
  else if (!emailPasswordEnabled) blockers.push({ code: "auth_email_password_disabled", message: "The Supabase email provider is disabled; administrator password sign-in cannot work." });
  if (adminResult.error || adminCount === null) blockers.push({ code: "admin_allowlist_unavailable", message: "The private administrator allowlist could not be checked with the server credential." });
  else if (adminCount < 1) blockers.push({ code: "admin_allowlist_empty", message: "Provision at least one trusted Auth user UUID in public.admin_users before editorial review." });
  report.admin_authorization.status = authResult.error || adminResult.error || adminCount === null ? "unavailable"
    : signupsDisabled && emailPasswordEnabled && adminCount > 0 ? "ready" : "incomplete";

  const searchData = object(searchResult.data);
  const searchCount = safeCount(searchData?.totalCount);
  const directPublicCount = publicCountResult.error ? null : safeCount(publicCountResult.count);
  const categoryRows: unknown[] | null = Array.isArray(categoriesResult.data) ? categoriesResult.data : null;
  const activeCategoryCount = categoryRows?.length ?? null;
  const categorySlugs = categoryRows?.flatMap((row) => {
    const category = object(row);
    return typeof category?.slug === "string" ? [category.slug] : [];
  }) ?? [];
  const publicTaxonomyReady = activeCategoryCount === EXPECTED_CATEGORIES.length
    && EXPECTED_CATEGORIES.every((slug) => categorySlugs.includes(slug));
  const searchReady = !searchResult.error && Boolean(searchData)
    && Array.isArray(searchData?.items) && typeof searchData?.page === "number"
    && searchData?.pageSize === 1 && searchData?.sort === "newest" && searchCount !== null;
  const rlsReady = !publicCountResult.error && directPublicCount !== null && searchCount !== null && directPublicCount === searchCount;
  report.public_catalog.search_ready = searchReady;
  report.public_catalog.rls_read_ready = rlsReady;
  report.public_catalog.public_item_count = searchReady ? searchCount : null;
  report.public_catalog.active_category_count = activeCategoryCount;
  report.public_catalog.status = searchReady && rlsReady && !categoriesResult.error && publicTaxonomyReady ? "ready"
    : !searchResult.error && !publicCountResult.error && !categoriesResult.error ? "incomplete" : "unavailable";
  if (!searchReady) blockers.push({ code: "public_search_unavailable", message: "Anonymous search_public_projects returned an error or response outside its documented shape." });
  if (!rlsReady) blockers.push({ code: "public_rls_read_unavailable", message: "Anonymous direct project reads did not succeed or do not match the public search count; verify RLS and grants." });
  if (categoriesResult.error || !publicTaxonomyReady) blockers.push({ code: "public_category_read_unavailable", message: "Anonymous category reads do not expose the complete active taxonomy." });
  if (searchReady && inventory && safeCount(inventory.published_projects) !== null && searchCount !== safeCount(inventory.published_projects)) blockers.push({ code: "public_catalog_count_mismatch", message: "Anonymous search and the service inventory disagree on published project count; inspect source-safety and integrity findings." });
  report.unpublished_projects = unpublishedResult.error ? null : safeCount(unpublishedResult.count);
  if (unpublishedResult.error || report.unpublished_projects === null) blockers.push({ code: "unpublished_count_unavailable", message: "The server-only count of unpublished projects could not be read." });

  const tokenConfigured = Boolean(environment.GITHUB_TOKEN?.trim());
  if (tokenConfigured) {
    let rateResult: ReadResult;
    try { rateResult = await adapters.readGitHubRateLimit(); }
    catch { rateResult = { error: true }; }
    const rate = object(rateResult.data) as RateLimitData | null;
    if (rateResult.error || !rate) {
      report.github_rate_limit.status = "unavailable";
      report.github_rate_limit.authentication = "unknown";
      blockers.push({ code: "github_rate_limit_unavailable", message: "GitHub rate limits could not be inspected with the configured token; check token scope and network access." });
    } else {
      const core = rate.resources?.core ?? rate.rate;
      const search = rate.resources?.search;
      report.github_rate_limit.status = "checked";
      report.github_rate_limit.authentication = tokenConfigured ? "authenticated" : "unauthenticated";
      report.github_rate_limit.core_remaining = safeCount(core?.remaining);
      report.github_rate_limit.core_limit = safeCount(core?.limit);
      report.github_rate_limit.core_resets_at = isoFromUnix(core?.reset);
      report.github_rate_limit.search_remaining = safeCount(search?.remaining);
      report.github_rate_limit.search_limit = safeCount(search?.limit);
      report.github_rate_limit.search_resets_at = isoFromUnix(search?.reset);
      if (report.github_rate_limit.core_remaining === 0 || report.github_rate_limit.search_remaining === 0) warnings.push({ code: "github_rate_limit_exhausted", message: "A GitHub rate-limit resource is exhausted; wait until its reported reset time before ingestion." });
      const coreRemaining = report.github_rate_limit.core_remaining;
      const searchRemaining = report.github_rate_limit.search_remaining;
      if (coreRemaining === null || searchRemaining === null) {
        ingestionOnlyBlockers.push({ code: "github_rate_limit_budget_unavailable", message: "GitHub did not return usable core and search budget values for the bounded pilot." });
      } else if (coreRemaining < INGESTION_GITHUB_BUDGET.core || searchRemaining < INGESTION_GITHUB_BUDGET.search) {
        ingestionOnlyBlockers.push({ code: "github_rate_limit_budget_insufficient", message: `The bounded pilot requires at least ${INGESTION_GITHUB_BUDGET.core} core and ${INGESTION_GITHUB_BUDGET.search} search requests in the current GitHub budget.` });
      }
    }
  } else {
    warnings.push({ code: "github_token_not_configured", message: "No server-only GITHUB_TOKEN is configured; public GitHub access has a smaller unauthenticated rate budget." });
  }

  if (targetInfo.kind === "hosted") {
    report.hosted_verification = "partial";
  } else if (targetInfo.kind === "local") {
    report.hosted_verification = "not_performed";
  }

  if (report.integrity.findings.some((finding) => finding.severity === "critical" && finding.affected_count > 0)) report.integrity.status = "findings";
  report.pipeline.status = report.pipeline.schema_ready === true && report.categories.status === "ready"
    && report.storage.status === "ready" && report.integrity.status !== "unavailable"
    && report.pipeline.running_jobs === 0 && report.pipeline.active_leases === 0 ? "ready" : "blocked";
  if (report.integrity.status === "unavailable") blockers.push({ code: "integrity_audit_unavailable", message: "The outstanding integrity findings could not be inspected." });
  verificationCompleted = true;
  finalizeReport();
  return report;
}

function createRuntimeAdapters(environment: Environment): LaunchPreflightAdapters {
  const url = environment.NEXT_PUBLIC_SUPABASE_URL as string;
  const publishableKey = environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const admin = environment.SUPABASE_SECRET_KEY?.trim() ? createSupabaseAdminClient() : null;
  const anonymous = publishableKey?.trim() ? createClient<Database>(url, publishableKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }) },
  }) : null;
  return {
    readOperatorReport: async () => admin ? await admin.rpc("pipeline_operator_report") as unknown as ReadResult : { error: true },
    countAllowlistedAdmins: async () => admin ? await admin.from("admin_users").select("user_id", { count: "exact", head: true }) as unknown as ReadResult : { error: true },
    countUnpublishedProjects: async () => admin ? await admin.from("projects").select("id", { count: "exact", head: true }).neq("publication_status", "published") as unknown as ReadResult : { error: true },
    countAnonymousProjects: async () => anonymous ? await anonymous.from("projects").select("id", { count: "exact", head: true }) as unknown as ReadResult : { error: true },
    readAnonymousCategories: async () => anonymous ? await anonymous.from("categories").select("id,slug").eq("is_active", true) as unknown as ReadResult : { error: true },
    searchAnonymousCatalog: async () => anonymous ? await anonymous.rpc("search_public_projects", {
      p_categories: [], p_licenses: [], p_languages: [], p_sort: "newest", p_page: 1, p_page_size: 1,
    }) as unknown as ReadResult : { error: true },
    readAuthSettings: async () => {
      if (!publishableKey?.trim()) return { error: true };
      try {
        const response = await fetch(`${url.replace(/\/$/, "")}/auth/v1/settings`, {
          method: "GET", headers: { apikey: publishableKey }, cache: "no-store", signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) return { error: true };
        return { data: await response.json() as unknown };
      } catch {
        return { error: true };
      }
    },
    readGitHubRateLimit: async () => {
      try {
        const client = new GitHubClient({ token: environment.GITHUB_TOKEN, maxRetries: 0 });
        const result = await client.getRateLimit({ signal: AbortSignal.timeout(8000) });
        return result.kind === "ok" ? { data: result.data } : { error: true };
      } catch {
        return { error: true };
      }
    },
  };
}

export async function runLaunchPreflightCli(
  args = process.argv.slice(2),
  injected?: { environment?: Environment; adapters?: LaunchPreflightAdapters; expectedMigrations?: string[]; writeStdout?: (text: string) => void; writeStderr?: (text: string) => void },
): Promise<number> {
  const stdout = injected?.writeStdout ?? ((value: string) => process.stdout.write(value));
  const stderr = injected?.writeStderr ?? ((value: string) => process.stderr.write(value));
  let parsed: LaunchPreflightArguments;
  try { parsed = parseArguments(args); }
  catch (error) {
    const message = error instanceof TypeError && error.message.startsWith("--confirm-project-ref")
      ? error.message : "Invalid launch preflight arguments. Use --help to see supported options.";
    stderr(`${JSON.stringify({ event: "launch_preflight_argument_error", message })}\n`);
    return 2;
  }
  if (parsed.help) {
    stdout("Usage: bun run launch:preflight [--purpose launch|ingestion] [--confirm-project-ref <ref>]\nThe default purpose is launch. Ingestion purpose checks production ingestion readiness without requiring a deployed website.\nThis command is read-only. It never starts ingestion or changes database or Storage records.\n");
    return 0;
  }
  const environment = injected?.environment ?? process.env;
  const publicConfigured = Boolean(environment.NEXT_PUBLIC_SUPABASE_URL?.trim() && environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim());
  const adminConfigured = Boolean(environment.NEXT_PUBLIC_SUPABASE_URL?.trim() && environment.SUPABASE_SECRET_KEY?.trim());
  const canContactSupabase = Boolean(environment.NEXT_PUBLIC_SUPABASE_URL?.trim() && (publicConfigured || adminConfigured));
  let adapters = injected?.adapters;
  if (!adapters && canContactSupabase) {
    try {
      adapters = createRuntimeAdapters(environment);
    } catch {
      const report = await buildLaunchPreflightReport(parsed, environment, undefined, { expectedMigrations: injected?.expectedMigrations });
      const adapterBlocker = { code: "preflight_adapter_configuration_invalid", message: "Supabase client configuration could not be initialized; check the configured URL and credential format." };
      report.ingestion_blockers.push(adapterBlocker);
      report.blockers = parsed.purpose === "ingestion"
        ? report.ingestion_blockers
        : [...report.blockers, adapterBlocker];
      report.ingestion_ready = false;
      report.launch_ready = false;
      report.exit_code = 1;
      stdout(`${JSON.stringify(report, null, 2)}\n`);
      return 1;
    }
  }
  const report = await buildLaunchPreflightReport(parsed, environment, adapters, { expectedMigrations: injected?.expectedMigrations });
  stdout(`${JSON.stringify(report, null, 2)}\n`);
  return report.exit_code;
}

if (import.meta.main) process.exitCode = await runLaunchPreflightCli();
