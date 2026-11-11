import { z } from "zod";
import { isKnownOsiApprovedLicense } from "../../src/lib/assessment/license";
import { MAX_CATALOG_SNAPSHOT_AGE_MS } from "./catalog";

export const REVIEW_POLICY_VERSION = "outlist-codex-editorial-v2" as const;

export const ReviewOutcomeSchema = z.enum(["approve", "reject", "investigate"]);

export const CodexReviewSchema = z.object({
  reviewer: z.object({
    identity: z.literal("codex-cli"),
    model: z.string().min(1).max(80),
    policy_version: z.literal(REVIEW_POLICY_VERSION),
  }).strict(),
  outcome: ReviewOutcomeSchema,
  confidence: z.number().min(0).max(1),
  eligibility: z.object({
    genuine_software_product: z.boolean(),
    publicly_accessible: z.boolean(),
    meaningfully_open_source: z.boolean(),
    license_identifier: z.string().max(128).nullable(),
    license_confidence: z.number().min(0).max(1),
    product_status: z.enum(["functional", "likely_functional", "unclear", "not_functional"]),
    documentation_status: z.enum(["sufficient", "limited", "insufficient", "unclear"]),
    maintenance_status: z.enum(["active", "maintained", "stale", "archived", "unclear"]),
    duplicate_status: z.enum(["distinct", "mirror", "duplicate", "unsuitable_fork", "unclear"]),
    security_or_trust_concerns: z.array(z.string().min(1).max(500)).max(12),
  }).strict(),
  listing: z.object({
    name: z.string().min(1).max(120),
    summary: z.string().min(10).max(280),
    description: z.string().min(1).max(10_000),
    categories: z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)).min(1).max(8),
    tags: z.array(z.string().min(2).max(40)).max(20),
    official_website_url: z.string().url().nullable(),
    logo_url: z.string().url().nullable(),
  }).strict(),
  supporting_sources: z.array(z.object({
    evidence_id: z.string().min(1).max(100),
    source_url: z.string().url(),
    supports: z.string().min(1).max(500),
  }).strict()).min(1).max(30),
  rationale: z.string().min(20).max(3000),
  uncertainties: z.array(z.string().min(1).max(500)).max(20),
  material_blockers: z.array(z.string().min(1).max(500)).max(20),
  informational_uncertainties: z.array(z.string().min(1).max(500)).max(20),
}).strict();

export type CodexReview = z.infer<typeof CodexReviewSchema>;

export const EvidenceSourceSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum(["repository_metadata", "readme", "license", "root_contents", "manifest", "documentation", "latest_commit", "releases", "outlist_catalog"]),
  url: z.string().url(),
  status: z.enum(["available", "not_found", "unavailable"]),
  observed_at: z.string().datetime({ offset: true }),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  text: z.string().max(30_000).nullable(),
  metadata: z.record(z.string(), z.unknown()),
}).strict();

export const EvidencePackageSchema = z.object({
  schema: z.literal("outlist.catalog.codex-evidence.v1"),
  candidate_id: z.string().uuid(),
  repository_id: z.string().regex(/^[1-9][0-9]{0,19}$/),
  full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  project_id: z.string().uuid().nullable(),
  pipeline_outcome: z.enum(["draft_pending_review", "assessment_hold", "enrichment_failure"]),
  pipeline_details: z.object({
    enrichment_status: z.string().max(40),
    enrichment_error: z.string().max(1000).nullable(),
    assessment_status: z.string().max(40),
    classification_status: z.string().max(40),
    publication_status: z.string().max(40),
  }).strict(),
  existing_listing: z.object({
    name: z.string().max(120).nullable(),
    summary: z.string().max(280).nullable(),
    description: z.string().max(10_000).nullable(),
    categories: z.array(z.string()).max(20),
    tags: z.array(z.string()).max(50),
    official_website_url: z.string().url().nullable(),
  }).strict(),
  outlist_categories: z.array(z.object({ slug: z.string(), name: z.string(), active: z.boolean() }).strict()).max(50),
  collected_at: z.string().datetime({ offset: true }),
  collector_status: z.enum(["complete", "partial", "rate_limited", "failed"]),
  sources: z.array(EvidenceSourceSchema).max(30),
  collection_notes: z.array(z.string().min(1).max(500)).max(20),
}).strict().superRefine((value, context) => {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 500_000) {
    context.addIssue({ code: "custom", message: "Evidence package exceeds the 500 KiB bounded review payload." });
  }
});

