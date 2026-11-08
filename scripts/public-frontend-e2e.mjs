import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium, expect } from "@playwright/test";
import sharp from "sharp";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const supabaseCli = join(root, "node_modules", ".bin", "supabase");
const basePort = Number(process.env.PUBLIC_E2E_PORT ?? "3192");
const unavailablePort = basePort + 1;
const tempDir = join(tmpdir(), "outlist-public-frontend-" + process.pid);
const fixtureToken = randomUUID().replaceAll("-", "").slice(0, 10);
const fixtureSlug = (index) => "m109-" + fixtureToken + "-" + index;
const fixtureName = (index) => "M109 " + fixtureToken + " Fixture " + String(index).padStart(2, "0");

let server;
let browser;
let service;
let anonymous;
let fixtureProjects = [];
let logoPaths = [];
let tagSlug;
let fixtureCreated = false;
let checks = 0;

function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

function sqlLiteral(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: options.env ?? process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "ignore",
    });
    let stdout = "";
    let stderr = "";
    if (options.capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-200_000); });
      child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-200_000); });
    }
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ child, code: code ?? 1, signal, stdout, stderr }));
  });
}

function startProcess(command, args, env) {
  const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  child.logs = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { child.logs = (child.logs + chunk).slice(-300_000); });
  child.stderr.on("data", (chunk) => { child.logs = (child.logs + chunk).slice(-300_000); });
  return child;
}

async function ensurePortAvailable(port) {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", () => reject(new Error("Public frontend E2E port is already in use.")));
    listener.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
}

