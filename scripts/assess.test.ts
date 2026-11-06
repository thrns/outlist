import { describe, expect, it, vi } from "vitest";
import { parseAssessmentArguments, runAssessmentCli, type AssessmentCliDependencies } from "./assess";

describe("assessment CLI", () => {
  it("defaults to a mutation-free dry run", async () => {
    const rpc = vi.fn(); const lines: string[] = [];
    const status = await runAssessmentCli([], { supabase: { rpc, from: vi.fn() } as unknown as AssessmentCliDependencies["supabase"], writeStdout: (line) => lines.push(line) });
    expect(status).toBe(0); expect(rpc).not.toHaveBeenCalled(); expect(lines.join("")).toContain('"mode": "dry-run"');
  });
  it("parses bounded execution options", () => {
    expect(parseAssessmentArguments(["--execute", "--resume", "--max-repositories", "5"])).toMatchObject({ mode: "execute", resume: true, maxRepositories: 5 });
  });
  it("rejects an unbounded repository limit", () => {
    expect(() => parseAssessmentArguments(["--execute", "--max-repositories", "101"])).toThrow();
  });
  it("requires execute mode to resume", () => {
    expect(() => parseAssessmentArguments(["--resume"])).toThrow();
  });
});
