import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

type TestIdentity = { email: string; userId: string };
type TestUsers = Record<
  "login" | "session" | "revoke" | "logout" | "nonAdmin" | "invalid" | "expired",
  TestIdentity
>;

const users = JSON.parse(process.env.AUTH_E2E_USERS ?? "{}") as TestUsers;
const mailpitUrl = process.env.AUTH_E2E_MAILPIT_URL;
const apiUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const requestMessage =
  "The request was processed. If this address is enabled for administrator access, follow the instructions sent to your inbox.";

if (!mailpitUrl || !apiUrl || !secretKey || !users.login?.email) {
  throw new Error("Auth E2E setup did not provide required local test values");
}

const supabaseAdmin: SupabaseClient = createClient(apiUrl, secretKey, {
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

async function requestCode(page: Page, email: string): Promise<string> {
  await page.goto("/admin/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send one-time code" }).click();
  const status = page.getByRole("status");
  await expect(status).toHaveText(requestMessage);
  return status.innerText();
}

async function readMailpitCode(email: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const searchUrl = new URL("/api/v1/search", mailpitUrl);
    searchUrl.searchParams.set("query", `to:${email}`);
    searchUrl.searchParams.set("limit", "10");
    const searchResponse = await fetch(searchUrl, {
      signal: AbortSignal.timeout(3_000),
    });
    if (searchResponse.ok) {
      const search = (await searchResponse.json()) as {
        messages?: Array<{ ID?: string }>;
      };
      const messageId = search.messages?.[0]?.ID;
      if (messageId) {
        const messageResponse = await fetch(
          new URL(`/api/v1/message/${encodeURIComponent(messageId)}`, mailpitUrl),
          { signal: AbortSignal.timeout(3_000) },
        );
        if (messageResponse.ok) {
          const message = (await messageResponse.json()) as {
            Text?: string;
            HTML?: string;
          };
          const body = `${message.Text ?? ""}\n${message.HTML ?? ""}`;
          const code =
            body.match(/one-time code[\s\S]{0,240}?\b(\d{6,8})\b/i)?.[1] ??
            body.match(/\b(\d{6,8})\b/)?.[1];
          if (code) return code;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The local Mailpit OTP was not available before its deadline");
}

async function verifyCode(page: Page, code: string) {
  await page.getByLabel("One-time code").fill(code);
  await page.getByRole("button", { name: "Verify code" }).click();
}

function wrongCode(code: string) {
  return String((Number(code) + 1) % 10 ** code.length).padStart(code.length, "0");
}

async function expectAdminCookie(page: Page) {
  const cookies = await page.context().cookies();
  const cookie = cookies.find((entry) => entry.name.includes("-auth-token"));
  expect(cookie, "Supabase SSR auth cookie should be present").toBeDefined();
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.secure).toBe(true);
}

async function expectNoStore(
  response: { headers(): Record<string, string> } | null,
) {
  const cacheControl = response?.headers()["cache-control"]?.toLowerCase() ?? "";
  expect(cacheControl).toContain("private");
  expect(cacheControl).toContain("no-store");
}

test("the public administrator login route renders its actual sign-in page", async ({ page }) => {
  const response = await page.goto("/admin/login");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Administrator sign in" })).toBeVisible();
});

test("anonymous access redirects and keeps protected content absent", async ({ page }) => {
  const response = await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login$/);
  expect(response?.status()).toBe(200);
  await expect(page.locator("body")).toContainText("Administrator sign in");
  await expect(page.getByRole("heading", { name: "Administrator sign in" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Directory administration" })).toHaveCount(0);
  await expectNoStore(response);
});

test("a forged login-route header cannot bypass admin protection", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "x-outlist-admin-login-route": "1" });
  const response = await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login$/);
  await expect(page.getByRole("heading", { name: "Directory administration" })).toHaveCount(0);
  await expectNoStore(response);
});

test("an allowlisted administrator verifies a Mailpit OTP and reaches the dashboard", async ({ page }) => {
  await requestCode(page, users.login.email);
  const code = await readMailpitCode(users.login.email);
  await verifyCode(page, code);
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Directory administration" })).toBeVisible();
  await expectAdminCookie(page);
  await expectNoStore(await page.goto("/admin"));
});

test("an administrator session survives reload and direct navigation", async ({ page }) => {
  await requestCode(page, users.session.email);
  const code = await readMailpitCode(users.session.email);
  await verifyCode(page, code);
  await expect(page.getByRole("heading", { name: "Directory administration" })).toBeVisible();
  await expectAdminCookie(page);

  await page.reload();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Directory administration" })).toBeVisible();

  const response = await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Directory administration" })).toBeVisible();
  await expectNoStore(response);
});

test("a non-admin Auth user can verify OTP but is denied dashboard access", async ({ page }) => {
  await requestCode(page, users.nonAdmin.email);
  const code = await readMailpitCode(users.nonAdmin.email);
  await verifyCode(page, code);
  await expect(page.locator(".form-card p[role='alert']")).toHaveText(
    "Sign-in could not be completed. Check the code or contact the site administrator.",
  );
  await expect(page.getByRole("heading", { name: "Directory administration" })).toHaveCount(0);

  const response = await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login$/);
  await expect(page.getByRole("heading", { name: "Directory administration" })).toHaveCount(0);
  await expectNoStore(response);
});

