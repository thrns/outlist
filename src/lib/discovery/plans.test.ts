import { describe, expect, it } from "vitest";
import {
  calculatePartitionFingerprint,
  getDiscoveryPlan,
  needsPartitionSplit,
  splitSaturatedPartition,
} from "./plans";

describe("GitHub discovery plans", () => {
  it("builds a small deterministic set of approved, bounded topic and language partitions", () => {
    const first = getDiscoveryPlan("initial");
    const second = getDiscoveryPlan("initial");
    expect(first).toHaveLength(10);
    expect(first.map((partition) => partition.partitionKey)).toEqual(second.map((partition) => partition.partitionKey));
    expect(first.map((partition) => partition.fingerprint)).toEqual(second.map((partition) => partition.fingerprint));
    expect(first.every((partition) => partition.provider === "github" && partition.parameters.perPage === 100)).toBe(true);
    expect(first.every((partition) => partition.queryText.includes("is:public") && partition.queryText.includes("fork:false"))).toBe(true);
    expect(first.some((partition) => partition.queryText.includes("topic:"))).toBe(true);
    expect(first.some((partition) => partition.queryText.includes("language:"))).toBe(true);
    expect(first.every((partition) => partition.queryText.includes("stars:") && partition.queryText.includes("created:"))).toBe(true);
    expect(new Set(first.map((partition) => partition.partitionKey)).size).toBe(first.length);
  });

  it("preserves the ten registered initial-plan fingerprints and page size", () => {
    const plan = getDiscoveryPlan("initial");
    expect(plan.map(({ partitionKey, fingerprint }) => [partitionKey, fingerprint])).toEqual([
      ["github.initial.developer-tools.stars-0-99", "6761b0abd19f91b1f2ee8dd1dc807872efef02d742e50f683e72db02efcd414b"],
      ["github.initial.developer-tools.stars-100-plus", "67ddfe5280a5c7df2789a020772542e7a9927db846be86f4ba1c5a45ef2c1d03"],
      ["github.initial.self-hosted.stars-0-99", "784e30ae02426f8e54592a44ee43bdf23486a1ea76c8ab89cb4cd063a725df55"],
      ["github.initial.self-hosted.stars-100-plus", "df16ca1f90898cc5ee0c2c9ed29924706e4b689ae2b76d337b6ea30e39d1af08"],
      ["github.initial.ai-machine-learning.stars-0-99", "9978e87708687c27d4bc59745d76beff3116fc63199429da36c7d08d08a558d7"],
      ["github.initial.ai-machine-learning.stars-100-plus", "99dd9fbf3c3d4b99f49967f35d2afb6d40fb1c874596bf96df1deec0d7f92b98"],
      ["github.initial.language-typescript.stars-0-99", "ee0980246d56f273643cff1f6acaff9ae48e8fdc57f599fa65f9849b495203dd"],
      ["github.initial.language-typescript.stars-100-plus", "a3a285b52d2a14fed4dc843daf88e26e197e67e7f9b144bb2a555b3cdd8f096b"],
      ["github.initial.language-python.stars-0-99", "46632808d5a756270917404617dae2078f26d4eec8ce8247221d9504445674ad"],
      ["github.initial.language-python.stars-100-plus", "1f442e0be4643905612bba8df0de58f9a51a39f5e7f3ba1e08dadb40438265b5"],
    ]);
    expect(plan.every((partition) => partition.parameters.perPage === 100)).toBe(true);
  });

  it("detects over-window and timed-out partitions for splitting or review", () => {
    expect(needsPartitionSplit(1_001, false)).toBe(true);
    expect(needsPartitionSplit(250, true)).toBe(true);
    expect(needsPartitionSplit(1_000, false)).toBe(false);
  });

  it("splits date ranges into adjacent non-overlapping partitions with stable fingerprints", () => {
    const parent = getDiscoveryPlan("initial")[0];
    const children = splitSaturatedPartition(parent);
    expect(children).not.toBeNull();
    if (!children) return;
    const [left, right] = children;
    expect(left.dateRange.start).toBe(parent.dateRange.start);
    expect(new Date(Date.parse(`${left.dateRange.end}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10))
      .toBe(right.dateRange.start);
    expect(right.dateRange.end).toBe(parent.dateRange.end);
    expect(left.queryText).toContain(`created:${left.dateRange.start}..${left.dateRange.end}`);
    expect(right.queryText).toContain(`created:${right.dateRange.start}..${right.dateRange.end}`);
    expect(left.fingerprint).toBe(calculatePartitionFingerprint(left));
    expect(left.fingerprint).not.toBe(right.fingerprint);
    expect(left.parentKey).toBe(parent.partitionKey);
    expect(right.parentKey).toBe(parent.partitionKey);
  });

  it("requires review when a saturated date range cannot be split safely", () => {
    const parent = getDiscoveryPlan("initial")[0];
    expect(splitSaturatedPartition({ ...parent, dateRange: { start: "2026-11-05", end: "2026-11-05" } })).toBeNull();
  });

  it("rejects unknown plans instead of producing an open-ended crawl", () => {
    expect(() => getDiscoveryPlan("everything")).toThrow(/Unsupported discovery plan/);
  });
});
