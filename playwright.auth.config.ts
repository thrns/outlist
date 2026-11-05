import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const browserEnv: Record<string, string> = {};
for (const name of [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "CI",
  "LANG",
  "LC_ALL",
  "PLAYWRIGHT_BROWSERS_PATH",
]) {
  const value = process.env[name];
  if (value) browserEnv[name] = value;
}

export default defineConfig({
  testDir: "./e2e/auth",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: "line",
  outputDir:
    process.env.AUTH_E2E_OUTPUT_DIR ??
    join(tmpdir(), `outlist-auth-e2e-results-${process.pid}`),
  use: {
    baseURL: process.env.AUTH_E2E_BASE_URL ?? "http://127.0.0.1:3187",
    browserName: "chromium",
    headless: true,
    screenshot: "off",
    video: "off",
    trace: "off",
    launchOptions: { env: browserEnv },
  },
});
