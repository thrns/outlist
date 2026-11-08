import { describe, expect, it } from "vitest";
import { isKnownOsiApprovedLicense } from "@/lib/assessment/license";
import { saveEditorialSchema, verifyLicenseSchema } from "./schemas";

const validEditorial = {
  projectId: "123e4567-e89b-42d3-a456-426614174000",
  revision: "2",
  name: "Outlist Fixture",
  summary: "A clear project summary for editorial review.",
  description: "",
  officialWebsiteUrl: "https://example.org",
  categoryIds: ["123e4567-e89b-42d3-a456-426614174001"],
  tags: ["developer tool"],
  reason: "Confirmed the text against the project's official documentation.",
};

describe("editorial action validation", () => {
  it("accepts a bounded editorial change with a safe URL and active category IDs", () => {
    expect(saveEditorialSchema.safeParse(validEditorial).success).toBe(true);
  });

  it("rejects fields outside the editorial allowlist", () => {
    expect(saveEditorialSchema.safeParse({ ...validEditorial, approved_by: "123e4567-e89b-42d3-a456-426614174000" }).success).toBe(false);
  });

  it("recognizes only current SPDX identifiers marked OSI approved", () => {
    expect(isKnownOsiApprovedLicense("MIT")).toBe(true);
    expect(isKnownOsiApprovedLicense("NOASSERTION")).toBe(false);
    expect(isKnownOsiApprovedLicense("LicenseRef-Custom")).toBe(false);
  });

  it("requires explicit human confirmation and independent non-GitHub license evidence", () => {
    const license = {
      projectId: validEditorial.projectId,
      revision: "2",
      sourceObservedAt: "2026-11-07T12:00:00.000Z",
      licenseIdentifier: "MIT",
      evidenceReference: "https://opensource.org/license/mit",
      reason: "The project license file and the Open Source Initiative listing agree.",
      confirmOpenSource: "yes",
    };
    expect(verifyLicenseSchema.safeParse(license).success).toBe(true);
    expect(verifyLicenseSchema.safeParse({ ...license, confirmOpenSource: "no" }).success).toBe(false);
    expect(verifyLicenseSchema.safeParse({ ...license, evidenceReference: "https://github.com/org/project/blob/main/LICENSE" }).success).toBe(false);
  });
});
