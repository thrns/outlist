import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createGitHubClient } from "../src/lib/github/client";
import { validateSupabaseAdminEnv } from "../src/lib/env/admin";
import { createSupabaseAdminClient } from "../src/lib/supabase/admin";
import { validateCatalogArchive, publicValidationReport } from "../src/lib/catalog-import/archive";
import { catalogStatusResult, executeCatalogImport, makeOfflineImportReport, type CatalogImportDatabase } from "../src/lib/catalog-import/runner";

const USAGE = `Usage:
  bun run catalog:import -- --validate [--archive .catalog-input/catalog.zip] [--report PATH]
  bun run catalog:import -- --dry-run [--archive .catalog-input/catalog.zip] [--report PATH]
  bun run catalog:import -- --execute [--max-batches 1] [--report PATH]
  bun run catalog:import -- --resume --execute [--max-batches 1] [--report PATH]
  bun run catalog:import -- --status

Hosted writes require --environment staging|production, --allow-hosted-writes,
and --confirm-project-ref matching the configured Supabase URL. Local writes
require the Supabase URL to point to localhost. The importer never publishes.
`;

export type CatalogImportArguments = {
  mode: "validate" | "dry-run" | "execute" | "status";
  archivePath: string;
  reportPath?: string;
  resume: boolean;
  maxBatches: number;
  environment?: "local" | "development" | "staging" | "production";
  allowHostedWrites: boolean;
  confirmProjectRef?: string;
  help: boolean;
};

export function parseCatalogImportArguments(args: string[]): CatalogImportArguments {
  const modes: CatalogImportArguments["mode"][] = [];
  let archivePath = ".catalog-input/catalog.zip";
  let reportPath: string | undefined;
  let resume = false;
  let maxBatches = 1;
  let environment: CatalogImportArguments["environment"];
  let allowHostedWrites = false;
  let confirmProjectRef: string | undefined;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") help = true;
    else if (["--validate", "--dry-run", "--execute", "--status"].includes(arg)) {
      modes.push(arg.slice(2) as CatalogImportArguments["mode"]);
    } else if (arg === "--archive" || arg === "--report" || arg === "--environment" || arg === "--confirm-project-ref" || arg === "--max-batches") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new TypeError(`${arg} requires a value.`);
      index += 1;
      if (arg === "--archive") archivePath = value;
      else if (arg === "--report") reportPath = value;
      else if (arg === "--environment") {
        if (!["local", "development", "staging", "production"].includes(value)) throw new TypeError("--environment must be local, development, staging, or production.");
        environment = value as CatalogImportArguments["environment"];
      } else if (arg === "--confirm-project-ref") {
        if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(value)) throw new TypeError("--confirm-project-ref must be a Supabase project reference.");
        confirmProjectRef = value;
      } else {
        if (!/^\d+$/.test(value)) throw new TypeError("--max-batches must be a positive integer.");
        maxBatches = Number(value);
        if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 38) throw new TypeError("--max-batches must be from 1 to 38.");
      }
    } else if (arg === "--resume") resume = true;
    else if (arg === "--allow-hosted-writes") allowHostedWrites = true;
    else throw new TypeError(`Unknown catalog import option: ${arg}.`);
  }
  if (modes.length > 1) throw new TypeError("Choose exactly one catalog import mode.");
  const mode = modes[0] ?? "dry-run";
  if (resume && mode !== "execute") throw new TypeError("--resume requires --execute.");
  if (mode === "status" && (resume || reportPath || environment || allowHostedWrites || confirmProjectRef || maxBatches !== 1 || archivePath !== ".catalog-input/catalog.zip")) {
    throw new TypeError("--status does not accept archive, report, resume, environment, confirmation, or batch options.");
  }
  if (mode !== "execute" && (allowHostedWrites || confirmProjectRef || environment)) {
    throw new TypeError("Write confirmation options are only valid with --execute.");
  }
  if (allowHostedWrites !== Boolean(confirmProjectRef)) {
    throw new TypeError("Hosted writes require both --allow-hosted-writes and --confirm-project-ref.");
  }
  return { mode, archivePath, reportPath, resume, maxBatches, environment, allowHostedWrites, confirmProjectRef, help };
}

type Target = { kind: "local" | "hosted" | "remote_unknown"; projectRef: string | null };

function classifyTarget(urlValue: string): Target {
  const url = new URL(urlValue);
  const host = url.hostname.toLowerCase();
  if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) return { kind: "local", projectRef: null };
  if (host.endsWith(".supabase.co")) return { kind: "hosted", projectRef: host.split(".")[0] ?? null };
  return { kind: "remote_unknown", projectRef: null };
}