export type EvidencePackage = z.infer<typeof EvidencePackageSchema>;

export type PolicyDecision = {
  accepted_outcome: "approve" | "reject" | "investigate";
  reasons: string[];
  publication_eligible: boolean;
};

export type ListingNormalization = { review: CodexReview; adjustments: string[] };

export function validateCodexReview(review: unknown, evidence: EvidencePackage): CodexReview {
  const parsed = CodexReviewSchema.parse(review);
  const sourceById = new Map(evidence.sources.map((source) => [source.id, source]));
  for (const citation of parsed.supporting_sources) {
    let source = sourceById.get(citation.evidence_id);
    if (!source) {
      const normalizedCitationId = normalizeEvidenceId(citation.evidence_id);
      const matches = evidence.sources.filter((candidate) => normalizeEvidenceId(candidate.id) === normalizedCitationId && candidate.url === citation.source_url);
      if (matches.length === 1) {
        source = matches[0];
        citation.evidence_id = source.id;
      }
    }
    if (!source || source.url !== citation.source_url || source.status !== "available") {
      throw new TypeError(`Review cites unavailable or mismatched evidence source ${citation.evidence_id}.`);
    }
  }
  const categoryIds = new Set(evidence.outlist_categories.filter((category) => category.active).map((category) => category.slug));
  if (categoryIds.size && parsed.listing.categories.some((category) => !categoryIds.has(category))) {
    throw new TypeError("Review selected a category outside the supplied active Outlist taxonomy.");
  }
  return parsed;
}

export function normalizeOptionalListingUrls(review: CodexReview, evidence: EvidencePackage): ListingNormalization {
  const normalized: CodexReview = structuredClone(review);
  const adjustments: string[] = [];
  if (normalized.listing.official_website_url && !urlIsSupported(normalized.listing.official_website_url, evidence)) {
    normalized.listing.official_website_url = null;
    adjustments.push("Omitted the optional official website URL because the supplied sources did not corroborate it.");
  }
  if (normalized.listing.logo_url && !urlIsSupported(normalized.listing.logo_url, evidence, true)) {
    normalized.listing.logo_url = null;
    adjustments.push("Omitted the optional logo URL because the supplied sources did not corroborate it.");
  }
  return { review: normalized, adjustments };
}

function normalizeEvidenceId(value: string): string { return value.toLowerCase().replace(/_/g, "-"); }

