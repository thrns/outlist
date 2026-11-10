import { describe, expect, it } from "vitest";
import { parseCatalogImportArguments } from "./catalog-import";

describe("catalog importer CLI arguments", () => {
  it("defaults to a dry-run of the supplied archive without database configuration", () => {
    expect(parseCatalogImportArguments([])).toMatchObject({
      mode: "dry-run", archivePath: ".catalog-input/catalog.zip", resume: false,
      maxBatches: 1, allowHostedWrites: false,
    });
  });

  it("requires explicit hosted-write flags and an environment", () => {
    expect(parseCatalogImportArguments([
      "--execute", "--environment", "production", "--allow-hosted-writes", "--confirm-project-ref", "outlist-prod",
    ])).toMatchObject({ mode: "execute", environment: "production", confirmProjectRef: "outlist-prod", allowHostedWrites: true });
    expect(() => parseCatalogImportArguments(["--execute", "--confirm-project-ref", "outlist-prod"]))
      .toThrow("both --allow-hosted-writes and --confirm-project-ref");
    expect(() => parseCatalogImportArguments(["--execute", "--allow-hosted-writes", "--confirm-project-ref", "outlist-prod"]))
      .not.toThrow();
  });

  it("requires resume to accompany execute and bounds batch work", () => {
    expect(() => parseCatalogImportArguments(["--resume"])).toThrow("--resume requires --execute");
    expect(() => parseCatalogImportArguments(["--execute", "--max-batches", "39"])).toThrow("from 1 to 38");
    expect(parseCatalogImportArguments(["--resume", "--execute", "--max-batches", "2"]))
      .toMatchObject({ resume: true, maxBatches: 2 });
  });

  it("rejects mixed modes and write flags on non-execution paths", () => {
    expect(() => parseCatalogImportArguments(["--validate", "--dry-run"])).toThrow("Choose exactly one");
    expect(() => parseCatalogImportArguments(["--dry-run", "--allow-hosted-writes", "--confirm-project-ref", "outlist-prod"]))
      .toThrow("only valid with --execute");
  });
});