function checkWriteTarget(args: CatalogImportArguments, url: string): { projectRef: string; environment: string } {
  const target = classifyTarget(url);
  if (target.kind === "local") {
    if (args.environment && !["local", "development"].includes(args.environment)) {
      throw new TypeError("The configured Supabase URL is local but --environment names a hosted target.");
    }
    if (args.allowHostedWrites || args.confirmProjectRef) throw new TypeError("Hosted-write flags cannot be used for a local Supabase URL.");
    return { projectRef: "local", environment: args.environment ?? "local" };
  }
  if (target.kind !== "hosted" || !target.projectRef) {
    throw new TypeError("Writes are blocked for custom or unclassified remote Supabase hosts.");
  }
  if (!args.allowHostedWrites || !args.confirmProjectRef) {
    throw new TypeError("Remote writes are blocked unless --allow-hosted-writes and --confirm-project-ref are supplied.");
  }
  if (!args.environment || !["staging", "production"].includes(args.environment)) {
    throw new TypeError("Hosted writes require an explicit --environment staging or --environment production.");
  }
  if (args.confirmProjectRef !== target.projectRef) {
    throw new TypeError("The confirmed project reference does not match the configured Supabase URL.");
  }
  const configuredEnvironment = process.env.OUTLIST_SUPABASE_ENVIRONMENT?.trim().toLowerCase();
  if (configuredEnvironment && configuredEnvironment !== args.environment) {
    throw new TypeError("--environment does not match OUTLIST_SUPABASE_ENVIRONMENT.");
  }
  return { projectRef: target.projectRef, environment: args.environment };
}

async function writeJsonAtomically(path: string, report: unknown): Promise<void> {
  const outputPath = resolve(path);
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporaryPath, outputPath);
}

function summaryReport(report: ReturnType<typeof makeOfflineImportReport>) {
  return Object.fromEntries(Object.entries(report).filter(([key]) => key !== "review_records"));
}

export async function runCatalogImportCli(args: string[], dependencies: {
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
} = {}): Promise<number> {
  const stdout = dependencies.writeStdout ?? ((text: string) => process.stdout.write(text));
  const stderr = dependencies.writeStderr ?? ((text: string) => process.stderr.write(text));
  let parsed: CatalogImportArguments;
  try { parsed = parseCatalogImportArguments(args); }
  catch (error) {
    stderr(`${JSON.stringify({ event: "catalog_import_failure", stage: "arguments", message: error instanceof Error ? error.message : "Invalid arguments." })}\n${USAGE}\n`);
    return 2;
  }
  if (parsed.help) { stdout(`${USAGE}\n`); return 0; }

  if (parsed.mode === "status") {
    try {
      const database = createSupabaseAdminClient() as unknown as CatalogImportDatabase;
      const result = await catalogStatusResult(database);
      if (result.error) throw new Error(result.error.code ? `Catalog status query failed (${result.error.code}).` : "Catalog status query failed.");
      stdout(`${JSON.stringify({ event: "catalog_import_status", status: result.data }, null, 2)}\n`);
      return 0;
    } catch {
      stderr(`${JSON.stringify({ event: "catalog_import_failure", stage: "status", message: "Could not read catalog import progress; credentials were not displayed." })}\n`);
      return 1;
    }
  }

  try {
    const validation = await validateCatalogArchive(parsed.archivePath);
    if (parsed.mode === "validate") {
      const report = publicValidationReport(validation);
      if (parsed.reportPath) await writeJsonAtomically(parsed.reportPath, report);
      stdout(`${JSON.stringify({ event: "catalog_archive_validation", ...report }, null, 2)}\n`);
      return validation.valid ? 0 : 1;
    }
    if (!validation.valid) {
      const report = { event: "catalog_import_blocked", archive_validation: publicValidationReport(validation) };
      if (parsed.reportPath) await writeJsonAtomically(parsed.reportPath, report);
      stdout(`${JSON.stringify(report, null, 2)}\n`);
      return 1;
    }
    if (parsed.mode === "dry-run") {
      const report = makeOfflineImportReport(validation);
      if (parsed.reportPath) await writeJsonAtomically(parsed.reportPath, report);
      stdout(`${JSON.stringify({ event: "catalog_import_dry_run", ...summaryReport(report) }, null, 2)}\n`);
      return 0;
    }

    const env = validateSupabaseAdminEnv({
      url: process.env.NEXT_PUBLIC_SUPABASE_URL,
      secretKey: process.env.SUPABASE_SECRET_KEY,
    });
    const target = checkWriteTarget(parsed, env.url);
    const report = await executeCatalogImport(validation, {
      mode: "execute",
      resume: parsed.resume,
      maxBatches: parsed.maxBatches,
      environment: target.environment,
      projectRef: target.projectRef,
      reportPath: parsed.reportPath,
    }, {
      database: createSupabaseAdminClient() as unknown as CatalogImportDatabase,
      github: createGitHubClient(),
      writeReport: writeJsonAtomically,
    });
    stdout(`${JSON.stringify({ event: "catalog_import_execution", ...summaryReport(report) }, null, 2)}\n`);
    return 0;
  } catch (error) {
    const report = error && typeof error === "object" && "report" in error
      ? (error as { report: unknown }).report : null;
    if (parsed.reportPath && report) {
      try { await writeJsonAtomically(parsed.reportPath, report); } catch { /* Preserve the primary failure. */ }
    }
    stderr(`${JSON.stringify({ event: "catalog_import_failure", stage: "execution", message: error instanceof Error ? error.message : "Catalog import failed.", report_path: parsed.reportPath ?? null })}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(await runCatalogImportCli(process.argv.slice(2)));