export function applyEditorialPolicy(review: CodexReview, evidence: EvidencePackage, now = new Date(), listingAdjustments: string[] = []): PolicyDecision {
  const reasons: string[] = [];
  const sources = new Map(evidence.sources.map((source) => [source.id, source]));
  const citedKinds = new Set(review.supporting_sources.map((citation) => sources.get(citation.evidence_id)?.kind));
  const licenseSources = evidence.sources.filter((source) => source.kind === "license" && source.status === "available");
  const repositorySource = evidence.sources.find((source) => source.kind === "repository_metadata" && source.status === "available");
  const licenseSpdx = typeof repositorySource?.metadata.license_spdx_id === "string" ? repositorySource.metadata.license_spdx_id : null;
  const readmeSource = evidence.sources.find((source) => source.kind === "readme" && source.status === "available");

  if (review.outcome === "reject") {
    const disqualifier = !review.eligibility.genuine_software_product
      || !review.eligibility.publicly_accessible
      || !review.eligibility.meaningfully_open_source
      || review.eligibility.product_status === "not_functional"
      || review.eligibility.maintenance_status === "archived"
      || ["mirror", "duplicate", "unsuitable_fork"].includes(review.eligibility.duplicate_status);
    const citedKinds = new Set(review.supporting_sources.map((citation) => sources.get(citation.evidence_id)?.kind));
    if (disqualifier && review.confidence >= 0.9 && review.material_blockers.length === 0
      && review.supporting_sources.length >= 2 && (citedKinds.has("readme") || citedKinds.has("repository_metadata"))) {
      return { accepted_outcome: "reject", reasons: ["Codex supplied a high-confidence rejection supported by current sources."], publication_eligible: false };
    }
    reasons.push("The rejection did not identify a strong disqualifier supported by current sources and high confidence.");
  } else if (review.outcome === "approve") {
    if (review.confidence < 0.92) reasons.push("Overall confidence is below 0.92.");
    if (!review.eligibility.genuine_software_product) reasons.push("Software-product eligibility is not established.");
    if (!review.eligibility.publicly_accessible) reasons.push("Public accessibility is not established.");
    if (!review.eligibility.meaningfully_open_source) reasons.push("Open-source eligibility is not established.");
    if (review.eligibility.license_confidence < 0.95 || !review.eligibility.license_identifier) reasons.push("License confidence or identifier is insufficient.");
    if (!isCompleteLicenseEvidence(licenseSources)) reasons.push("The complete current license file and its source hash were not collected.");
    if (review.eligibility.license_identifier && !isKnownOsiApprovedLicense(review.eligibility.license_identifier)) reasons.push("The license identifier is not on the pinned current OSI-approved SPDX list.");
    if (!licenseMetadataAgrees(review.eligibility.license_identifier, licenseSpdx, evidence)) {
      reasons.push("The proposed SPDX identifier is not an exact match for the complete terms and current metadata or project declaration.");
    }
    if (review.eligibility.license_identifier && hasUnrepresentedVersionChoice(review.eligibility.license_identifier, evidence)) {
      reasons.push("The source offers non-equivalent GPL version choices, but the catalog license field stores one SPDX identifier; preserve the complete choice before publication.");
    }
    if (!repositorySource || repositorySource.metadata.private !== false || repositorySource.metadata.disabled !== false
      || String(repositorySource.metadata.visibility).toLowerCase() !== "public"
      || String(repositorySource.metadata.id) !== evidence.repository_id
      || String(repositorySource.metadata.full_name ?? "").toLowerCase() !== evidence.full_name.toLowerCase()) {
      reasons.push("Current repository metadata does not establish an enabled public repository.");
    }
    if (repositorySource?.metadata.archived === true) reasons.push("The source repository is archived.");
    const citedEvidenceIds = new Set(review.supporting_sources.map((citation) => citation.evidence_id));
    const completeReadmeGroups = groupSources(evidence.sources.filter((source) => source.kind === "readme" && source.status === "available"))
      .filter((parts) => isCompleteEvidenceParts(parts, true) && parts.every(hasCompleteRelevantSections));
    if (!readmeSource || !completeReadmeGroups.length) reasons.push("README product identity, capability, and usage evidence is absent or incomplete.");
    if (!["sufficient", "limited"].includes(review.eligibility.documentation_status)) reasons.push("Documentation is insufficient or its quality is uncertain.");
    if (!["active", "maintained"].includes(review.eligibility.maintenance_status)) reasons.push("Maintenance status does not meet the automatic approval threshold.");
    if (!citedKinds.has("readme") || !citedKinds.has("repository_metadata") || !citedKinds.has("license") || !citedKinds.has("outlist_catalog")) {
      reasons.push("Approval must cite current repository, README, license, and Outlist duplicate-index evidence.");
    }
    if (!citedKinds.has("manifest") && !citedKinds.has("root_contents")) reasons.push("Approval must cite source, build, test, or complete manifest evidence for product functionality.");
    if (licenseSources.some((source) => !citedEvidenceIds.has(source.id))) reasons.push("Approval must cite every retained part of the complete license file.");
    if (completeReadmeGroups.length && !completeReadmeGroups.some((parts) => parts.some((source) => citedEvidenceIds.has(source.id)))) {
      reasons.push("Approval must cite a complete README source for the product identity, capabilities, and usage evidence.");
    }
    const rootContents = evidence.sources.find((source) => source.kind === "root_contents" && source.status === "available");
    const discoveredLicensePaths = Array.isArray(rootContents?.metadata.license_file_paths)
      ? rootContents.metadata.license_file_paths.filter((path): path is string => typeof path === "string") : [];
    const completeLicensePaths = new Set(groupSources(licenseSources)
      .filter((parts) => isCompleteEvidenceParts(parts, false))
      .map((parts) => String(parts[0]?.metadata.path ?? "")));
    if (rootContents?.metadata.license_files_truncated === true
      || discoveredLicensePaths.some((path) => !completeLicensePaths.has(path))) {
      reasons.push("The root inventory identifies license files that were not all collected completely.");
    }
    const manifestGroups = new Map<string, EvidencePackage["sources"]>();
    for (const source of evidence.sources.filter((item) => item.kind === "manifest" && item.status === "available")) {
      const key = typeof source.metadata.path === "string" ? source.metadata.path : source.id;
      manifestGroups.set(key, [...(manifestGroups.get(key) ?? []), source]);
    }
    const completeManifestGroups = [...manifestGroups.values()].filter((parts) => isCompleteEvidenceParts(parts, true));
    const completeManifest = completeManifestGroups.length > 0;
    const hasSourceTreeEvidence = rootContents?.metadata.source_tree_complete === true
      && isRecord(rootContents.metadata.software_signals)
      && (rootContents.metadata.software_signals.source_code === true || rootContents.metadata.software_signals.test_or_build_files === true);
    if (!rootContents || (!completeManifest && !hasSourceTreeEvidence)) reasons.push("A complete software manifest or source/build/test tree evidence is required to support product functionality.");
    const citedProductEvidence = completeManifestGroups.some((parts) => parts.some((source) => citedEvidenceIds.has(source.id)))
      || (citedKinds.has("root_contents") && hasSourceTreeEvidence);
    if (!citedProductEvidence) {
      reasons.push("Approval must cite a complete software manifest or source/build/test tree for product functionality.");
    }
    if (!["functional", "likely_functional"].includes(review.eligibility.product_status)) reasons.push("Product functionality is uncertain or contradicted.");
    if (["archived", "unclear"].includes(review.eligibility.maintenance_status)) reasons.push("Maintenance status is not acceptable for automatic approval.");
    if (["mirror", "duplicate", "unsuitable_fork", "unclear"].includes(review.eligibility.duplicate_status)) reasons.push("Repository uniqueness is uncertain or unsuitable.");
    if (review.eligibility.security_or_trust_concerns.length) reasons.push("Material security or trust concerns require investigation.");
    if (review.material_blockers.length) reasons.push("Codex reported material blockers that remain unresolved.");
    const duplicateSource = evidence.sources.find((source) => source.kind === "outlist_catalog" && source.status === "available");
    const duplicateCheck = isRecord(duplicateSource?.metadata.duplicate_check) ? duplicateSource.metadata.duplicate_check : null;
    const snapshotCapturedAt = typeof duplicateCheck?.snapshot_captured_at === "string" ? Date.parse(duplicateCheck.snapshot_captured_at) : Number.NaN;
    const snapshotAge = now.getTime() - snapshotCapturedAt;
    if (!duplicateCheck || duplicateCheck.snapshot_complete !== true || duplicateCheck.snapshot_fresh !== true
      || !Number.isFinite(snapshotAge) || snapshotAge < -5 * 60_000 || snapshotAge > MAX_CATALOG_SNAPSHOT_AGE_MS
      || typeof duplicateSource?.sha256 !== "string" || duplicateCheck.snapshot_sha256 !== duplicateSource.sha256
      || typeof duplicateCheck.snapshot_data_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(duplicateCheck.snapshot_data_sha256)
      || duplicateSource.url !== `urn:outlist:catalog-snapshot:${duplicateSource.sha256}`
      || duplicateCheck.candidate_id !== evidence.candidate_id
      || duplicateCheck.candidate_repository_id !== evidence.repository_id
      || String(duplicateCheck.candidate_full_name ?? "").toLowerCase() !== evidence.full_name.toLowerCase()
      || duplicateCheck.candidate_identity_verified !== true || duplicateCheck.has_material_duplicate_conflict !== false
      || !Array.isArray(duplicateCheck.duplicate_imported_candidates) || duplicateCheck.duplicate_imported_candidates.length > 0
      || !Array.isArray(duplicateCheck.candidate_canonical_identity_conflicts) || duplicateCheck.candidate_canonical_identity_conflicts.length > 0
      || !Array.isArray(duplicateCheck.canonical_identity_conflicts) || duplicateCheck.canonical_identity_conflicts.length > 0
      || !Array.isArray(duplicateCheck.duplicate_public_product_listings) || duplicateCheck.duplicate_public_product_listings.length > 0) {
      reasons.push("The current Outlist repository, project, fork, or listing identity check is incomplete or found a conflict.");
    }
    if (review.listing.official_website_url && !urlIsSupported(review.listing.official_website_url, evidence)) reasons.push("The proposed official website URL is not corroborated by repository metadata or the README.");
    if (review.listing.logo_url && !urlIsSupported(review.listing.logo_url, evidence, true)) reasons.push("The proposed logo URL is not corroborated by an official source in the evidence package.");
    if (reasons.length === 0) {
      return { accepted_outcome: "approve", reasons: [...listingAdjustments, "Independent review met every automated evidence gate."], publication_eligible: true };
    }
  } else {
    reasons.push("Codex identified material uncertainty requiring investigation.");
  }

  return { accepted_outcome: "investigate", reasons, publication_eligible: false };
}

