import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyEditorialPolicy, EvidencePackageSchema, normalizeOptionalListingUrls, REVIEW_POLICY_VERSION, validateCodexReview, type CodexReview, type EvidencePackage } from "./schema";

const candidateId = "00000000-0000-4000-8000-000000000011";
const projectId = "00000000-0000-4000-8000-000000000012";
const reviewedAt = new Date();

function source(id: string, kind: EvidencePackage["sources"][number]["kind"], url: string, text: string | null, metadata: Record<string, unknown> = {}) {
  return {
    id, kind, url, status: "available" as const, observed_at: reviewedAt.toISOString(),
    sha256: text === null ? createHash("sha256").update(id).digest("hex") : createHash("sha256").update(text).digest("hex"),
    text, metadata,
  };
}

function evidence(): EvidencePackage {
  return EvidencePackageSchema.parse({
    schema: "outlist.catalog.codex-evidence.v1",
    candidate_id: candidateId,
    repository_id: "123456",
    full_name: "fixture/task-manager",
    project_id: projectId,
    pipeline_outcome: "draft_pending_review",
    pipeline_details: { enrichment_status: "succeeded", enrichment_error: null, assessment_status: "needs_review", classification_status: "classified", publication_status: "pending_review" },
    existing_listing: { name: "Task Manager", summary: "A collaborative task manager for teams.", description: "A task manager.", categories: ["productivity"], tags: ["tasks"], official_website_url: "https://example.com" },
    outlist_categories: [{ slug: "developer-tools", name: "Developer Tools", active: true }, { slug: "productivity", name: "Productivity", active: true }],
    collected_at: reviewedAt.toISOString(),
    collector_status: "complete",
    collection_notes: [],
    sources: [
      source("repository", "repository_metadata", "https://api.github.com/repositories/123456", null, {
        id: 123456, full_name: "fixture/task-manager", visibility: "public", private: false, disabled: false, archived: false,
        homepage: "https://example.com", license_spdx_id: "MIT", fork: false,
      }),
      source("readme", "readme", "https://github.com/fixture/task-manager/blob/main/README.md", "# Task Manager\nA task management web application. Visit https://example.com for details.", { content_sha256: createHash("sha256").update("# Task Manager\nA task management web application. Visit https://example.com for details.").digest("hex"), complete_file: true, relevant_sections_complete: true, truncated: false }),
      source("license", "license", "https://github.com/fixture/task-manager/blob/main/LICENSE", "MIT License\nCopyright (c) 2026", { path: "LICENSE", content_sha256: createHash("sha256").update("MIT License\nCopyright (c) 2026").digest("hex"), content_part_index: 1, content_part_count: 1, complete_file: true, truncated: false }),
      source("root", "root_contents", "https://api.github.com/repos/fixture/task-manager/contents", null, { source_tree_complete: true, software_signals: { source_code: true, test_or_build_files: true }, data: [{ name: "src", type: "dir" }, { name: "tests", type: "dir" }] }),
      source("manifest", "manifest", "https://github.com/fixture/task-manager/blob/main/package.json", "{\"name\":\"task-manager\"}", { path: "package.json", content_sha256: createHash("sha256").update("{\"name\":\"task-manager\"}").digest("hex"), complete_file: true, truncated: false }),
      source("latest-commit", "latest_commit", "https://api.github.com/repos/fixture/task-manager/commits?per_page=1", null, { data: [{ sha: "abc" }] }),
      source("releases", "releases", "https://api.github.com/repos/fixture/task-manager/releases?per_page=10", null, { data: [] }),
      source("outlist-catalog-index", "outlist_catalog", `urn:outlist:catalog-snapshot:${createHash("sha256").update("outlist-catalog-index").digest("hex")}`, null, {
        duplicate_check: {
          snapshot_complete: true, snapshot_fresh: true, snapshot_sha256: createHash("sha256").update("outlist-catalog-index").digest("hex"),
          snapshot_data_sha256: "e".repeat(64),
          snapshot_captured_at: reviewedAt.toISOString(), candidate_id: candidateId, candidate_repository_id: "123456", candidate_full_name: "fixture/task-manager",
          candidate_identity_verified: true,
          has_material_duplicate_conflict: false, duplicate_imported_candidates: [], candidate_canonical_identity_conflicts: [], canonical_identity_conflicts: [],
          duplicate_public_product_listings: [], project_associations: [], exact_repository_matches: [],
        },
      }),
    ],
  });
}

