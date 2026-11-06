import { describe, expect, it } from "vitest";
import { assessLicense, SPDX_LICENSE_LIST_VERSION, type LicenseObservation } from "./license";

const observation = (value: string | null, method: LicenseObservation["method"] = "repository_metadata", state: LicenseObservation["state"] = value === null ? "null" : "present"): LicenseObservation => ({
  value, method, state, observedAt: "2026-11-05T12:00:00.000Z", sourceRecordId: "00000000-0000-4000-8000-000000000001",
});

describe("conservative GitHub license assessment", () => {
  it("recognizes an OSI-approved SPDX ID without verification", () => {
    expect(assessLicense([observation("MIT")])).toMatchObject({ status: "recognized_osi_approved", osiApproved: true, projectLicenseStatus: "unverified", requiresReview: true, spdxListVersion: SPDX_LICENSE_LIST_VERSION });
  });
  it("recognizes an SPDX ID that is not marked OSI-approved", () => {
    expect(assessLicense([observation("CC-BY-4.0")])).toMatchObject({ status: "recognized_not_osi_approved", osiApproved: false, projectLicenseStatus: "unverified" });
  });
  it("reports unknown identifiers conservatively", () => {
    expect(assessLicense([observation("NOT-A-REAL-SPDX-ID")])).toMatchObject({ status: "unknown_identifier", projectLicenseStatus: "needs_review", osiApproved: null });
  });
  it("handles NOASSERTION distinctly", () => {
    expect(assessLicense([observation("NOASSERTION")])).toMatchObject({ status: "noassertion", projectLicenseStatus: "needs_review" });
  });
  it("distinguishes missing data from unavailable evidence", () => {
    expect(assessLicense([observation(null)])).toMatchObject({ status: "missing", projectLicenseStatus: "unknown" });
    expect(assessLicense([observation(null, "github_license_endpoint", "unavailable")])).toMatchObject({ status: "unavailable", projectLicenseStatus: "needs_review" });
  });
  it("treats an empty observation set as incomplete source evidence", () => {
    expect(assessLicense([])).toMatchObject({ status: "unavailable", projectLicenseStatus: "needs_review" });
  });
  it("leaves compound expressions for additional evaluation", () => {
    expect(assessLicense([observation("MIT OR Apache-2.0")])).toMatchObject({ status: "complex_expression", projectLicenseStatus: "needs_review", requiresReview: true });
  });
  it("flags disagreement across source observations", () => {
    const sourceEvidence = [observation("MIT"), observation("Apache-2.0", "github_license_endpoint")];
    expect(assessLicense(sourceEvidence)).toMatchObject({ status: "conflicting_evidence", projectLicenseStatus: "needs_review" });
    expect(assessLicense(sourceEvidence)).toEqual(assessLicense(sourceEvidence.reverse()));
  });
  it("retains provenance without any license body", () => {
    const result = assessLicense([observation("MIT")]);
    expect(result.evidence[0]).toMatchObject({ method: "repository_metadata", observedAt: "2026-11-05T12:00:00.000Z", sourceRecordId: "00000000-0000-4000-8000-000000000001" });
    expect(JSON.stringify(result)).not.toContain("licenseText");
  });
  it("accepts Postgres timestamps with explicit UTC offsets", () => {
    expect(assessLicense([{ ...observation("MIT"), observedAt: "2026-11-05T12:00:00+00:00" }]).status).toBe("recognized_osi_approved");
  });
});