function isCompleteLicenseEvidence(sources: EvidencePackage["sources"]): boolean {
  const groups = groupSources(sources);
  return groups.length > 0 && groups.every((parts) => isCompleteEvidenceParts(parts, false));
}

function groupSources(sources: EvidencePackage["sources"]): EvidencePackage["sources"][] {
  const groups = new Map<string, EvidencePackage["sources"]>();
  for (const source of sources) {
    const key = typeof source.metadata.path === "string" ? source.metadata.path : source.id;
    groups.set(key, [...(groups.get(key) ?? []), source]);
  }
  return [...groups.values()];
}

function licenseMetadataAgrees(identifier: string | null, repositorySpdx: string | null, evidence: EvidencePackage): boolean {
  if (!identifier) return false;
  const declarations = declaredManifestLicenses(evidence);
  if (declarations.length && !declarations.includes(identifier)) return false;
  if (repositorySpdx === identifier) return true;
  if (!hasProjectLicenseDeclaration(identifier, evidence)) return false;
  if (!repositorySpdx || repositorySpdx.toUpperCase() === "NOASSERTION") return true;
  const family = (value: string) => value.replace(/-(?:only|or-later)$/i, "");
  return family(repositorySpdx) === family(identifier) && licenseSupportsVersionChoice(identifier, evidence);
}

