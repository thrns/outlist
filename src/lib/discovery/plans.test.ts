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