async function waitForHttp(url, child, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(label + " exited before becoming ready.");
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.status < 500) return;
    } catch {
      // Retry while Next.js starts and compiles the first route.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(label + " did not become ready before the timeout.");
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
    new Promise((resolve) => setTimeout(resolve, 8_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function startNext(url, publicKey, port) {
  await ensurePortAvailable(port);
  const env = { ...process.env };
  env.SUPABASE_SECRET_KEY = "";
  env.NEXT_PUBLIC_SUPABASE_URL = url;
  env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = publicKey;
  env.NEXT_TELEMETRY_DISABLED = "1";
  server = startProcess("bun", ["--bun", "next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], env);
  await waitForHttp("http://127.0.0.1:" + port + "/explore", server, "Next.js public frontend");
  return "http://127.0.0.1:" + port;
}

async function runSql(sql) {
  await mkdir(tempDir, { recursive: true, mode: 0o700 });
  const path = join(tempDir, "fixture-" + randomUUID() + ".sql");
  try {
    await writeFile(path, sql, { encoding: "utf8", mode: 0o600 });
    const result = await run(supabaseCli, ["db", "query", "--file", path, "--output-format", "json"], { capture: true });
    if (result.code !== 0) throw new Error("Local fixture SQL failed: " + (result.stderr + "\n" + result.stdout).slice(-2500));
  } finally {
    await unlink(path).catch(() => undefined);
  }
}

function uuidFor(seed) {
  const hex = createHash("md5").update(seed).digest("hex");
  const versioned = hex.slice(0, 12) + "4" + hex.slice(13, 16) + "8" + hex.slice(17);
  return versioned.slice(0, 8) + "-" + versioned.slice(8, 12) + "-" + versioned.slice(12, 16) + "-" + versioned.slice(16, 20) + "-" + versioned.slice(20);
}

function providerId(index) {
  return (BigInt("0x" + randomUUID().replaceAll("-", "").slice(0, 14)) + BigInt(index)).toString();
}

async function seedFixtures() {
  fixtureProjects = Array.from({ length: 14 }, (_, offset) => {
    const index = offset + 1;
    const projectId = uuidFor(fixtureToken + "-project-" + index);
    const repositoryId = uuidFor(fixtureToken + "-repository-" + index);
    return { index, projectId, repositoryId, slug: fixtureSlug(index), logoId: uuidFor(fixtureToken + "-logo-" + index) };
  });

  const values = fixtureProjects.map((fixture) => {
    const index = fixture.index;
    const published = index <= 12 || index === 14;
    const restricted = index === 14;
    const name = index === 13 ? "M109 " + fixtureToken + " Unpublished" : fixtureName(index);
    const summary = "A real Supabase fixture for public browser integration coverage.";
    const description = "Source-backed description for " + fixture.slug + ". " + "Detail evidence for this browser fixture. ".repeat(35) + "DETAIL-END-" + fixtureToken + "-" + index;
    const categorySlug = index <= 6 || index >= 13 ? "developer-tools" : "ai-machine-learning";
    const license = index % 2 === 1 ? "MIT" : "Apache-2.0";
    const language = index % 2 === 1 ? "TypeScript" : "Python";
    const website = index === 1 ? "https://example.test/" + fixture.slug : null;
    return "(" + [
      String(index),
      sqlLiteral(fixture.projectId),
      sqlLiteral(fixture.repositoryId),
      sqlLiteral(restricted ? "other" : "github"),
      sqlLiteral(fixture.slug),
      sqlLiteral(name),
      sqlLiteral(summary),
      sqlLiteral(description),
      website ? sqlLiteral(website) : "null",
      sqlLiteral(license),
      sqlLiteral(language),
      sqlLiteral(published ? "published" : "draft"),
      sqlLiteral(categorySlug),
      sqlLiteral(providerId(index)),
      sqlLiteral("outlist-m109-" + fixtureToken + "/repo-" + index),
      sqlLiteral("https://github.com/outlist-m109-" + fixtureToken + "/repo-" + index),
      String(index === 14 ? 10_000 : 2_000 - index),
      String(100 - index),
      restricted ? "true" : "false",
    ].join(", ") + ")";
  });

  fixtureCreated = true;
  await runSql("do $block$ begin " +
    "create temporary table m109_browser_fixtures (fixture_number integer, project_id uuid, repository_id uuid, provider text, slug text, name text, summary text, description text, website text, license text, language text, publication_status text, category_slug text, provider_id text, full_name text, canonical_url text, stars bigint, forks bigint, is_private boolean) on commit drop;\n" +
    "insert into m109_browser_fixtures values " + values.join(",\n") + ";\n" +
    "insert into public.projects (id, slug, name, summary, description, official_website_url, license_status, license_identifier, license_verified_at, quality_status, last_verified_at, publication_status, featured)\n" +
    "select project_id, slug, name, summary, description, website, 'verified_open_source', license, now(), 'verified', now(), 'draft', false from m109_browser_fixtures;\n" +
    "insert into public.repositories (id, project_id, provider, provider_repository_id, full_name, canonical_url, primary_language, stars, forks, provider_pushed_at, last_successful_sync_at, availability_status, is_private, visibility, is_disabled, source_field_states, source_observed_at, owner_login, repository_name)\n" +
    "select repository_id, project_id, provider, provider_id, full_name, canonical_url, language, stars, forks, now() - fixture_number * interval '1 minute', now() - interval '30 seconds', 'available', is_private, case when is_private then 'private' else 'public' end, false, '{\"visibility\":\"present\",\"license\":\"present\"}'::jsonb, now() - interval '1 minute', split_part(full_name, '/', 1), split_part(full_name, '/', 2) from m109_browser_fixtures;\n" +
    "insert into public.project_categories (project_id, category_id) select f.project_id, c.id from m109_browser_fixtures f join public.categories c on c.slug = f.category_slug;\n" +
    "update public.projects p set primary_repository_id = f.repository_id, publication_status = f.publication_status, published_at = case when f.publication_status = 'published' then now() - f.fixture_number * interval '1 second' else null end from m109_browser_fixtures f where p.id = f.project_id;\n" +
    "end; $block$;");
}

async function seedLogosAndTags() {
  const first = fixtureProjects[0];
  const second = fixtureProjects[1];
  const third = fixtureProjects[2];
  const officialId = first.logoId;
  const newerAvatarId = uuidFor(fixtureToken + "-newer-avatar");
  const secondAvatarId = second.logoId;
  const objects = [
    { id: officialId, projectId: first.projectId, origin: "official_site", url: "https://example.test/outlist-logo.webp", attribution: "Official project logo", primary: false, digest: "a".repeat(64), ageSeconds: 60 },
    { id: newerAvatarId, projectId: first.projectId, origin: "provider_avatar", url: "https://avatars.githubusercontent.com/u/10001", attribution: "GitHub owner avatar", primary: false, digest: "b".repeat(64), ageSeconds: 5 },
    { id: secondAvatarId, projectId: second.projectId, origin: "provider_avatar", url: "https://avatars.githubusercontent.com/u/10002", attribution: "GitHub owner avatar", primary: true, digest: "c".repeat(64), ageSeconds: 60 },
  ];
  logoPaths = objects.map((item) => item.projectId + "/" + item.id + ".webp");
  const bytes = await sharp({ create: { width: 4, height: 4, channels: 4, background: "#5468ff" } }).webp().toBuffer();
  for (const path of logoPaths) {
    const { error } = await service.storage.from("project-logos").upload(path, bytes, {
      contentType: "image/webp",
      upsert: true,
      cacheControl: "0",
    });
    if (error) throw new Error("Could not upload a local approved-logo fixture: " + error.message.slice(0, 200));
  }
  const values = objects.map((item, index) => {
    const path = logoPaths[index];
    const verifiedAt = new Date(Date.now() - item.ageSeconds * 1000).toISOString();
    return "(" + [
      sqlLiteral(item.id),
      sqlLiteral(item.projectId),
      sqlLiteral(item.url),
      sqlLiteral(path),
      sqlLiteral("image/webp"),
      sqlLiteral(item.origin),
      sqlLiteral("approved"),
      sqlLiteral(item.attribution),
      item.primary ? "true" : "false",
      sqlLiteral(verifiedAt),
      sqlLiteral(item.digest),
      "'{\"operator_action\":\"true\",\"fixture\":true}'::jsonb",
    ].join(", ") + ")";
  });
  await runSql("insert into public.project_logos (id, project_id, source_url, storage_path, media_type, origin, verification_status, attribution_text, is_primary, verified_at, content_digest, approval_provenance) values\n" + values.join(",\n"));
  await runSql("insert into public.project_logos (project_id, source_url, media_type, origin, verification_status) values " +
    "(" + sqlLiteral(third.projectId) + ", 'https://example.test/pending.png', 'image/png', 'official_site', 'pending_review'), " +
    "(" + sqlLiteral(third.projectId) + ", 'https://example.test/rejected.png', 'image/png', 'editorial', 'rejected')");

  tagSlug = "m109-" + fixtureToken + "-tag";
  const tag = await service.from("tags").upsert({ slug: tagSlug, name: "Browser fixture tag" }, { onConflict: "slug" }).select("id").single();
  if (tag.error || !tag.data) throw new Error("Could not create the local public tag fixture.");
  const attached = await service.from("project_tags").insert({ project_id: first.projectId, tag_id: tag.data.id });
  if (attached.error) throw new Error("Could not attach the local public tag fixture.");
}

async function assertDatabaseFixtures() {
  const search = await anonymous.rpc("search_public_projects", {
    p_query: "m109 " + fixtureToken,
    p_page_size: 20,
  });
  if (search.error) throw new Error("Anonymous public search fixture failed: " + search.error.message);
  check(search.data.totalCount === 12, "Only twelve safely published fixtures are visible to public search.");
  const facets = await anonymous.rpc("get_public_catalog_facets");
  if (facets.error) throw new Error("Anonymous catalog facet fixture failed: " + facets.error.message);
  check(facets.data.categoryCounts.find((item) => item.slug === "developer-tools")?.projectCount === 6, "Category counts exclude unpublished and restricted fixtures.");
  check(facets.data.categoryCounts.find((item) => item.slug === "ai-machine-learning")?.projectCount === 6, "Category counts include the second active fixture category.");
  const denied = await anonymous.from("projects").update({ name: "Unauthorized public mutation" }).eq("id", fixtureProjects[0].projectId);
  check(denied.error?.code === "42501", "Anonymous visitors cannot mutate published catalog records.");
}

function resultsSummary(page) {
  return page.locator(".filter-layout > div > div[aria-live='polite']");
}

async function expectResultCount(page, count) {
  await expect(resultsSummary(page)).toContainText("of " + count + " projects");
  checks += 1;
}

async function expectNoStore(response, route) {
  const header = response?.headers()["cache-control"] ?? "";
  check(header.includes("no-store"), route + " sends a no-store response.");
}

async function assertUnavailableState(publicKey) {
  const url = await startNext("http://127.0.0.1:1", publicKey, unavailablePort);
  const page = await browser.newPage();
  try {
    const response = await page.goto(url + "/explore");
    await expect(page.getByText("Published catalog temporarily unavailable", { exact: true })).toBeVisible();
    await expect(page.getByText("No sample projects are being shown.", { exact: false })).toBeVisible();
    check(await page.locator(".project-card").count() === 0, "Configured but unavailable Supabase renders no fabricated project cards.");
    await expectNoStore(response, "Unavailable catalog route");
  } finally {
    await page.close();
    await stopProcess(server);
    server = undefined;
  }
}

async function assertEmptyCatalog(url) {
  const page = await browser.newPage();
  try {
    const home = await page.goto(url + "/");
    await expect(page.getByText("No projects have been published yet.", { exact: false })).toBeVisible();
    await expectNoStore(home, "Empty homepage");
    const explore = await page.goto(url + "/explore");
    await expect(page.getByText("No published projects yet", { exact: true })).toBeVisible();
    await expectResultCount(page, 0);
    await expectNoStore(explore, "Empty explore route");
  } finally {
    await page.close();
  }
}

async function assertExploreAndUrlState(url) {
  const page = await browser.newPage();
  try {
    const searchUrl = url + "/explore?q=" + fixtureToken;
    const response = await page.goto(searchUrl);
    await expectResultCount(page, 12);
    await expect(page.locator(".cards-grid .project-card")).toHaveCount(9);
    await expectNoStore(response, "Explore search");

    await page.getByRole("checkbox", { name: "Filter categories by Developer Tools" }).click();
    await expect(page).toHaveURL(/category=developer-tools/);
    await expectResultCount(page, 6);
    await page.getByRole("checkbox", { name: "Filter categories by AI & Machine Learning" }).click();
    await expect(page).toHaveURL(/category=ai-machine-learning/);
    await expectResultCount(page, 12);

    await page.getByRole("checkbox", { name: "Filter licenses by MIT" }).click();
    await expectResultCount(page, 6);
    await page.getByRole("checkbox", { name: "Filter licenses by Apache-2.0" }).click();
    await expectResultCount(page, 12);

    await page.getByRole("checkbox", { name: "Filter languages by TypeScript" }).click();
    await expectResultCount(page, 6);
    await page.getByRole("checkbox", { name: "Filter languages by Python" }).click();
    await expectResultCount(page, 12);
    check(page.url().includes("q=" + fixtureToken)
      && page.url().includes("category=developer-tools")
      && page.url().includes("category=ai-machine-learning")
      && page.url().includes("license=MIT")
      && page.url().includes("license=Apache-2.0")
      && page.url().includes("language=TypeScript")
      && page.url().includes("language=Python"),
    "Combined multi-value search, category, license, and language state is encoded in the URL.");

    await page.reload();
    await expectResultCount(page, 12);
    await page.goBack();
    await expect(page).toHaveURL(/language=TypeScript/);
    await expectResultCount(page, 6);
    check(true, "Reload and browser back reproduce the prior database filter state.");

    await page.getByRole("button", { name: "Clear all" }).click();
    await expect(page).toHaveURL(url + "/explore");
    await expectResultCount(page, 12);
    check(true, "Clear filters resets URL state and restores the published catalog.");

    await page.locator("#directory-sort").selectOption("stars");
    await expect(page).toHaveURL(/sort=stars/);
    const searchResponse = await page.goto(searchUrl + "&sort=stars");
    await expectResultCount(page, 12);
    const firstHref = await page.locator(".cards-grid .project-card").first().getAttribute("href");
    check(firstHref === "/project/" + fixtureSlug(1), "Most-starred sorting uses live repository stars and canonical slugs.");

    const firstPage = await page.goto(searchUrl);
    await expectResultCount(page, 12);
    const firstPageHrefs = await page.locator(".cards-grid .project-card").evaluateAll((cards) => cards.map((card) => card.getAttribute("href")));
    await page.getByRole("button", { name: "Page 2" }).click();
    await expect(page).toHaveURL(/page=2/);
    await expectResultCount(page, 12);
    const secondPageHrefs = await page.locator(".cards-grid .project-card").evaluateAll((cards) => cards.map((card) => card.getAttribute("href")));
    check(firstPageHrefs.length === 9 && secondPageHrefs.length === 3
      && firstPageHrefs.every((href) => !secondPageHrefs.includes(href)),
    "Database pagination returns distinct project pages with an accurate total.");
    const pageTwoFirst = secondPageHrefs[0];
    const pageTwo = await page.reload();
    await expectResultCount(page, 12);
    check((await page.locator(".cards-grid .project-card").first().getAttribute("href")) === pageTwoFirst,
      "Reload preserves the selected database page.");
    await expectNoStore(firstPage, "Explore first page");
    await expectNoStore(pageTwo, "Explore second page");
    await page.goBack();
    check(page.url().includes("page=1") || !page.url().includes("page="), "Browser back returns to the prior page URL.");
    void searchResponse;
  } finally {
    await page.close();
  }
}

async function assertCategoriesAndDetails(url) {
  const page = await browser.newPage();
  try {
    const categoriesResponse = await page.goto(url + "/categories");
    await expect(page.getByRole("heading", { name: "Explore categories" })).toBeVisible();
    await expect(page.locator('a[href="/category/developer-tools"]')).toContainText("6 published projects");
    await expect(page.locator('a[href="/category/ai-machine-learning"]')).toContainText("6 published projects");
    await expectNoStore(categoriesResponse, "Categories route");

    const categoryResponse = await page.goto(url + "/category/developer-tools");
    await expect(page.getByRole("heading", { name: "Developer Tools" })).toBeVisible();
    await expect(page.getByText("6 matching projects")).toBeVisible();
    await expectNoStore(categoryResponse, "Category detail route");

    await page.goto(url + "/category/productivity");
    await expect(page.getByText("No published projects in this category yet", { exact: true })).toBeVisible();
    check(true, "An active category with no visible projects has an accurate category-specific empty state.");

    const first = fixtureProjects[0];
    const detailResponse = await page.goto(url + "/project/" + first.slug);
    await expect(page.getByRole("heading", { name: fixtureName(1) })).toBeVisible();
    await expect(page.locator(".detail-top .grow > p")).toHaveText("A real Supabase fixture for public browser integration coverage.");
    await expect(page.getByText("DETAIL-END-" + fixtureToken + "-1", { exact: false })).toBeVisible();
    await expect(page.getByText("Browser fixture tag", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Source repository", exact: false })).toHaveAttribute("href", "https://github.com/outlist-m109-" + fixtureToken + "/repo-1");
    await expect(page.getByRole("link", { name: "Official website", exact: false })).toHaveAttribute("href", "https://example.test/" + first.slug);
    await expect(page.getByText("Repository activity", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Illustrative")).toHaveCount(0);
    const officialLogo = page.locator('[data-logo-kind="official_logo"]');
    await expect(officialLogo).toBeVisible();
    check((await officialLogo.locator("img").getAttribute("src"))?.includes(first.logoId + ".webp"),
      "An approved official logo takes precedence over a newer owner avatar.");
    await expectNoStore(detailResponse, "Public project detail route");
    await page.route("**/logo-failure-test.webp", (route) => route.abort());
    await officialLogo.locator("img").evaluate((image) => {
      image.src = new URL("/logo-failure-test.webp", location.origin).toString();
    });
    await expect(page.locator(".detail-top [data-logo-kind='fallback']")).toContainText("M");
    check(true, "A failed approved image falls back to its deterministic letter.");

    await page.goto(url + "/project/" + fixtureProjects[1].slug);
    const avatar = page.locator('[data-logo-kind="provider_avatar"]');
    await expect(avatar).toBeVisible();
    await expect(avatar).toHaveClass(/avatar/);
    await expect(avatar).toHaveAttribute("aria-label", "GitHub owner avatar for " + fixtureName(2));
    await page.goto(url + "/project/" + fixtureProjects[2].slug);
    await expect(page.locator(".detail-top [data-logo-kind='fallback']")).toContainText("M");
    check(true, "Approved owner avatars are identified separately, and pending/rejected logo records use the letter fallback.");

    const unknown = await page.goto(url + "/project/not-a-real-project");
    check(unknown?.status() === 404, "Unknown project slugs return a real 404.");
    const unpublished = await page.goto(url + "/project/" + fixtureSlug(13));
    check(unpublished?.status() === 404, "Unpublished project slugs return a real 404.");
    const restricted = await page.goto(url + "/project/" + fixtureSlug(14));
    check(restricted?.status() === 404, "Restricted source projects return a real 404.");
    const unknownCategory = await page.goto(url + "/category/not-a-real-category");
    check(unknownCategory?.status() === 404, "Unknown category slugs return a real 404.");

    await page.goto(url + "/explore?q=xy");
    await expect(page.getByText("Enter at least 3 characters to search. No unrelated projects are shown.")).toBeVisible();
    await expect(page.locator(".project-card")).toHaveCount(0);
    check(true, "Two-character searches explain the three-character database minimum and show no unrelated projects.");
  } finally {
    await page.close();
  }
}

async function assertHomepageAndCommandSearch(url) {
  const page = await browser.newPage();
  try {
    const home = await page.goto(url + "/");
    await expect(page.getByText("12 published projects across 11 active categories")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Most-starred projects" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recently published" })).toBeVisible();
    await expect(page.getByText("M109 " + fixtureToken + " Unpublished", { exact: true })).toHaveCount(0);
    await expectNoStore(home, "Homepage catalog");
    check((await page.locator('.project-card[href="/project/' + fixtureSlug(1) + '"]').count()) === 1,
      "Homepage project cards link to the actual database slug.");

    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const commandInput = page.getByRole("searchbox", { name: "Search projects and categories" });
    await commandInput.fill(fixtureName(1));
    const commandProject = page.locator(".command-result").filter({ hasText: fixtureName(1) }).first();
    await expect(commandProject).toBeVisible();
    await commandProject.click();
    await expect(page).toHaveURL(url + "/project/" + fixtureSlug(1));
    check(true, "The keyboard command search returns and opens a real published Supabase project.");

    await page.keyboard.press("Control+k");
    await expect(dialog).toBeVisible();
    await page.getByRole("searchbox", { name: "Search projects and categories" }).fill("M109 " + fixtureToken + " Unpublished");
    await expect(page.getByText("No matching published projects or active categories.")).toBeVisible();
    await expect(page.locator(".command-result")).toHaveCount(0);
    check(true, "Unpublished projects are excluded from command search.");
    await page.keyboard.press("Escape");

    const submit = await page.goto(url + "/submit");
    await expect(page.getByRole("heading", { name: "Project submissions are unavailable" })).toBeVisible();
    await expect(page.getByText("No submission was created")).toBeVisible();
    await expect(page.getByRole("button", { name: "Submit for review" })).toHaveCount(0);
    await expectNoStore(submit, "Submit route");
    const alternatives = await page.goto(url + "/alternatives");
    await expect(page.getByText("Approved alternative relationships are not available yet")).toBeVisible();
    await expect(page.locator(".alt-card")).toHaveCount(0);
    await expectNoStore(alternatives, "Alternatives route");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url + "/explore?q=" + fixtureToken);
    await expect(page.getByRole("button", { name: /Filters/ })).toBeVisible();
    await page.getByRole("button", { name: /Filters/ }).click();
    await expect(page.locator("#directory-filters")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Filter categories by Developer Tools" })).toBeVisible();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    check(width <= 390, "Search, filters, and project cards fit a 390px mobile viewport without horizontal overflow.");

    await page.getByRole("button", { name: "Toggle navigation" }).click();
    const mobileSearch = page.locator(".mobile-nav.open button");
    await expect(mobileSearch).toBeVisible();
    await mobileSearch.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    check(true, "Mobile navigation exposes the live command search and filter controls.");
  } finally {
    await page.close();
  }
}

async function assertSafetyDemotion(url) {
  const first = fixtureProjects[0];
  await runSql("update public.projects set publication_status = 'pending_review' where id = " + sqlLiteral(first.projectId));
  const page = await browser.newPage();
  try {
    const home = await page.goto(url + "/");
    await expect(page.getByText(fixtureName(1), { exact: true })).toHaveCount(0);
    await expectNoStore(home, "Homepage after safety demotion");
    const search = await page.goto(url + "/explore?q=" + fixtureToken);
    await expectResultCount(page, 11);
    const demotedCardPresent = await page.locator(".project-card").evaluateAll((cards, slug) =>
      cards.some((card) => card.getAttribute("href") === "/project/" + slug), first.slug);
    check(!demotedCardPresent, "The demoted project is removed from live search results.");
    await expectNoStore(search, "Search after safety demotion");
    const detail = await page.goto(url + "/project/" + first.slug);
    check(detail?.status() === 404, "A newly demoted project is hidden on the next detail request despite prior reads.");
    await expectNoStore(detail, "Demoted project detail");
    check(true, "No cached homepage, search, or detail response retains the safety-demoted project.");
  } finally {
    await page.close();
  }
}

async function ensureNoSecretInClientAssets(secret) {
  const staticDirs = [join(root, ".next", "dev", "static"), join(root, ".next", "static")];
  const existingStaticDirs = [];
  const { stat } = await import("node:fs/promises");
  for (const path of staticDirs) {
    try {
      if ((await stat(path)).isDirectory()) existingStaticDirs.push(path);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  if (existingStaticDirs.length === 0) throw new Error("Next.js did not produce a client-asset directory to inspect.");
  const visit = async (path) => {
    const { readdir, readFile, stat } = await import("node:fs/promises");
    const entries = await readdir(path);
    for (const name of entries) {
      const child = join(path, name);
      const details = await stat(child);
      if (details.isDirectory()) await visit(child);
      else if ((await readFile(child)).includes(Buffer.from(secret))) {
        throw new Error("The Supabase service-role credential appeared in a browser asset.");
      }
    }
  };
  for (const path of existingStaticDirs) await visit(path);
  checks += 1;
}

async function cleanupFixtures() {
  if (!service) return;
  if (logoPaths.length > 0) await service.storage.from("project-logos").remove(logoPaths).catch(() => undefined);
  if (fixtureCreated && fixtureProjects.length > 0) {
    const ids = fixtureProjects.map((item) => item.projectId);
    await service.from("projects").delete().in("id", ids);
    if (tagSlug) await service.from("tags").delete().eq("slug", tagSlug);
  }
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publicKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  assert.ok(url && publicKey && serviceKey, "The public frontend suite requires the local Supabase URL and disposable local keys.");
  const config = new URL(url);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(config.hostname), "Public frontend fixtures must target local Supabase only.");
  service = createClient(url, serviceKey, { auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false } });
  anonymous = createClient(url, publicKey, { auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false } });
  browser = await chromium.launch({ headless: true });
  try {
    await assertUnavailableState(publicKey);
    const appUrl = await startNext(url, publicKey, basePort);
    await assertEmptyCatalog(appUrl);
    await seedFixtures();
    await seedLogosAndTags();
    await assertDatabaseFixtures();
    await assertExploreAndUrlState(appUrl);
    await assertCategoriesAndDetails(appUrl);
    await assertHomepageAndCommandSearch(appUrl);
    await assertSafetyDemotion(appUrl);
    await ensureNoSecretInClientAssets(serviceKey);
    process.stdout.write(JSON.stringify({
      status: "passed",
      assertions: checks,
      publishedFixtures: 12,
      unpublishedFixtures: 1,
      restrictedFixtures: 1,
      localSupabaseOnly: true,
      serviceRoleInClientAssets: false,
      routes: ["/", "/explore", "/categories", "/category/[slug]", "/project/[slug]", "/alternatives", "/submit"],
    }) + "\n");
  } catch (error) {
    const diagnostics = server?.logs.split(/\r?\n/).filter((line) => /error|exception|failed|invalid/i.test(line)).slice(-30) ?? [];
    if (diagnostics.length > 0) process.stderr.write("Public frontend diagnostics:\n" + diagnostics.join("\n") + "\n");
    throw error;
  } finally {
    await cleanupFixtures();
    await stopProcess(server);
    await browser?.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

await main();