function hasProjectLicenseDeclaration(identifier: string, evidence: EvidencePackage): boolean {
  const escaped = escapeRegExp(identifier);
  const declaration = new RegExp(`(?:SPDX-License-Identifier\\s*:\\s*${escaped}(?:\\b|$)|\\blicense\\b[^\\n]{0,120}\\b${escaped}\\b|\\b${escaped}\\b[^\\n]{0,40}\\blicen[cs]e\\b)`, "i");
  const sources = evidence.sources.filter((source) => source.status === "available" && (source.kind === "readme" || source.kind === "manifest"));
  const completeSources = groupSources(sources).filter((parts) => isCompleteEvidenceParts(parts, true)).flat();
  if (completeSources.some((source) => source.text !== null && declaration.test(source.text))) return true;
  const scopedDeclaration = new RegExp(`\\b(?:licensed|released|distributed|available)\\s+under\\b[^\\n]{0,120}\\b${escaped}\\b|\\b${escaped}\\b[^\\n]{0,80}\\b(?:licensed|available|released)\\b`, "i");
  const completeLicenseSources = groupSources(evidence.sources.filter((source) => source.kind === "license" && source.status === "available"))
    .filter((parts) => isCompleteEvidenceParts(parts, false)).flat();
  if (completeLicenseSources.some((source) => source.text !== null && scopedDeclaration.test(source.text))) return true;
  const family = licenseFamily(identifier);
  if (!family || !licenseTermsSupportIdentifier(identifier, evidence)) return false;
  const familyDeclaration = new RegExp(`(?:released\\s+under|licensed\\s+under|license(?:d)?(?:\\s+is|\\s+terms)?\\s*[:=-]?)\\s+(?:the\\s+)?${family.source}|${family.source}[^\\n]{0,80}\\blicen[cs]e\\b`, "i");
  return completeSources.some((source) => source.text !== null && familyDeclaration.test(source.text));
}