function review(evidencePackage: EvidencePackage): CodexReview {
  return {
    reviewer: { identity: "codex-cli", model: "gpt-6-luna", policy_version: REVIEW_POLICY_VERSION },
    outcome: "approve",
    confidence: 0.97,
    eligibility: {
      genuine_software_product: true,
      publicly_accessible: true,
      meaningfully_open_source: true,
      license_identifier: "MIT",
      license_confidence: 0.98,
      product_status: "functional",
      documentation_status: "sufficient",
      maintenance_status: "active",
      duplicate_status: "distinct",
      security_or_trust_concerns: [],
    },
    listing: {
      name: "Task Manager",
      summary: "A collaborative task management application for teams.",
      description: "A task management web application for coordinating work across a team.",
      categories: ["productivity"],
      tags: ["tasks", "project management"],
      official_website_url: "https://example.com",
      logo_url: null,
    },
    supporting_sources: [
      { evidence_id: "repository", source_url: evidencePackage.sources[0]!.url, supports: "Current public repository identity and MIT metadata." },
      { evidence_id: "readme", source_url: evidencePackage.sources[1]!.url, supports: "README describes the task management application." },
      { evidence_id: "license", source_url: evidencePackage.sources[2]!.url, supports: "Full MIT license text inspected and consistent with the identified terms." },
      { evidence_id: "manifest", source_url: evidencePackage.sources[4]!.url, supports: "The source manifest identifies an installable software package." },
      { evidence_id: "outlist-catalog-index", source_url: evidencePackage.sources[7]!.url, supports: "The current Outlist identity snapshot found no duplicate candidate or public listing." },
    ],
    rationale: "The current public repository contains a functioning task-management product, a current README and package manifest, and license text consistent with the MIT license. The listing matches the observed product capabilities.",
    uncertainties: [],
    material_blockers: [],
    informational_uncertainties: [],
  };
}

