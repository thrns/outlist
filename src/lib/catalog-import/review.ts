import type { GitHubRepository, SourceField } from "../github/types";
import { isKnownOsiApprovedLicense } from "../assessment/license";
import type { CatalogCandidateRecord } from "./archive";

export type CatalogReviewStatus = "eligible_for_automated_editorial_recommendation" | "requires_manual_review" | "rejected_or_excluded";
export type CatalogReviewReason = { code: string; explanation: string; evidence: string[] };

export type CatalogReviewReportItem = {
  github_repository_id: string;
  github_full_name: string;
  proposed_slug: string;
  source_batch: number;
  source_line: number;
  status: CatalogReviewStatus;
  recommendation: "consider_for_editorial_review" | "manual_review_required" | "exclude";
  evidence: {
    archive_claims: Record<string, unknown>;
    current_repository: Record<string, unknown> | null;
    assessment: Record<string, unknown> | null;
  };
  reasons: CatalogReviewReason[];
  required_follow_up: string[];
  license: {
    reported_identifier: string | null;
    github_evidence_available: boolean;
    review_status: "unverified" | "needs_review" | "not_assessed";
    legal_verification_granted: false;
  };
};

export type CatalogAssessmentEvidence = {
  quality?: { status?: string; qualityStatus?: string; flags?: Array<{ code?: string; severity?: string; explanation?: string; evidence?: string[] }> };
  classification?: { status?: string; confidence?: string; primaryCategoryId?: string | null; suggestions?: Array<{ categorySlug?: string; confidence?: string }> };
  license?: { status?: string; identifier?: string | null; projectLicenseStatus?: string; evidence?: Array<{ method?: string; state?: string; value?: string | null }> };
};

export type CatalogCurrentEvidence = {
  repository: GitHubRepository;
  fetchedAt: string;
  sourceUrl: string;
  httpStatus: number;
};

function value<T>(field: SourceField<T>): T | null {
  return field.state === "present" ? field.value : null;
}

function addReason(reasons: CatalogReviewReason[], code: string, explanation: string, evidence: string[]) {
  reasons.push({ code, explanation, evidence });
}

function archiveClaims(record: CatalogCandidateRecord): Record<string, unknown> {
  return {
    source_checked_at: record.source_checked_at,
    visibility: record.visibility,
    archived: record.archived,
    license_spdx_id: record.license_spdx_id,
    license_review_status: record.license_review_status,
    license_evidence_url: record.license_evidence_url,
    source_urls: record.source_urls,
    primary_category: record.primary_category,
    name: record.name,
    tagline: record.tagline,
    description: record.description,
  };
}

function currentRepositoryEvidence(current: CatalogCurrentEvidence | null) {
  if (!current) return null;
  const repo = current.repository;
  const activityDate = value(repo.pushedAt) ?? repo.updatedAt;
  const license = value(repo.license);
  return {
    provider_repository_id: String(repo.id),
    full_name: repo.fullName,
    canonical_url: repo.canonicalUrl,
    visibility: value(repo.visibility),
    is_private: repo.isPrivate,
    is_disabled: repo.isDisabled,
    is_archived: repo.isArchived,
    is_fork: repo.isFork,
    description: value(repo.description),
    activity_at: activityDate,
    license: license ? { spdx_id: value(license.spdxId), html_url: value(license.htmlUrl), name: license.name } : null,
    source: { url: current.sourceUrl, fetched_at: current.fetchedAt, http_status: current.httpStatus },
  };
}