function declaredManifestLicenses(evidence: EvidencePackage): string[] {
  const declarations: string[] = [];
  const manifests = evidence.sources.filter((source) => source.kind === "manifest" && source.status === "available");
  for (const parts of groupSources(manifests)) {
    if (!isCompleteEvidenceParts(parts, true)) continue;
    const text = parts.map((source) => source.text ?? "").join("\n");
    for (const match of text.matchAll(/SPDX-License-Identifier\s*:\s*([A-Za-z0-9.+-]+)/gi)) declarations.push(match[1]!);
    const path = String(parts[0]?.metadata.path ?? "").toLowerCase();
    if (path.endsWith(".json")) {
      try {
        const value = JSON.parse(text) as { license?: unknown; private?: unknown };
        const licenses = Array.isArray(value.license) ? value.license : [value.license];
        for (const license of licenses) {
          if (typeof license === "string" && !(license.toLowerCase() === "private" && value.private === true)) declarations.push(license);
          else if (isRecord(license) && typeof license.type === "string") declarations.push(license.type);
        }
      } catch { /* A malformed manifest cannot supply a project license declaration. */ }
    } else {
      for (const match of text.matchAll(/^\s*license\s*=\s*["']([^"']+)["']/gim)) declarations.push(match[1]!);
    }
  }
  return [...new Set(declarations.map((value) => value.trim()).filter(Boolean))];
}

function licenseSupportsVersionChoice(identifier: string, evidence: EvidencePackage): boolean {
  if (!identifier.endsWith("-or-later")) return true;
  const licenseText = evidence.sources.filter((source) => source.kind === "license" && source.status === "available")
    .map((source) => source.text ?? "").join("\n").toLowerCase();
  const family = identifier.startsWith("AGPL-") ? "gnu affero general public license"
    : identifier.startsWith("LGPL-") ? "gnu lesser general public license"
      : identifier.startsWith("GPL-") ? "gnu general public license" : null;
  return family !== null && licenseText.includes(family) && /either version \d+ of (?:the )?license, or[\s\S]{0,100}any later version/.test(licenseText);
}

function licenseTermsSupportIdentifier(identifier: string, evidence: EvidencePackage): boolean {
  const family = licenseFamily(identifier);
  if (!family) return false;
  const text = evidence.sources.filter((source) => source.kind === "license" && source.status === "available")
    .map((source) => source.text ?? "").join("\n");
  if (!family.test(text)) return false;
  if (identifier.endsWith("-or-later")) return licenseSupportsVersionChoice(identifier, evidence);
  const version = identifier.match(/-(\d+)(?:\.0)?(?:-only)?$/i)?.[1];
  return version !== undefined && new RegExp(`(?:version\\s+${version}(?:\\.0)?|\\bv${version}\\b)`, "i").test(text);
}

