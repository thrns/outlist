import { randomUUID } from "node:crypto";
import { createSupabaseAdminClient } from "../src/lib/supabase/admin";
import { runLaunchPreflightCli } from "./launch-preflight";

const urlValue = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!urlValue) throw new Error("Local launch preflight integration requires a Supabase URL.");
const parsedUrl = new URL(urlValue);
if (!(parsedUrl.hostname === "localhost" || parsedUrl.hostname.endsWith(".localhost")
  || parsedUrl.hostname.startsWith("127.") || parsedUrl.hostname === "::1")) {
  throw new Error("Launch preflight integration refuses to create test records on a non-local Supabase target.");
}

const admin = createSupabaseAdminClient();
const email = `launch-preflight-${randomUUID()}@example.com`;
const password = randomUUID() + randomUUID();
let authUserId: string | null = null;
let allowlistInserted = false;

try {
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) throw new Error("Could not provision the temporary local preflight administrator.");
  authUserId = created.data.user.id;

  const inserted = await admin.from("admin_users").insert({ user_id: authUserId });
  if (inserted.error) throw new Error("Could not add the temporary local preflight administrator to the allowlist.");
  allowlistInserted = true;

  process.env.OUTLIST_SUPABASE_ENVIRONMENT = "local";
  delete process.env.GITHUB_TOKEN;
  let output = "";
  const exitCode = await runLaunchPreflightCli([], { writeStdout: (line) => { output += line; } });
  const report = JSON.parse(output) as { launch_ready?: boolean; exit_code?: number; public_catalog?: { status?: string }; migrations?: { status?: string } };
  if (exitCode !== 0 || report.launch_ready !== true || report.exit_code !== 0
    || report.public_catalog?.status !== "ready" || report.migrations?.status !== "verified") {
    throw new Error("Read-only launch preflight did not pass against the initialized local Supabase database.");
  }
  process.stdout.write("{\"event\":\"launch_preflight_local_integration\",\"status\":\"passed\",\"read_only_preflight\":true,\"hosted_access\":false,\"github_requests\":false}\n");
} finally {
  if (allowlistInserted && authUserId) {
    const removed = await admin.from("admin_users").delete().eq("user_id", authUserId);
    if (removed.error) throw new Error("Could not remove the temporary local preflight allowlist row.");
  }
  if (authUserId) {
    const removed = await admin.auth.admin.deleteUser(authUserId);
    if (removed.error) throw new Error("Could not remove the temporary local preflight Auth user.");
  }
}
