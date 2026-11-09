import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const supabaseCli = join(root, "node_modules", ".bin", "supabase");
const playwrightCli = join(root, "node_modules", ".bin", "playwright");
const outputDir = join(tmpdir(), `outlist-auth-e2e-${process.pid}`);
const port = Number(process.env.AUTH_E2E_PORT ?? "3187");
const baseUrl = `http://127.0.0.1:${port}`;

async function ensurePortIsAvailable(candidate) {
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > 65_535) {
    throw new Error("AUTH_E2E_PORT must be a valid TCP port");
  }
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", () => reject(new Error("Auth E2E application port is in use")));
    server.listen(candidate, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

const identityNames = [
  "login",
  "session",
  "revoke",
  "logout",
  "nonAdmin",
  "invalid",
];

let stage = "checking local Supabase state";
let stackStartAttempted = false;
let nextServer;
let nextServerLogs = "";
let adminClient;
const sensitiveValues = [];

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: options.env ?? process.env,
      stdio: options.stdio ?? "ignore",
      detached: options.detached ?? false,
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code: code ?? 1, signal, child });
    });
  });
}

function capture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-1_000_000);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code: code ?? 1, signal, stdout });
    });
  });
}

async function requireSuccess(command, args, env, label) {
  const result = await run(command, args, { env });
  if (result.code !== 0) throw new Error(`${label} failed`);
}

async function waitForHttp(url, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // The next bounded readiness check will retry while the service starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready before its deadline`);
}

function statusValue(status, ...names) {
  for (const name of names) {
    if (typeof status[name] === "string" && status[name].length > 0) {
      return status[name];
    }
  }
  return undefined;
}

async function createTemporaryUsers(identities) {
  const result = {};
  for (const name of identityNames) {
    const email = identities[name];
    const password = randomBytes(32).toString("base64url");
    const { data, error } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !data.user) {
      throw new Error("Could not provision the disposable local Auth users");
    }
    result[name] = { email, password, userId: data.user.id };
  }

  const allowlisted = identityNames.filter((name) => name !== "nonAdmin");
  const { error } = await adminClient.from("admin_users").insert(
    allowlisted.map((name) => ({ user_id: result[name].userId })),
  );
  if (error) throw new Error("Could not seed the disposable admin allowlist");
  return result;
}