function hasUnrepresentedVersionChoice(identifier: string, evidence: EvidencePackage): boolean {
  const text = evidence.sources.filter((source) => source.kind === "license" && source.status === "available")
    .map((source) => source.text ?? "").join("\n");
  const choices = text.match(/either version (\d+)(?:\.0)? of (?:the )?license, or (?:\(at your option\) )?version (\d+)(?:\.0)?/i);
  const identifierVersion = identifier.match(/-(\d+)(?:\.0)?(?:-only|-or-later)?$/i)?.[1];
  return choices !== null && choices !== undefined && identifierVersion !== undefined
    && (identifierVersion === choices[1] || identifierVersion === choices[2]);
}

function licenseFamily(identifier: string): RegExp | null {
  if (identifier.startsWith("AGPL-")) return /(?:GNU\s+)?Affero General Public License|\bAGPL\b/i;
  if (identifier.startsWith("LGPL-")) return /(?:GNU\s+)?Lesser General Public License|\bLGPL\b/i;
  if (identifier.startsWith("GPL-")) return /(?:GNU\s+)?General Public License|\bGPL\b/i;
  return null;
}

function isCompleteEvidenceParts(sources: EvidencePackage["sources"], allowRelevantSections: boolean): boolean {
  if (!sources.length) return false;
  const first = sources[0]!;
  const partCount = Number(first.metadata.content_part_count ?? 1);
  if (!Number.isInteger(partCount) || partCount < 1 || sources.length !== partCount) return false;
  const parts = [...sources].sort((left, right) => Number(left.metadata.content_part_index ?? 1) - Number(right.metadata.content_part_index ?? 1));
  return parts.every((source, index) => source.sha256 === first.sha256 && source.text !== null
    && source.metadata.content_sha256 === first.sha256
    && (source.metadata.complete_file === true || (allowRelevantSections && source.metadata.relevant_sections_complete === true))
    && (source.metadata.complete_file !== true || source.metadata.truncated === false)
    && Number(source.metadata.content_part_index ?? 1) === index + 1
    && Number(source.metadata.content_part_count ?? 1) === partCount);
}

function hasCompleteRelevantSections(source: EvidencePackage["sources"][number]): boolean {
  if (source.text === null || source.sha256 === null || source.metadata.content_sha256 !== source.sha256) return false;
  if (source.metadata.complete_file === true) return source.metadata.truncated === false;
  const coverage = isRecord(source.metadata.relevance_coverage) ? source.metadata.relevance_coverage : null;
  return source.metadata.relevant_sections_complete === true && coverage !== null
    && source.metadata.truncated === true
    && coverage.product_identity === true && coverage.capabilities === true && coverage.usage === true;
}

function urlIsSupported(value: string, evidence: EvidencePackage, requireImage = false): boolean {
  let proposed: URL;
  try { proposed = new URL(value); } catch { return false; }
  if (!/^https?:$/.test(proposed.protocol) || proposed.username || proposed.password) return false;
  const metadata = evidence.sources.find((source) => source.kind === "repository_metadata")?.metadata;
  const homepage = typeof metadata?.homepage === "string" && metadata.homepage ? metadata.homepage : null;
  if (homepage) {
    try {
      const known = new URL(homepage);
      if (known.hostname === proposed.hostname && !requireImage) return true;
    } catch { /* Ignore malformed homepage metadata. */ }
  }
  const readme = evidence.sources.find((source) => source.kind === "readme")?.text ?? "";
  if (requireImage) {
    const readmeSource = evidence.sources.find((source) => source.kind === "readme");
    const base = readmeSource?.url ?? "https://github.com/";
    const imageUrls = [
      ...[...readme.matchAll(/!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g)].map((match) => match[1]!),
      ...[...readme.matchAll(/<img\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi)].map((match) => match[2]!),
    ];
    return imageUrls.some((value) => {
      try { return new URL(value, base).href === proposed.href; }
      catch { return false; }
    });
  }
  const host = escapeRegExp(proposed.hostname);
  return new RegExp(`https?://(?:www\\.)?${host}(?=[/:)\\s#]|$)`, "i").test(readme);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