describe("Codex review schema and editorial policy", () => {
  it("accepts structured source-cited reviews and independently applies the approval gates", () => {
    const packageEvidence = evidence();
    const validated = validateCodexReview(review(packageEvidence), packageEvidence);
    expect(applyEditorialPolicy(validated, packageEvidence)).toEqual({
      accepted_outcome: "approve",
      reasons: ["Independent review met every automated evidence gate."],
      publication_eligible: true,
    });
  });

  it("rejects invented evidence IDs and mismatched source URLs", () => {
    const packageEvidence = evidence();
    const invented = review(packageEvidence);
    invented.supporting_sources[0] = { evidence_id: "made-up", source_url: "https://example.org/evidence", supports: "Made-up evidence." };
    expect(() => validateCodexReview(invented, packageEvidence)).toThrow("unavailable or mismatched evidence source");
  });

  it("repairs only underscore-for-hyphen evidence ID typos when the exact source URL matches", () => {
    const packageEvidence = evidence();
    const input = review(packageEvidence);
    input.supporting_sources.push({ evidence_id: "latest_commit", source_url: packageEvidence.sources[5]!.url, supports: "The latest source commit supports active maintenance." });
    const validated = validateCodexReview(input, packageEvidence);
    expect(validated.supporting_sources.at(-1)?.evidence_id).toBe("latest-commit");

    input.supporting_sources.at(-1)!.source_url = "https://example.invalid/commit";
    expect(() => validateCodexReview(input, packageEvidence)).toThrow("unavailable or mismatched evidence source");
  });

  it("holds approvals when license metadata conflicts with the inspected license terms", () => {
    const packageEvidence = evidence();
    const license = review(packageEvidence);
    license.eligibility.license_identifier = "Apache-2.0";
    expect(applyEditorialPolicy(license, packageEvidence).accepted_outcome).toBe("investigate");
  });

  it("approves when the only uncertainty is informational and relevant README sections are complete", () => {
    const packageEvidence = evidence();
    packageEvidence.collector_status = "partial";
    packageEvidence.sources[1]!.metadata.truncated = true;
    packageEvidence.sources[1]!.metadata.complete_file = false;
    packageEvidence.sources[1]!.metadata.relevant_sections_complete = true;
    packageEvidence.sources[1]!.metadata.relevance_coverage = { product_identity: true, capabilities: true, usage: true, development: true };
    const informative = review(packageEvidence);
    informative.uncertainties = ["Unrelated historical documentation sections were omitted from the bounded evidence excerpt."];
    informative.informational_uncertainties = [...informative.uncertainties];
    expect(applyEditorialPolicy(informative, packageEvidence).accepted_outcome).toBe("approve");
  });

  it("accepts a complete multipart README through its document citation and requires the citation itself", () => {
    const packageEvidence = evidence();
    const first = packageEvidence.sources.find((item) => item.kind === "readme")!;
    first.metadata.path = "README.md";
    first.metadata.complete_file = false;
    first.metadata.truncated = true;
    first.metadata.content_part_index = 1;
    first.metadata.content_part_count = 2;
    first.metadata.relevant_sections_complete = true;
    first.metadata.relevance_coverage = { product_identity: true, capabilities: true, usage: true, development: true };
    const second = {
      ...first,
      id: "readme-part-2",
      text: "## Development\nRun tests and follow the contributor guide.",
      metadata: { ...first.metadata, content_part_index: 2 },
    };
    packageEvidence.sources.push(second);
    const completeReview = review(packageEvidence);
    expect(applyEditorialPolicy(completeReview, packageEvidence).accepted_outcome).toBe("approve");
    completeReview.supporting_sources = completeReview.supporting_sources.filter((citation) => citation.evidence_id !== first.id);
    expect(applyEditorialPolicy(completeReview, packageEvidence).accepted_outcome).toBe("investigate");
  });

  it("accepts a complete multipart manifest when the source citation names its full document", () => {
    const packageEvidence = evidence();
    const first = packageEvidence.sources.find((item) => item.kind === "manifest")!;
    first.metadata.path = "package.json";
    first.metadata.content_part_index = 1;
    first.metadata.content_part_count = 2;
    const second = {
      ...first,
      id: "manifest-part-2",
      text: "{\"scripts\":{\"test\":\"vitest run\"}}",
      metadata: { ...first.metadata, content_part_index: 2 },
    };
    packageEvidence.sources.push(second);
    expect(applyEditorialPolicy(review(packageEvidence), packageEvidence).accepted_outcome).toBe("approve");
  });

  it("holds approvals for material uncertainty or incomplete relevant documentation", () => {
    const packageEvidence = evidence();
    const material = review(packageEvidence);
    material.material_blockers = ["The source license applicability remains unclear."];
    expect(applyEditorialPolicy(material, packageEvidence).accepted_outcome).toBe("investigate");

    const partial = review(packageEvidence);
    packageEvidence.sources[1]!.metadata.relevant_sections_complete = false;
    packageEvidence.sources[1]!.metadata.complete_file = false;
    expect(applyEditorialPolicy(partial, packageEvidence).accepted_outcome).toBe("investigate");

    const missingCoverageEvidence = evidence();
    missingCoverageEvidence.sources[1]!.metadata.complete_file = false;
    missingCoverageEvidence.sources[1]!.metadata.relevant_sections_complete = true;
    missingCoverageEvidence.sources[1]!.metadata.relevance_coverage = { product_identity: true, capabilities: true, usage: false, development: true };
    expect(applyEditorialPolicy(review(missingCoverageEvidence), missingCoverageEvidence).accepted_outcome).toBe("investigate");

    const documentationOnlyGap = evidence();
    documentationOnlyGap.sources[1]!.metadata.complete_file = false;
    documentationOnlyGap.sources[1]!.metadata.truncated = true;
    documentationOnlyGap.sources[1]!.metadata.relevant_sections_complete = true;
    documentationOnlyGap.sources[1]!.metadata.relevance_coverage = { product_identity: true, capabilities: true, usage: true, development: false };
    const supportedByBuildEvidence = review(documentationOnlyGap);
    supportedByBuildEvidence.informational_uncertainties = ["The bounded README excerpt omits development documentation; the complete package and source/test tree supply build evidence."];
    expect(applyEditorialPolicy(supportedByBuildEvidence, documentationOnlyGap).accepted_outcome).toBe("approve");
  });

  it("accepts NOASSERTION only when the complete license is corroborated by an explicit project declaration", () => {
    const packageEvidence = evidence();
    packageEvidence.sources[0]!.metadata.license_spdx_id = "NOASSERTION";
    const manifest = packageEvidence.sources.find((item) => item.kind === "manifest")!;
    manifest.text = '{"name":"task-manager","license":"MIT"}';
    manifest.sha256 = createHash("sha256").update(manifest.text).digest("hex");
    manifest.metadata.content_sha256 = manifest.sha256;
    const explicitlyDeclared = review(packageEvidence);
    expect(applyEditorialPolicy(explicitlyDeclared, packageEvidence).accepted_outcome).toBe("approve");

    const uncorroborated = evidence();
    uncorroborated.sources[0]!.metadata.license_spdx_id = "NOASSERTION";
    const uncorroboratedManifest = uncorroborated.sources.find((item) => item.kind === "manifest")!;
    uncorroboratedManifest.text = '{"name":"task-manager"}';
    uncorroboratedManifest.sha256 = createHash("sha256").update(uncorroboratedManifest.text).digest("hex");
    uncorroboratedManifest.metadata.content_sha256 = uncorroboratedManifest.sha256;
    expect(applyEditorialPolicy(review(uncorroborated), uncorroborated).accepted_outcome).toBe("investigate");
  });

  it("recognizes a complete project declaration phrased as 'MIT License' when GitHub returns NOASSERTION", () => {
    const packageEvidence = evidence();
    packageEvidence.sources[0]!.metadata.license_spdx_id = "NOASSERTION";
    const readme = packageEvidence.sources.find((item) => item.kind === "readme")!;
    readme.text = `${readme.text ?? ""}\n\nThe project is distributed under the MIT License.`;
    readme.sha256 = createHash("sha256").update(readme.text).digest("hex");
    readme.metadata.content_sha256 = readme.sha256;
    expect(applyEditorialPolicy(review(packageEvidence), packageEvidence).accepted_outcome).toBe("approve");
  });

  it("uses an explicit complete license-scope notice to resolve NOASSERTION", () => {
    const packageEvidence = evidence();
    packageEvidence.sources[0]!.metadata.license_spdx_id = "NOASSERTION";
    const license = packageEvidence.sources.find((item) => item.kind === "license")!;
    license.text = "Source code in this repository is available under the MIT License.\\nPermission is granted to use, copy, modify, and distribute the software.";
    license.sha256 = createHash("sha256").update(license.text).digest("hex");
    license.metadata.content_sha256 = license.sha256;
    expect(applyEditorialPolicy(review(packageEvidence), packageEvidence).accepted_outcome).toBe("approve");
  });

  it("reconciles a private workspace package sentinel with complete project-wide AGPL source terms", () => {
    const packageEvidence = evidence();
    packageEvidence.sources[0]!.metadata.license_spdx_id = "NOASSERTION";
    const readme = packageEvidence.sources.find((item) => item.kind === "readme")!;
    readme.text = `${readme.text ?? ""}\n\nThe open-source edition is released under the AGPL.`;
    readme.sha256 = createHash("sha256").update(readme.text).digest("hex");
    readme.metadata.content_sha256 = readme.sha256;
    const license = packageEvidence.sources.find((item) => item.kind === "license")!;
    license.text = "GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3, 19 November 2007";
    license.sha256 = createHash("sha256").update(license.text).digest("hex");
    license.metadata.content_sha256 = license.sha256;
    const manifest = packageEvidence.sources.find((item) => item.kind === "manifest")!;
    manifest.text = '{"name":"task-manager","private":true,"license":"private"}';
    manifest.sha256 = createHash("sha256").update(manifest.text).digest("hex");
    manifest.metadata.content_sha256 = manifest.sha256;
    const reviewed = review(packageEvidence);
    reviewed.eligibility.license_identifier = "AGPL-3.0-only";
    expect(applyEditorialPolicy(reviewed, packageEvidence).accepted_outcome).toBe("approve");

    manifest.text = '{"name":"task-manager","private":false,"license":"MIT"}';
    manifest.sha256 = createHash("sha256").update(manifest.text).digest("hex");
    manifest.metadata.content_sha256 = manifest.sha256;
    expect(applyEditorialPolicy(reviewed, packageEvidence).accepted_outcome).toBe("investigate");
  });

  it("does not collapse GPL-2-or-GPL-3 terms to a single catalog identifier", () => {
    const packageEvidence = evidence();
    packageEvidence.sources[0]!.metadata.license_spdx_id = "NOASSERTION";
    const readme = packageEvidence.sources.find((item) => item.kind === "readme")!;
    readme.text = `${readme.text ?? ""}\n\nThe project is licensed under GPL version 2 or GPL version 3.`;
    readme.sha256 = createHash("sha256").update(readme.text).digest("hex");
    readme.metadata.content_sha256 = readme.sha256;
    const license = packageEvidence.sources.find((item) => item.kind === "license")!;
    license.text = "GNU GENERAL PUBLIC LICENSE\\nThis program is licensed under either version 2 of the License, or (at your option) version 3.";
    license.sha256 = createHash("sha256").update(license.text).digest("hex");
    license.metadata.content_sha256 = license.sha256;
    const reviewed = review(packageEvidence);
    reviewed.eligibility.license_identifier = "GPL-2.0-only";
    const decision = applyEditorialPolicy(reviewed, packageEvidence);
    expect(decision.accepted_outcome).toBe("investigate");
    expect(decision.reasons).toContain("The source offers non-equivalent GPL version choices, but the catalog license field stores one SPDX identifier; preserve the complete choice before publication.");
  });

  it("requires all root-inventoried license files to be collected and cited completely", () => {
    const packageEvidence = evidence();
    const root = packageEvidence.sources.find((item) => item.kind === "root_contents")!;
    root.metadata.license_file_paths = ["LICENSE", "COPYING"];
    expect(applyEditorialPolicy(review(packageEvidence), packageEvidence).accepted_outcome).toBe("investigate");

    const copyingText = "Additional license terms.";
    const copying = source("copying", "license", "https://github.com/fixture/task-manager/blob/main/COPYING", copyingText, {
      path: "COPYING", content_sha256: createHash("sha256").update(copyingText).digest("hex"),
      content_part_index: 1, content_part_count: 1, complete_file: true, truncated: false,
    });
    packageEvidence.sources.push(copying);
    const completeReview = review(packageEvidence);
    completeReview.supporting_sources.push({ evidence_id: copying.id, source_url: copying.url, supports: "The complete root-inventoried COPYING file was checked for license scope and terms." });
    expect(applyEditorialPolicy(completeReview, packageEvidence).accepted_outcome).toBe("approve");
  });

  it("reconciles a legacy GPL-family label only when the complete terms and project declaration agree", () => {
    const packageEvidence = evidence();
    packageEvidence.sources[0]!.metadata.license_spdx_id = "GPL-3.0";
    const license = packageEvidence.sources.find((item) => item.kind === "license")!;
    license.text = "GNU GENERAL PUBLIC LICENSE\nThis program is licensed under either version 3 of the License, or (at your option) any later version.";
    license.sha256 = createHash("sha256").update(license.text).digest("hex");
    license.metadata.content_sha256 = license.sha256;
    const manifest = packageEvidence.sources.find((item) => item.kind === "manifest")!;
    manifest.text = "# SPDX-License-Identifier: GPL-3.0-or-later";
    manifest.sha256 = createHash("sha256").update(manifest.text).digest("hex");
    manifest.metadata.content_sha256 = manifest.sha256;
    const reviewed = review(packageEvidence);
    reviewed.eligibility.license_identifier = "GPL-3.0-or-later";
    expect(applyEditorialPolicy(reviewed, packageEvidence).accepted_outcome).toBe("approve");

    manifest.text = "# SPDX-License-Identifier: GPL-3.0-only";
    manifest.sha256 = createHash("sha256").update(manifest.text).digest("hex");
    manifest.metadata.content_sha256 = manifest.sha256;
    expect(applyEditorialPolicy(reviewed, packageEvidence).accepted_outcome).toBe("investigate");
  });

  it("requires a current, candidate-bound duplicate snapshot", () => {
    const packageEvidence = evidence();
    const check = packageEvidence.sources.find((item) => item.kind === "outlist_catalog")!.metadata.duplicate_check as Record<string, unknown>;
    check.snapshot_captured_at = new Date(reviewedAt.getTime() - 25 * 60 * 60 * 1000).toISOString();
    expect(applyEditorialPolicy(review(packageEvidence), packageEvidence, reviewedAt).accepted_outcome).toBe("investigate");

    check.snapshot_captured_at = reviewedAt.toISOString();
    check.candidate_repository_id = "999999";
    expect(applyEditorialPolicy(review(packageEvidence), packageEvidence, reviewedAt).accepted_outcome).toBe("investigate");
  });

  it("accepts rejection only when a concrete disqualifier is strongly supported", () => {
    const packageEvidence = evidence();
    const unsuitable = review(packageEvidence);
    unsuitable.outcome = "reject";
    unsuitable.eligibility.genuine_software_product = false;
    unsuitable.confidence = 0.96;
    unsuitable.supporting_sources = unsuitable.supporting_sources.slice(0, 2);
    expect(applyEditorialPolicy(unsuitable, packageEvidence).accepted_outcome).toBe("reject");

    unsuitable.eligibility.genuine_software_product = true;
    expect(applyEditorialPolicy(unsuitable, packageEvidence).accepted_outcome).toBe("investigate");

    unsuitable.eligibility.maintenance_status = "archived";
    expect(applyEditorialPolicy(unsuitable, packageEvidence).accepted_outcome).toBe("reject");
  });

  it("does not allow a website or logo without source corroboration", () => {
    const packageEvidence = evidence();
    const unverified = review(packageEvidence);
    unverified.listing.official_website_url = "https://unrelated.invalid";
    expect(applyEditorialPolicy(unverified, packageEvidence).accepted_outcome).toBe("investigate");
    const normalizedWebsite = normalizeOptionalListingUrls(unverified, packageEvidence);
    expect(normalizedWebsite.review.listing.official_website_url).toBeNull();
    expect(applyEditorialPolicy(normalizedWebsite.review, packageEvidence, reviewedAt, normalizedWebsite.adjustments).accepted_outcome).toBe("approve");

    const readme = packageEvidence.sources.find((item) => item.kind === "readme")!;
    readme.text = `${readme.text ?? ""}\n<img alt="Task Manager" src="https://raw.githubusercontent.com/fixture/task-manager/main/logo.png">`;
    readme.sha256 = createHash("sha256").update(readme.text).digest("hex");
    readme.metadata.content_sha256 = readme.sha256;
    const supportedLogo = review(packageEvidence);
    supportedLogo.listing.logo_url = "https://raw.githubusercontent.com/fixture/task-manager/main/logo.png";
    expect(applyEditorialPolicy(supportedLogo, packageEvidence).accepted_outcome).toBe("approve");
    supportedLogo.listing.logo_url = "https://raw.githubusercontent.com/fixture/task-manager/main/unrelated.png";
    expect(applyEditorialPolicy(supportedLogo, packageEvidence).accepted_outcome).toBe("investigate");
    const normalizedLogo = normalizeOptionalListingUrls(supportedLogo, packageEvidence);
    expect(normalizedLogo.review.listing.logo_url).toBeNull();
    expect(applyEditorialPolicy(normalizedLogo.review, packageEvidence, reviewedAt, normalizedLogo.adjustments).accepted_outcome).toBe("approve");
  });

  it("holds approval when the deterministic Outlist duplicate index identifies another repository or public product listing", () => {
    const packageEvidence = evidence();
    const catalog = packageEvidence.sources.find((item) => item.kind === "outlist_catalog")!;
    const check = catalog.metadata.duplicate_check as Record<string, unknown>;
    check.has_material_duplicate_conflict = true;
    check.duplicate_imported_candidates = [{ candidate_id: "another-candidate" }];
    const duplicate = review(packageEvidence);
    expect(applyEditorialPolicy(duplicate, packageEvidence).accepted_outcome).toBe("investigate");
  });

  it("holds approval when an essential evidence source is unavailable", () => {
    const packageEvidence = evidence();
    packageEvidence.sources.find((item) => item.kind === "license")!.status = "unavailable";
    expect(applyEditorialPolicy(review(packageEvidence), packageEvidence).accepted_outcome).toBe("investigate");
  });
});