test("removing an allowlist row revokes the next request with an existing session", async ({ page }) => {
  await requestCode(page, users.revoke.email);
  const code = await readMailpitCode(users.revoke.email);
  await verifyCode(page, code);
  await expect(page.getByRole("heading", { name: "Directory administration" })).toBeVisible();
  await expectAdminCookie(page);

  const { error } = await supabaseAdmin
    .from("admin_users")
    .delete()
    .eq("user_id", users.revoke.userId);
  expect(error).toBeNull();

  const response = await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Administrator access denied" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Directory administration" })).toHaveCount(0);
  await expectAdminCookie(page);
  await expectNoStore(response);
});

test("the sign-out form clears the browser session and blocks the old session", async ({ page }) => {
  await requestCode(page, users.logout.email);
  const code = await readMailpitCode(users.logout.email);
  await verifyCode(page, code);
  await expect(page.getByRole("heading", { name: "Directory administration" })).toBeVisible();
  await expectAdminCookie(page);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/admin\/login$/);
  await expect(page.getByRole("heading", { name: "Administrator sign in" })).toBeVisible();
  const cookiesAfterLogout = await page.context().cookies();
  expect(cookiesAfterLogout.some((cookie) => cookie.name.includes("-auth-token"))).toBe(false);

  const response = await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login$/);
  await expect(page.getByRole("heading", { name: "Directory administration" })).toHaveCount(0);
  await expectNoStore(response);
});

test("an unknown email receives the same request response without creating an Auth user", async ({ page }) => {
  const unknownEmail = `e2e-${randomUUID()}-unknown@example.com`;
  const allowlistedResponse = await requestCode(page, users.login.email);
  const unknownResponse = await requestCode(page, unknownEmail);

  const { data, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
  expect(error).toBeNull();
  expect(data.users.some((user) => user.email === unknownEmail)).toBe(false);
  expect(allowlistedResponse).toBe(requestMessage);
  expect(unknownResponse).toBe(allowlistedResponse);
  await expect(page.getByRole("status")).toHaveText(unknownResponse);
});

test("an incorrect OTP is rejected without granting access", async ({ page }) => {
  await requestCode(page, users.invalid.email);
  const code = await readMailpitCode(users.invalid.email);
  await verifyCode(page, wrongCode(code));
  await expect(page.locator(".form-card p[role='alert']")).toHaveText(
    "That code is invalid or expired. Request a new one to continue.",
  );

  const response = await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login$/);
  await expect(page.getByRole("heading", { name: "Directory administration" })).toHaveCount(0);
  await expectNoStore(response);
});

test("an expired OTP is rejected without granting access", async ({ page }) => {
  test.setTimeout(90_000);
  await requestCode(page, users.expired.email);
  const code = await readMailpitCode(users.expired.email);

  // Local Auth is configured with a 60-second OTP expiry; wait just beyond
  // that configured boundary before submitting the real Mailpit code.
  const expiryBoundary = Date.now() + 62_000;
  await expect
    .poll(() => Date.now(), { timeout: 65_000, intervals: [250, 1_000] })
    .toBeGreaterThanOrEqual(expiryBoundary);
  await verifyCode(page, code);
  await expect(page.locator(".form-card p[role='alert']")).toHaveText(
    "That code is invalid or expired. Request a new one to continue.",
  );

  const response = await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login$/);
  await expect(page.getByRole("heading", { name: "Directory administration" })).toHaveCount(0);
  await expectNoStore(response);
});

test("the public directory remains available with Supabase Auth configured", async ({ page }) => {
  const response = await page.goto("/explore");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle(/Explore/);
  await expect(page.getByRole("heading", { name: "Explore projects" })).toBeVisible();
});
