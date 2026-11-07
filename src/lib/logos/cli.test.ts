import { describe, expect, it } from "vitest";
import { parseLogoArguments } from "../../../scripts/logos";

describe("logo CLI arguments", () => {
  it("defaults discovery to dry-run and accepts a bounded explicit execution", () => {
    expect(parseLogoArguments(["--discover"])).toMatchObject({ action: "discover", execute: false, maxProjects: 10 });
    expect(parseLogoArguments(["--discover", "--dry-run", "--max-projects", "25"])).toMatchObject({ action: "discover", execute: false, maxProjects: 25 });
    expect(parseLogoArguments(["--discover", "--execute", "--max-projects", "3"])).toMatchObject({ action: "discover", execute: true, maxProjects: 3 });
  });

  it("rejects contradictory, unbounded, and untrusted operation options", () => {
    expect(() => parseLogoArguments(["--discover", "--execute", "--dry-run"])).toThrow(/either/i);
    expect(() => parseLogoArguments(["--discover", "--max-projects", "26"])).toThrow(/max-projects/i);
    expect(() => parseLogoArguments(["--approve", "22222222-2222-4222-8222-222222222222"])).toThrow(/exactly one/i);
    expect(() => parseLogoArguments(["--approve", "22222222-2222-4222-8222-222222222222", "--avatar-source", "--local-file", "logo.png"])).toThrow(/exactly one/i);
    expect(() => parseLogoArguments(["--reject", "22222222-2222-4222-8222-222222222222"])).toThrow(/execute/i);
    expect(() => parseLogoArguments(["--register-official", "--project-id", "11111111-1111-4111-8111-111111111111", "--source-url", "https://example.com/logo.png", "--attribution", "Official"])).toThrow(/execute/i);
    expect(() => parseLogoArguments(["--reconcile", "22222222-2222-4222-8222-222222222222", "--avatar-source", "--local-file", "logo.png"])).toThrow(/only one/i);
  });

  it("requires a stable logo UUID for all candidate operations", () => {
    expect(() => parseLogoArguments(["--approve", "anything", "--avatar-source"])).toThrow(/UUID/i);
    expect(parseLogoArguments(["--approve", "22222222-2222-4222-8222-222222222222", "--local-file", "/tmp/logo.png"]))
      .toMatchObject({ action: "approve", logoId: "22222222-2222-4222-8222-222222222222", localFile: "/tmp/logo.png" });
  });
});