export function reviewCatalogCandidate(
  record: CatalogCandidateRecord,
  current: CatalogCurrentEvidence | null = null,
  assessment: CatalogAssessmentEvidence | null = null,
  now = new Date(),
): CatalogReviewReportItem {
  const reasons: CatalogReviewReason[] = [];
  const requiredFollowUp = new Set<string>();
  let status: CatalogReviewStatus = "requires_manual_review";
  const currentEvidence = currentRepositoryEvidence(current);
  const currentLicense = current ? value(current.repository.license) : null;
  const currentLicenseId = (currentLicense ? value(currentLicense.spdxId) : null)?.trim() || null;
  const archiveLicenseNeedsReview = record.license_review_status === "needs_review";
  let licenseStatus: CatalogReviewReportItem["license"]["review_status"] = current ? "unverified" : "not_assessed";

  if (!current) {
    addReason(reasons, "fresh_github_check_pending", "The archive contains a source snapshot, but current GitHub identity and visibility have not been rechecked.", [
      "archive.source_checked_at", "archive.source_urls",
    ]);
    addReason(reasons, "full_assessment_pending", "Repository enrichment and the existing source-backed assessment pipeline have not produced current evidence yet.", [
      "repository_assessments", "repository_assessment_sources",
    ]);
    requiredFollowUp.add("revalidate_repository_identity_and_visibility");
    requiredFollowUp.add("run_source_enrichment_and_assessment");
  } else {
    const repo = current.repository;
    const visibility = value(repo.visibility)?.toLowerCase() ?? null;
    if (String(repo.id) !== record.github_repository_id) {
      status = "rejected_or_excluded";
      addReason(reasons, "repository_id_mismatch", "Current GitHub response does not identify the repository ID from the catalog source.", [
        "github_response.id", "catalog.github_repository_id",
      ]);
    } else if (repo.isPrivate || visibility !== "public" || repo.isDisabled) {
      status = "rejected_or_excluded";
      addReason(reasons, "not_publicly_available", "Current GitHub evidence shows the repository is private, disabled, or not explicitly public.", [
        "github_response.private", "github_response.visibility", "github_response.disabled",
      ]);
    } else {
      addReason(reasons, "public_identity_confirmed", "The stable repository ID resolves to a public, enabled GitHub repository.", [
        "github_response.id", "github_response.full_name", "github_response.visibility", "github_response.disabled",
      ]);
      if (repo.fullName.toLowerCase() !== record.github_full_name.toLowerCase()) {
        addReason(reasons, "repository_renamed_since_curation", "The stable repository ID now resolves to a different full name; the current identity is retained and the archived name is preserved as source evidence.", [
          "github_response.full_name", "archive.github_full_name",
        ]);
      }
      const activityValue = value(repo.pushedAt) ?? repo.updatedAt;
      const activityTime = Date.parse(activityValue);
      const ageDays = Number.isFinite(activityTime) ? (now.getTime() - activityTime) / 86_400_000 : Number.POSITIVE_INFINITY;
      if (repo.isArchived) {
        addReason(reasons, "repository_archived", "The repository is archived and needs an editor to decide whether it remains useful.", ["github_response.archived"]);
        requiredFollowUp.add("review_archived_project_relevance");
      }
      if (repo.isFork) {
        addReason(reasons, "repository_is_fork", "The repository is a fork and needs an editor to confirm its independent project context.", ["github_response.fork"]);
        requiredFollowUp.add("review_fork_context");
      }
      if (!Number.isFinite(activityTime) || ageDays < -1) {
        addReason(reasons, "activity_timestamp_unavailable", "A usable repository activity timestamp is unavailable or inconsistent.", ["github_response.pushed_at", "github_response.updated_at"]);
        requiredFollowUp.add("review_maintainability_signals");
      } else if (ageDays > 365) {
        addReason(reasons, "stale_repository_activity", "The latest push or update is more than one year old; this is a maintenance review signal, not an automatic rejection.", ["github_response.pushed_at", "github_response.updated_at"]);
        requiredFollowUp.add("review_maintainability_signals");
      } else {
        addReason(reasons, "recent_repository_activity", "A push or repository update was observed within the last year.", ["github_response.pushed_at", "github_response.updated_at"]);
      }
      if (!value(repo.description)?.trim()) {
        addReason(reasons, "current_description_missing", "GitHub currently has no usable repository description; the archived editorial description remains unverified source material.", [
          "github_response.description", "archive.description",
        ]);
        requiredFollowUp.add("review_project_metadata");
      }
      if (!currentLicenseId || currentLicenseId.toUpperCase() === "NOASSERTION") {
        licenseStatus = "needs_review";
        addReason(reasons, "current_license_evidence_missing_or_ambiguous", "Current GitHub license metadata is missing or ambiguous.", ["github_response.license", "archive.license_evidence_url"]);
        requiredFollowUp.add("manually_review_license_evidence");
      } else {
        const known = isKnownOsiApprovedLicense(currentLicenseId);
        addReason(reasons, "github_license_metadata_observed", `GitHub reports ${currentLicenseId}${known ? ", which is recognized in the pinned SPDX list" : ""}; this is source evidence and does not establish legal verification.`, [
          "github_response.license.spdx_id", "github_response.license.html_url",
        ]);
        requiredFollowUp.add("manually_verify_license_terms");
        if (archiveLicenseNeedsReview || (record.license_spdx_id !== null && record.license_spdx_id !== currentLicenseId)) {
          licenseStatus = "needs_review";
          addReason(reasons, "license_evidence_changed_or_flagged", "The archived license evidence was flagged for review or differs from current GitHub metadata.", [
            "archive.license_spdx_id", "archive.license_review_status", "github_response.license.spdx_id",
          ]);
        }
      }
      if (!assessment) {
        addReason(reasons, "source_assessment_pending", "Identity and initial metadata were checked, but the full source-backed maintainability, license, category, and quality assessment has not run.", [
          "repository_assessments", "repository_assessment_sources",
        ]);
        requiredFollowUp.add("run_source_enrichment_and_assessment");
      }
    }
  }

  if (assessment && status !== "rejected_or_excluded") {
    const quality = assessment.quality;
    const classification = assessment.classification;
    const license = assessment.license;
    const blockingFlags = quality?.flags?.filter((flag) => flag.severity === "blocking") ?? [];
    if (quality?.status === "ineligible" || blockingFlags.length > 0) {
      status = "rejected_or_excluded";
      addReason(reasons, "assessment_ineligible", "The source-backed quality assessment found a blocking access or identity issue.", blockingFlags.flatMap((flag) => flag.evidence ?? [flag.code ?? "quality.flags"]));
    } else if (quality?.status !== "eligible_for_review") {
      addReason(reasons, "assessment_quality_unavailable", "The source-backed quality assessment is missing or incomplete.", ["repository_assessments.result.quality"]);
      requiredFollowUp.add("review_source_quality_evidence");
    }
    if (classification?.status !== "classified" || !classification.primaryCategoryId) {
      addReason(reasons, "classification_needs_review", "Current repository text and topic evidence do not support one active primary category.", ["repository_assessments.result.classification"]);
      requiredFollowUp.add("manually_review_project_classification");
    } else {
      addReason(reasons, "classification_supported", "The existing assessment found an active taxonomy category from current repository evidence.", ["repository_assessments.result.classification.suggestions"]);
    }
    if (!license || !["recognized_osi_approved", "recognized_not_osi_approved"].includes(license.status ?? "")) {
      licenseStatus = "needs_review";
      addReason(reasons, "assessment_license_needs_review", "The existing license assessment found missing, ambiguous, conflicting, or unavailable evidence.", ["repository_assessments.result.license"]);
      requiredFollowUp.add("manually_review_license_evidence");
    } else {
      requiredFollowUp.add("manually_verify_license_terms");
    }
  }

  if (status !== "rejected_or_excluded" && current && assessment) {
    const qualityFlags = assessment.quality?.flags ?? [];
    const qualityOkay = assessment.quality?.status === "eligible_for_review"
      && !qualityFlags.some((flag) => flag.severity === "blocking");
    const classificationOkay = assessment.classification?.status === "classified"
      && Boolean(assessment.classification.primaryCategoryId);
    const currentRepo = current.repository;
    const activityValue = value(currentRepo.pushedAt) ?? currentRepo.updatedAt;
    const activeEnough = Date.parse(activityValue) <= now.getTime() + 86_400_000
      && now.getTime() - Date.parse(activityValue) <= 365 * 86_400_000;
    const metadataOkay = Boolean(currentRepo.fullName && record.name.trim() && record.description.trim() && record.tagline.trim());
    const licenseEvidenceOkay = Boolean(currentLicenseId && currentLicenseId.toUpperCase() !== "NOASSERTION"
      && licenseStatus !== "needs_review");
    if (qualityOkay && classificationOkay && activeEnough && metadataOkay && licenseEvidenceOkay && !currentRepo.isArchived && !currentRepo.isFork) {
      status = "eligible_for_automated_editorial_recommendation";
      addReason(reasons, "automated_recommendation_eligible", "Current identity, public visibility, activity, source assessment, classification, and metadata quality support an editorial recommendation; human review and publication controls still apply.", [
        "github_response", "repository_assessments.result.quality", "repository_assessments.result.classification", "repository_assessments.result.license",
      ]);
    } else status = "requires_manual_review";
  }

  if (status === "rejected_or_excluded" && reasons.length === 0) {
    addReason(reasons, "excluded", "The candidate did not meet current public identity requirements.", ["github_response"]);
  }
  if (status === "requires_manual_review" && reasons.length === 0) {
    addReason(reasons, "manual_review_required", "Available evidence is insufficient for an automated editorial recommendation.", ["catalog_candidate"]);
  }

  return {
    github_repository_id: record.github_repository_id,
    github_full_name: record.github_full_name,
    proposed_slug: record.slug,
    source_batch: record.source_batch,
    source_line: record.source_line,
    status,
    recommendation: status === "eligible_for_automated_editorial_recommendation"
      ? "consider_for_editorial_review"
      : status === "rejected_or_excluded" ? "exclude" : "manual_review_required",
    evidence: { archive_claims: archiveClaims(record), current_repository: currentEvidence, assessment: assessment as Record<string, unknown> | null },
    reasons,
    required_follow_up: [...requiredFollowUp].sort(),
    license: {
      reported_identifier: currentLicenseId ?? record.license_spdx_id,
      github_evidence_available: Boolean(currentLicenseId),
      review_status: licenseStatus,
      legal_verification_granted: false,
    },
  };
}

export function offlineReviewReport(record: CatalogCandidateRecord): CatalogReviewReportItem {
  return reviewCatalogCandidate(record);
}