async function createEditorialFixture() {
  const projectId = randomUUID();
  const repositoryId = randomUUID();
  const providerRepositoryId = BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 14)}`).toString();
  const slug = `auth-e2e-${projectId.replaceAll("-", "").slice(0, 18)}`;
  const projectName = "Auth E2E Editorial Fixture";
  const observedAt = new Date(Date.now() - 30_000).toISOString();
  const { data: category, error: categoryError } = await adminClient
    .from("categories")
    .select("id")
    .eq("slug", "developer-tools")
    .single();
  if (categoryError || !category) throw new Error("Could not find the seeded category for the editorial E2E fixture");
  const { error: projectError } = await adminClient.from("projects").insert({
    id: projectId,
    slug,
    name: projectName,
    summary: "A real Supabase-backed draft for authenticated editorial review.",
    description: "This fixture exists only in the disposable local Auth E2E database.",
    publication_status: "pending_review",
    license_status: "unverified",
    quality_status: "unreviewed",
  });
  if (projectError) throw new Error("Could not create the editorial E2E project fixture");
  const { error: repositoryError } = await adminClient.from("repositories").insert({
    id: repositoryId,
    project_id: projectId,
    provider: "github",
    provider_repository_id: providerRepositoryId,
    full_name: "outlist-e2e/editorial-fixture",
    canonical_url: "https://github.com/outlist-e2e/editorial-fixture",
    owner_login: "outlist-e2e",
    repository_name: "editorial-fixture",
    availability_status: "available",
    is_private: false,
    visibility: "public",
    is_disabled: false,
    source_observed_at: observedAt,
    last_successful_sync_at: observedAt,
    source_field_states: { visibility: "present", license: "present", description: "present", topics: "present", languages: "present", releases: "present" },
    source_license_metadata: { detected_spdx_id: "NOASSERTION" },
  });
  if (repositoryError) throw new Error("Could not create the editorial E2E repository fixture");
  const { error: primaryError } = await adminClient.from("projects").update({ primary_repository_id: repositoryId }).eq("id", projectId);
  if (primaryError) throw new Error("Could not attach the editorial E2E primary repository");
  const { error: categoryLinkError } = await adminClient.from("project_categories").insert({ project_id: projectId, category_id: category.id });
  if (categoryLinkError) throw new Error("Could not classify the editorial E2E project fixture");
  const sourceIds = {};
  for (const kind of ["repository", "topics", "languages", "releases"]) {
    const sourceId = randomUUID();
    const { error: sourceError } = await adminClient.from("source_records").insert({
      id: sourceId,
      provider: "github",
      record_kind: kind,
      source_key: `${providerRepositoryId}:${kind}:auth-e2e`,
      source_url: "https://api.github.com/repos/outlist-e2e/editorial-fixture",
      fetched_at: observedAt,
      http_status: 200,
      repository_id: repositoryId,
      source_metadata: { validated: true, api_version: "2022-11-28", resource_kind: kind, stable_provider_id: providerRepositoryId },
    });
    if (sourceError) throw new Error(`Could not create the editorial E2E ${kind} source record`);
    sourceIds[kind] = sourceId;
  }
  const { error: topicError } = await adminClient.from("repository_topics").insert({ repository_id: repositoryId, source_topic: "editorial-review", source_record_id: sourceIds.topics, observed_at: observedAt });
  if (topicError) throw new Error("Could not create the editorial E2E topic evidence");
  const { error: languageError } = await adminClient.from("repository_languages").insert({ repository_id: repositoryId, language_name: "TypeScript", bytes: 1500, measured_at: observedAt, source_record_id: sourceIds.languages });
  if (languageError) throw new Error("Could not create the editorial E2E language evidence");
  const { error: releaseError } = await adminClient.from("releases").insert({ repository_id: repositoryId, provider_release_id: "e2e-release-1", version: "v1.0.0", release_name: "E2E release", release_url: "https://github.com/outlist-e2e/editorial-fixture/releases/tag/v1.0.0", published_at: observedAt, source_record_id: sourceIds.releases });
  if (releaseError) throw new Error("Could not create the editorial E2E release evidence");
  const assessmentId = randomUUID();
  const { error: assessmentError } = await adminClient.from("repository_assessments").insert({
    id: assessmentId,
    repository_id: repositoryId,
    policy_version: "m1-04-assessment-v1",
    source_observed_at: observedAt,
    status: "assessed",
    assessed_at: observedAt,
    result: {
      classification: { status: "classified", primaryCategoryId: category.id, suggestions: [{ categoryId: category.id, score: 1, evidence: ["repository topic: editorial-review"] }] },
      license: { policyVersion: "outlist-license-evidence-v1", status: "conflicting_evidence", identifier: null, projectLicenseStatus: "needs_review", evidence: [], explanation: "GitHub license evidence remains uncertain for review.", requiresReview: true },
      quality: { policyVersion: "outlist-source-quality-v1", status: "eligible_for_review", priority: "normal", qualityStatus: "needs_review", flags: [{ code: "license_uncertain", severity: "review", evidence: ["source_license_metadata"], explanation: "License evidence needs human review." }] },
    },
  });
  if (assessmentError) throw new Error("Could not create the editorial E2E assessment");
  const { error: assessmentSourceError } = await adminClient.from("repository_assessment_sources").insert(Object.values(sourceIds).map((sourceRecordId) => ({ assessment_id: assessmentId, source_record_id: sourceRecordId })));
  if (assessmentSourceError) throw new Error("Could not link editorial E2E assessment source evidence");
  const { error: queueError } = await adminClient.from("review_queue").insert({
    project_id: projectId,
    assessment_id: assessmentId,
    reason: "Auth E2E draft requires actual database-backed review.",
    status: "open",
  });
  if (queueError) throw new Error("Could not queue the editorial E2E project fixture");
  return { projectId, projectName };
}

async function ensureNoClientSecret(directory, secretKey) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await ensureNoClientSecret(path, secretKey);
    } else if (entry.isFile()) {
      const content = await readFile(path);
      if (content.includes(Buffer.from(secretKey))) {
        throw new Error("The privileged key was included in a client asset");
      }
    }
  }
}

function redactDiagnostics(input) {
  let safe = input;
  for (const value of sensitiveValues.sort((a, b) => b.length - a.length)) {
    safe = safe.split(value).join("[redacted]");
  }
  return safe
    .replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, "[redacted-key]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted-jwt]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/\b\d{6,8}\b/g, "[redacted-code]")
    .replace(/(authorization|cookie|set-cookie|apikey)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}

function printRelevantLogLines(label, input) {
  const lines = redactDiagnostics(input).split(/\r?\n/);
  const selected = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    if (/error|exception|fatal|warn|\b(?:400|401|403|500|502|503)\b/i.test(lines[index])) {
      for (let offset = Math.max(0, index - 1); offset <= Math.min(lines.length - 1, index + 2); offset += 1) {
        selected.add(offset);
      }
    }
  }
  const excerpts = [...selected]
    .sort((a, b) => a - b)
    .map((index) => lines[index])
    .filter(Boolean)
    .slice(-40);
  if (excerpts.length > 0) {
    console.error(`${label} diagnostic excerpts (credentials and test identities redacted):`);
    console.error(excerpts.join("\n"));
  } else {
    const tail = redactDiagnostics(input)
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-40);
    if (tail.length > 0) {
      console.error(`${label} recent server log tail (credentials and test identities redacted):`);
      console.error(tail.join("\n"));
    }
  }
}

async function printSupabaseAuthLogs() {
  try {
    const containers = await capture("docker", ["ps", "--format", "{{.Names}}"]);
    if (containers.code !== 0) return;
    const authContainers = containers.stdout
      .split(/\r?\n/)
      .filter((name) => /supabase.*auth|auth.*supabase/i.test(name));
    for (const container of authContainers) {
      const logs = await capture("docker", ["logs", "--tail", "300", container]);
      if (logs.code === 0) printRelevantLogLines("Supabase Auth", logs.stdout);
    }
  } catch {
    // CI still reports the failing assertion if the container runtime is unavailable.
  }
}

async function stopNextServer() {
  if (!nextServer?.pid) return;
  try {
    process.kill(-nextServer.pid, "SIGTERM");
  } catch {
    return;
  }
  await Promise.race([
    new Promise((resolve) => nextServer.once("close", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  try {
    process.kill(-nextServer.pid, "SIGKILL");
  } catch {
    // The process group already exited.
  }
}

async function main() {
  stage = "checking the dedicated application port";
  await ensurePortIsAvailable(port);

  const cliEnv = {
    ...process.env,
    SUPABASE_TELEMETRY_DISABLED: "1",
  };

  const existing = await capture(supabaseCli, ["status", "--output", "json"], {
    env: cliEnv,
  });
  if (existing.code === 0) {
    throw new Error("Stop the existing local Supabase stack before this disposable run");
  }

  stage = "starting the disposable local Supabase stack";
  stackStartAttempted = true;
  await requireSuccess(supabaseCli, ["start"], cliEnv, "Supabase start");

  stage = "applying the committed migrations";
  await requireSuccess(supabaseCli, ["db", "reset"], cliEnv, "Supabase db reset");

  stage = "reading local Supabase connection details";
  const statusResult = await capture(
    supabaseCli,
    ["status", "--output", "json"],
    { env: cliEnv },
  );
  if (statusResult.code !== 0) throw new Error("Supabase status failed");
  let status;
  try {
    status = JSON.parse(statusResult.stdout);
  } catch {
    throw new Error("Supabase status did not return JSON");
  }

  const apiUrl = statusValue(status, "API_URL", "api_url");
  const publishableKey = statusValue(
    status,
    "PUBLISHABLE_KEY",
    "publishable_key",
    "ANON_KEY",
  );
  const secretKey = statusValue(
    status,
    "SECRET_KEY",
    "secret_key",
    "SERVICE_ROLE_KEY",
  );
  if (!apiUrl || !publishableKey || !secretKey) {
    throw new Error("Supabase status is missing a required local service value");
  }

  stage = "checking local Auth readiness";
  await waitForHttp(`${apiUrl}/auth/v1/health`, "Supabase Auth", 30_000);

  stage = "creating temporary local Auth identities and allowlist records";
  const runId = randomUUID();
  const emails = Object.fromEntries(
    identityNames.map((name) => [
      name,
      `e2e-${runId}-${name.toLowerCase()}@example.com`,
    ]),
  );
  const appEnv = {
    ...cliEnv,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_SUPABASE_URL: apiUrl,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishableKey,
    SUPABASE_SECRET_KEY: secretKey,
    AUTH_E2E_BASE_URL: baseUrl,
    AUTH_E2E_OUTPUT_DIR: outputDir,
  };
  sensitiveValues.push(apiUrl, publishableKey, secretKey);
  adminClient = createClient(apiUrl, secretKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          signal: init?.signal ?? AbortSignal.timeout(5_000),
        }),
    },
  });
  const users = await createTemporaryUsers(emails);
  sensitiveValues.push(
    ...Object.values(users).flatMap(({ email, password, userId }) => [email, password, userId]),
  );
  appEnv.AUTH_E2E_USERS = JSON.stringify(users);
  const editorialFixture = await createEditorialFixture();
  appEnv.AUTH_E2E_PROJECT_FIXTURE = JSON.stringify(editorialFixture);

  stage = "building the production Next.js application";
  await requireSuccess(process.execPath, ["run", "build"], appEnv, "Next.js build");
  await ensureNoClientSecret(join(root, ".next", "static"), secretKey);

  stage = "starting the production Next.js application";
  nextServer = spawn(
    process.execPath,
    ["run", "start", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: root,
      env: appEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  for (const stream of [nextServer.stdout, nextServer.stderr]) {
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk) => {
      nextServerLogs = `${nextServerLogs}${chunk}`.slice(-200_000);
    });
  }
  nextServer.once("error", () => undefined);
  await waitForHttp(`${baseUrl}/admin/login`, "Next.js production server", 90_000);

  stage = "running the Chromium authentication integration tests";
  await mkdir(outputDir, { recursive: true });
  const testResult = await run(
    playwrightCli,
    ["test", "--config=playwright.auth.config.ts"],
    { env: appEnv, stdio: "inherit" },
  );
  if (testResult.code !== 0) {
    printRelevantLogLines("Next.js", nextServerLogs);
    await printSupabaseAuthLogs();
    throw new Error("Playwright auth tests failed");
  }
}

try {
  await main();
} catch {
  console.error(`Auth E2E failed while ${stage}. Sensitive service output is suppressed.`);
  process.exitCode = 1;
} finally {
  await stopNextServer();
  // Auth E2E runs in a disposable local project and writes append-only audit
  // rows. Stop without a backup to discard its users, fixtures, and Mailpit mail.
  let cleanupFailed = false;
  if (stackStartAttempted) {
    const stopResult = await run(supabaseCli, ["stop", "--no-backup"], {
      env: {
        ...process.env,
        SUPABASE_TELEMETRY_DISABLED: "1",
      },
    }).catch(() => ({ code: 1 }));
    if (stopResult.code !== 0) cleanupFailed = true;
  }
  await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
  if (cleanupFailed) {
    console.error("Auth E2E cleanup did not finish cleanly; the disposable stack is being discarded.");
    process.exitCode = 1;
  }
}
