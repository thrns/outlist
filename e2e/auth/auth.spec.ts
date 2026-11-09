import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

type TestIdentity = { email: string; password: string; userId: string };
type TestUsers = Record<
  "login" | "session" | "revoke" | "logout" | "nonAdmin" | "invalid",
  TestIdentity
>;

const users = JSON.parse(process.env.AUTH_E2E_USERS ?? "{}") as TestUsers;
const editorialFixture = JSON.parse(process.env.AUTH_E2E_PROJECT_FIXTURE ?? "{}") as { projectId: string; projectName: string };
const apiUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;

if (!apiUrl || !secretKey || !users.login?.email || !users.login.password || !editorialFixture.projectId || !editorialFixture.projectName) {
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

async function signIn(page: Page, identity: TestIdentity, password = identity.password) {
  await page.goto("/admin/login");
  await page.getByLabel("Email address").fill(identity.email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
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

test("the public administrator login route provides email and password fields", async ({ page }) => {
  const response = await page.goto("/admin/login");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Administrator sign in" })).toBeVisible();
  await expect(page.getByLabel("Email address")).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();
  await expect(page.getByLabel("One-time code")).toHaveCount(0);
});

test("missing credentials are rejected by the login form", async ({ page }) => {
  await page.goto("/admin/login");
  await page.getByRole("button", { name: "Sign In" }).click();
  await expect(page.getByText("Enter a valid email address.")).toBeVisible();
  await expect(page.getByText("Enter your password.")).toBeVisible();
});

test("anonymous access redirects and keeps protected content absent", async ({ page }) => {
  const response = await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login$/);
  expect(response?.status()).toBe(200);
  await expect(page.locator("body")).toContainText("Administrator sign in");
  await expect(page.getByRole("heading", { name: "Editorial review" })).toHaveCount(0);
  await expectNoStore(response);
});

test("a forged login-route header cannot bypass admin protection", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "x-outlist-admin-login-route": "1" });
  const response = await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login$/);
  await expect(page.getByRole("heading", { name: "Editorial review" })).toHaveCount(0);
  await expectNoStore(response);
});

test("an allowlisted administrator signs in and edits a real project draft", async ({ page }) => {
  await signIn(page, users.login);
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Editorial review" })).toBeVisible();
  const projectLink = page.getByRole("link", { name: new RegExp(editorialFixture.projectName) });
  await expect(projectLink).toBeVisible();
  await projectLink.click();
  await expect(page).toHaveURL(new RegExp(`/admin/projects/${editorialFixture.projectId}`));
  await expect(page.getByRole("heading", { name: editorialFixture.projectName })).toBeVisible();
  await expect(page.getByText("Stable GitHub repository ID")).toBeVisible();
  await expect(page.getByText("Source provenance and freshness")).toBeVisible();
  await page.getByLabel("Summary").fill("An editorially corrected Supabase-backed summary for browser coverage.");
  await page.getByLabel("Why are these corrections justified?").fill("The official project website confirms this summary and project description.");
  await page.getByRole("button", { name: "Save editorial corrections" }).click();
  await expect(page).toHaveURL(/result=saved/);
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.getByText("Existing editorial overrides").click();
  await expect(page.locator("code").filter({ hasText: /An editorially corrected Supabase-backed summary/ })).toBeVisible();
  await expectAdminCookie(page);
  await expectNoStore(await page.goto("/admin"));
});

test("an administrator session survives reload and direct navigation", async ({ page }) => {
  await signIn(page, users.session);
  await expect(page.getByRole("heading", { name: "Editorial review" })).toBeVisible();
  await expectAdminCookie(page);

  await page.reload();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Editorial review" })).toBeVisible();

  const response = await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Editorial review" })).toBeVisible();
  await expectNoStore(response);
});

test("valid credentials for a non-allowlisted Auth user do not grant access", async ({ page }) => {
  await signIn(page, users.nonAdmin);
  await expect(page.locator(".form-card p[role='alert']")).toHaveText(
    "Email or password is incorrect.",
  );
  await expect(page.getByRole("heading", { name: "Editorial review" })).toHaveCount(0);

  const response = await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login$/);
  await expect(page.getByRole("heading", { name: "Editorial review" })).toHaveCount(0);
  await expectNoStore(response);
});

test("allowlist removal revokes the next request with an existing session", async ({ page }) => {
  await signIn(page, users.revoke);
  await expect(page.getByRole("heading", { name: "Editorial review" })).toBeVisible();
  await expectAdminCookie(page);

  const { error } = await supabaseAdmin
    .from("admin_users")
    .delete()
    .eq("user_id", users.revoke.userId);
  expect(error).toBeNull();

  const response = await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Administrator access denied" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Editorial review" })).toHaveCount(0);
  await expectAdminCookie(page);
  await expectNoStore(response);
});

test("sign out clears the browser session and blocks the old session", async ({ page }) => {
  await signIn(page, users.logout);
  await expect(page.getByRole("heading", { name: "Editorial review" })).toBeVisible();
  await expectAdminCookie(page);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/admin\/login$/);
  await expect(page.getByRole("heading", { name: "Administrator sign in" })).toBeVisible();
  const cookiesAfterLogout = await page.context().cookies();
  expect(cookiesAfterLogout.some((cookie) => cookie.name.includes("-auth-token"))).toBe(false);

  const response = await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login$/);
  await expect(page.getByRole("heading", { name: "Editorial review" })).toHaveCount(0);
  await expectNoStore(response);
});

test("unknown users and incorrect passwords receive the same generic error", async ({ page }) => {
  await signIn(page, users.invalid, "incorrect password");
  const incorrectPasswordMessage = await page.locator(".form-card p[role='alert']").innerText();

  await page.goto("/admin/login");
  await page.getByLabel("Email address").fill(`unknown-${randomUUID()}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("incorrect password");
  await page.getByRole("button", { name: "Sign In" }).click();
  const unknownUserMessage = await page.locator(".form-card p[role='alert']").innerText();

  expect(unknownUserMessage).toBe("Email or password is incorrect.");
  expect(unknownUserMessage).toBe(incorrectPasswordMessage);
  const { data, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
  expect(error).toBeNull();
  expect(data.users.some((user) => user.email?.startsWith("unknown-") && user.email.endsWith("@example.com"))).toBe(false);

  const response = await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login$/);
  await expect(page.getByRole("heading", { name: "Editorial review" })).toHaveCount(0);
  await expectNoStore(response);
});

test("the public directory remains available with Supabase Auth configured", async ({ page }) => {
  const response = await page.goto("/explore");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle(/Explore/);
  await expect(page.getByRole("heading", { name: "Explore projects" })).toBeVisible();
});
