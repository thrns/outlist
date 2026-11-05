import { z } from "zod";

const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();
const nullableDate = z.iso.datetime().nullable();
const httpsUrl = z.url({ protocol: /^https$/ });

export const githubLicenseSchema = z.object({
  key: z.string(),
  name: z.string(),
  spdx_id: z.string().nullable().optional(),
  url: httpsUrl.nullable().optional(),
  html_url: httpsUrl.nullable().optional(),
  node_id: z.string().optional(),
});

export const githubRepositorySchema = z.object({
  id: positiveInteger,
  node_id: z.string().min(1),
  name: z.string().min(1),
  full_name: z.string().min(3),
  owner: z.object({
    id: positiveInteger,
    node_id: z.string().min(1),
    login: z.string().min(1),
    type: z.string().optional(),
  }),
  html_url: httpsUrl,
  url: httpsUrl,
  description: z.string().nullable().optional(),
  homepage: z.string().nullable().optional(),
  topics: z.array(z.string()).optional(),
  language: z.string().nullable().optional(),
  stargazers_count: nonNegativeInteger,
  forks_count: nonNegativeInteger,
  watchers_count: nonNegativeInteger,
  open_issues_count: nonNegativeInteger,
  archived: z.boolean(),
  disabled: z.boolean(),
  fork: z.boolean(),
  private: z.boolean(),
  visibility: z.string().optional(),
  default_branch: z.string().optional(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  pushed_at: nullableDate.optional(),
  license: githubLicenseSchema.nullable().optional(),
});

export const githubLanguagesSchema = z.record(z.string(), nonNegativeInteger);
export const githubTopicsSchema = z.object({ names: z.array(z.string()) });

export const githubLicenseResponseSchema = z.object({
  license: githubLicenseSchema,
});

export const githubReleaseSchema = z.object({
  id: positiveInteger,
  node_id: z.string().min(1),
  tag_name: z.string().min(1),
  name: z.string().nullable().optional(),
  url: httpsUrl,
  html_url: httpsUrl,
  created_at: z.iso.datetime(),
  published_at: nullableDate.optional(),
  draft: z.boolean(),
  prerelease: z.boolean(),
});

export const githubReleaseListSchema = z.array(githubReleaseSchema);

const rateSchema = z.object({
  limit: nonNegativeInteger,
  remaining: nonNegativeInteger,
  reset: nonNegativeInteger,
  used: nonNegativeInteger,
});

export const githubRateLimitSchema = z.object({
  resources: z.record(z.string(), rateSchema),
  rate: rateSchema,
});

export type GitHubRepositoryPayload = z.infer<typeof githubRepositorySchema>;
export type GitHubLicensePayload = z.infer<typeof githubLicenseSchema>;
export type GitHubReleasePayload = z.infer<typeof githubReleaseSchema>;
