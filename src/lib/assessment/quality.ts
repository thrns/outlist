import { z } from "zod";

export const QUALITY_POLICY_VERSION = "outlist-source-quality-v1" as const;
const inputSchema = z.object({
  provider: z.literal("github"), providerRepositoryId: z.string().regex(/^[1-9][0-9]{0,18}$/),
  fullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/), canonicalUrl: z.url({ protocol: /^https$/ }),
  availabilityStatus: z.enum(["unknown", "available", "temporarily_unavailable", "not_found", "access_restricted", "removed"]),
  visibility: z.string().nullable(), isPrivate: z.boolean().nullable(), isDisabled: z.boolean().nullable(),
  isArchived: z.boolean(), isFork: z.boolean(), description: z.string().nullable(), descriptionState: z.string(),
  providerCreatedAt: z.iso.datetime({ offset: true }).nullable(), providerUpdatedAt: z.iso.datetime({ offset: true }).nullable(), providerPushedAt: z.iso.datetime({ offset: true }).nullable(),
  observedAt: z.iso.datetime({ offset: true }).nullable(), enrichedAt: z.iso.datetime({ offset: true }).nullable(), enrichmentComplete: z.boolean(),
  releaseCount: z.number().int().nonnegative(), stars: z.number().int().nonnegative(), forks: z.number().int().nonnegative(),
  licenseStatus: z.string(), now: z.iso.datetime({ offset: true }).optional(),
});
export type QualityInput = z.input<typeof inputSchema>;
export type QualityFlag = { code: string; severity: "information" | "review" | "blocking"; evidence: string[]; explanation: string };
export type QualityAssessment = {
  policyVersion: typeof QUALITY_POLICY_VERSION;
  assessedAt: string;
  status: "eligible_for_review" | "ineligible";
  priority: "low" | "normal" | "high";
  qualityStatus: "unreviewed" | "needs_review";
  flags: QualityFlag[];
  explanation: string;
};

export function assessRepositoryQuality(input: QualityInput): QualityAssessment {
  const repo = inputSchema.parse(input);
  const assessedAt = repo.now ?? new Date().toISOString();
  const flags: QualityFlag[] = [];
  const add = (code: string, severity: QualityFlag["severity"], evidence: string[], explanation: string) => flags.push({ code, severity, evidence, explanation });
  const publicVisibility = repo.isPrivate === false && repo.visibility?.toLowerCase() === "public";
  const eligible = repo.availabilityStatus === "available" && publicVisibility && repo.isDisabled === false
    && repo.canonicalUrl === `https://github.com/${repo.fullName}`;
  if (!eligible) add("access_or_identity", "blocking", ["repository.availability_status", "repository.visibility", "repository.canonical_url"], "Current source access, visibility, or canonical identity does not meet public listing eligibility.");
  if (repo.isArchived) add("archived", "review", ["repository.is_archived"], "The repository is archived; an editor can decide whether it remains useful.");
  if (repo.isFork) add("fork", "review", ["repository.is_fork"], "The repository is a fork; review its independent project context.");
  if (repo.descriptionState !== "present" || !repo.description?.trim()) add("missing_description", "review", ["repository.source_field_states.description"], "GitHub has no usable repository description; no marketing copy was generated.");
  if (!repo.releaseCount) add("no_release_history", "information", ["releases"], "No public release was observed in the bounded enrichment window.");
  if (!repo.enrichmentComplete) add("incomplete_enrichment", "review", ["enrichment.status"], "One or more source resources were incomplete and are not treated as complete observations.");
  if (!repo.observedAt || !repo.enrichedAt) add("missing_source_time", "review", ["repository.source_observed_at", "candidate.enrichment_completed_at"], "Source freshness cannot be established from the available timestamps.");
  else if (Date.parse(assessedAt) - Date.parse(repo.observedAt) > 90 * 24 * 60 * 60 * 1000) add("stale_source", "review", ["repository.source_observed_at"], "The repository observation is more than 90 days old.");
  const lastActivity = repo.providerPushedAt ?? repo.providerUpdatedAt;
  if (lastActivity && Date.parse(assessedAt) - Date.parse(lastActivity) > 365 * 24 * 60 * 60 * 1000) {
    add("stale_activity", "review", [repo.providerPushedAt ? "repository.provider_pushed_at" : "repository.provider_updated_at"], "No repository push or update was observed in the last year; activity age is a review signal only.");
  }
  if (["missing", "noassertion", "unknown_identifier", "complex_expression", "conflicting_evidence", "unavailable"].includes(repo.licenseStatus)) {
    add("license_uncertain", "review", ["repository.source_license_metadata", "license_assessment"], "License evidence is missing, ambiguous, or incomplete and needs editorial review.");
  }
  // Stars and forks remain contextual counters only; they do not alter status or priority.
  void repo.stars; void repo.forks; void repo.providerCreatedAt; void repo.providerUpdatedAt;
  const blocking = flags.some((flag) => flag.severity === "blocking");
  const reviewCount = flags.filter((flag) => flag.severity === "review").length;
  return {
    policyVersion: QUALITY_POLICY_VERSION, assessedAt, status: blocking ? "ineligible" : "eligible_for_review",
    priority: blocking ? "low" : reviewCount >= 3 ? "high" : reviewCount ? "normal" : "low",
    qualityStatus: reviewCount ? "needs_review" : "unreviewed", flags,
    explanation: blocking ? "Repository failed a public-access or identity eligibility check." : reviewCount ? "Source signals are provided for human review; this is not a security audit or quality certification." : "No source review flags were raised; quality remains unverified.",
  };
}
