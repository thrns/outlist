import { createHash } from "node:crypto";
import type { GitHubSearchOrder, GitHubSearchSort } from "@/lib/github/types";

export const INITIAL_PLAN_NAME = "initial" as const;
export const INITIAL_PLAN_VERSION = "initial-v1" as const;
export const SEARCH_PAGE_SIZE = 100 as const;
export const SEARCH_RESULT_WINDOW = 1_000 as const;

export interface DateRange {
  start: string;
  end: string;
}

export interface DiscoveryPartition {
  partitionKey: string;
  provider: "github";
  queryText: string;
  parameters: {
    sort: GitHubSearchSort;
    order: GitHubSearchOrder;
    perPage: number;
  };
  dateRange: DateRange;
  planVersion: string;
  intendedCoverage: string;
  fingerprint: string;
  parentKey?: string;
}

const TOPIC_GROUPS = [
  { key: "developer-tools", topic: "developer-tools", label: "public developer tool repositories" },
  { key: "self-hosted", topic: "self-hosted", label: "public self-hosted software repositories" },
  { key: "ai-machine-learning", topic: "ai-machine-learning", label: "public AI and machine-learning repositories" },
] as const;

const LANGUAGE_GROUPS = [
  { key: "typescript", language: "TypeScript", label: "public TypeScript repositories" },
  { key: "python", language: "Python", label: "public Python repositories" },
] as const;

const BASE_DATE_RANGE: DateRange = { start: "2020-01-01", end: "2026-11-05" };

export function getDiscoveryPlan(name: string): DiscoveryPartition[] {
  if (name !== INITIAL_PLAN_NAME) throw new TypeError(`Unsupported discovery plan: ${name}.`);
  const topicPartitions = TOPIC_GROUPS.flatMap((group) => [
    createPartition({
      partitionKey: `github.initial.${group.key}.stars-0-99`,
      queryText: `topic:${group.topic} is:public fork:false stars:0..99 created:${BASE_DATE_RANGE.start}..${BASE_DATE_RANGE.end}`,
      dateRange: BASE_DATE_RANGE,
      intendedCoverage: `${group.label} created from ${BASE_DATE_RANGE.start} through ${BASE_DATE_RANGE.end} with 0–99 stars.`,
    }),
    createPartition({
      partitionKey: `github.initial.${group.key}.stars-100-plus`,
      queryText: `topic:${group.topic} is:public fork:false stars:>=100 created:${BASE_DATE_RANGE.start}..${BASE_DATE_RANGE.end}`,
      dateRange: BASE_DATE_RANGE,
      intendedCoverage: `${group.label} created from ${BASE_DATE_RANGE.start} through ${BASE_DATE_RANGE.end} with at least 100 stars.`,
    }),
  ]);
  const languagePartitions = LANGUAGE_GROUPS.flatMap((group) => [
    createPartition({
      partitionKey: `github.initial.language-${group.key}.stars-0-99`,
      queryText: `language:${group.language} is:public fork:false stars:0..99 created:${BASE_DATE_RANGE.start}..${BASE_DATE_RANGE.end}`,
      dateRange: BASE_DATE_RANGE,
      intendedCoverage: `${group.label} created from ${BASE_DATE_RANGE.start} through ${BASE_DATE_RANGE.end} with 0–99 stars.`,
    }),
    createPartition({
      partitionKey: `github.initial.language-${group.key}.stars-100-plus`,
      queryText: `language:${group.language} is:public fork:false stars:>=100 created:${BASE_DATE_RANGE.start}..${BASE_DATE_RANGE.end}`,
      dateRange: BASE_DATE_RANGE,
      intendedCoverage: `${group.label} created from ${BASE_DATE_RANGE.start} through ${BASE_DATE_RANGE.end} with at least 100 stars.`,
    }),
  ]);
  return [...topicPartitions, ...languagePartitions];
}

export function splitSaturatedPartition(partition: DiscoveryPartition): [DiscoveryPartition, DiscoveryPartition] | null {
  const startTime = Date.parse(`${partition.dateRange.start}T00:00:00.000Z`);
  const endTime = Date.parse(`${partition.dateRange.end}T00:00:00.000Z`);
  const dayMs = 86_400_000;
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime - startTime < dayMs) return null;

  const midpoint = Math.floor(((startTime + endTime) / 2) / dayMs) * dayMs;
  const leftEnd = new Date(midpoint).toISOString().slice(0, 10);
  const rightStart = new Date(midpoint + dayMs).toISOString().slice(0, 10);
  const leftRange = { start: partition.dateRange.start, end: leftEnd };
  const rightRange = { start: rightStart, end: partition.dateRange.end };
  const replaceRange = (range: DateRange) => partition.queryText.replace(
    /created:\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}/,
    `created:${range.start}..${range.end}`,
  );
  if (leftRange.start > leftRange.end || rightRange.start > rightRange.end) return null;

  return [
    createPartition({
      ...partition,
      partitionKey: `${partition.partitionKey}.created-${leftRange.start}-${leftRange.end}`,
      queryText: replaceRange(leftRange),
      dateRange: leftRange,
      parentKey: partition.partitionKey,
      intendedCoverage: `${partition.intendedCoverage} Split range ${leftRange.start} through ${leftRange.end}.`,
    }),
    createPartition({
      ...partition,
      partitionKey: `${partition.partitionKey}.created-${rightRange.start}-${rightRange.end}`,
      queryText: replaceRange(rightRange),
      dateRange: rightRange,
      parentKey: partition.partitionKey,
      intendedCoverage: `${partition.intendedCoverage} Split range ${rightRange.start} through ${rightRange.end}.`,
    }),
  ];
}

export function needsPartitionSplit(totalCount: number, incompleteResults: boolean): boolean {
  return incompleteResults || totalCount > SEARCH_RESULT_WINDOW;
}

export function calculatePartitionFingerprint(partition: Pick<DiscoveryPartition, "provider" | "queryText" | "parameters" | "planVersion">): string {
  const stable = JSON.stringify({
    provider: partition.provider,
    queryText: partition.queryText,
    parameters: {
      sort: partition.parameters.sort,
      order: partition.parameters.order,
      perPage: partition.parameters.perPage,
    },
    planVersion: partition.planVersion,
  });
  return createHash("sha256").update(stable).digest("hex");
}

function createPartition(input: Omit<DiscoveryPartition, "provider" | "parameters" | "planVersion" | "fingerprint"> & Partial<Pick<DiscoveryPartition, "provider" | "parameters" | "planVersion" | "fingerprint">>): DiscoveryPartition {
  const partition: DiscoveryPartition = {
    provider: input.provider ?? "github",
    parameters: input.parameters ?? { sort: "stars", order: "desc", perPage: SEARCH_PAGE_SIZE },
    planVersion: input.planVersion ?? INITIAL_PLAN_VERSION,
    partitionKey: input.partitionKey,
    queryText: input.queryText,
    dateRange: input.dateRange,
    intendedCoverage: input.intendedCoverage,
    ...(input.parentKey ? { parentKey: input.parentKey } : {}),
    fingerprint: "",
  };
  partition.fingerprint = calculatePartitionFingerprint(partition);
  return partition;
}
