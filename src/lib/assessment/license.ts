import spdxSnapshot from "./data/spdx-licenses-3.29.0.json";
import { z } from "zod";

export const SPDX_LICENSE_LIST_VERSION = spdxSnapshot.licenseListVersion;
export const LICENSE_POLICY_VERSION = "outlist-license-evidence-v1" as const;
const licenseIds = new Map(spdxSnapshot.licenses.map((license) => [license.licenseId, {
  name: license.name, osiApproved: license.isOsiApproved === true, deprecated: license.isDeprecatedLicenseId,
}]));
const observationSchema = z.object({
  value: z.string().max(128).nullable(),
  state: z.enum(["present", "null", "absent", "unavailable", "unsupported"]),
  method: z.enum(["repository_metadata", "github_license_endpoint"]),
  observedAt: z.iso.datetime({ offset: true }).nullable(),
  sourceRecordId: z.string().uuid().nullable().optional(),
}).strict().superRefine((observation, context) => {
  if (observation.state === "present" && !observation.value?.trim()) {
    context.addIssue({ code: "custom", message: "A present license observation needs a bounded identifier.", path: ["value"] });
  }
  if (observation.state !== "present" && observation.value !== null) {
    context.addIssue({ code: "custom", message: "A non-present license observation must not include an identifier.", path: ["value"] });
  }
});

export type LicenseObservation = {
  value: string | null;
  state: "present" | "null" | "absent" | "unavailable" | "unsupported";
  method: "repository_metadata" | "github_license_endpoint";
  observedAt: string | null;
  sourceRecordId?: string | null;
};
export type LicenseAssessmentStatus = "recognized_osi_approved" | "recognized_not_osi_approved" | "missing" | "noassertion" | "unknown_identifier" | "complex_expression" | "conflicting_evidence" | "unavailable";
export type LicenseAssessment = {
  policyVersion: typeof LICENSE_POLICY_VERSION;
  spdxListVersion: string;
  status: LicenseAssessmentStatus;
  identifier: string | null;
  osiApproved: boolean | null;
  projectLicenseStatus: "unknown" | "unverified" | "needs_review";
  evidence: Array<{ method: LicenseObservation["method"]; state: LicenseObservation["state"]; value: string | null; observedAt: string | null; sourceRecordId?: string | null }>;
  explanation: string;
  requiresReview: boolean;
};

function parseObservation(observation: LicenseObservation) {
  if (observation.state !== "present" || !observation.value?.trim()) return null;
  return observation.value.trim();
}

export function assessLicense(observations: LicenseObservation[]): LicenseAssessment {
  if (observations.length > 4) throw new TypeError("At most four license observations may be assessed.");
  observations = observations.map((observation) => observationSchema.parse(observation)).sort((a, b) => {
    const left = `${a.method}\0${a.state}\0${a.value ?? ""}\0${a.observedAt ?? ""}\0${a.sourceRecordId ?? ""}`;
    const right = `${b.method}\0${b.state}\0${b.value ?? ""}\0${b.observedAt ?? ""}\0${b.sourceRecordId ?? ""}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const evidence = observations.map((observation) => ({
    method: observation.method, state: observation.state,
    value: observation.value?.slice(0, 128) ?? null, observedAt: observation.observedAt,
    ...(observation.sourceRecordId ? { sourceRecordId: observation.sourceRecordId } : {}),
  }));
  const values = observations.map(parseObservation).filter((value): value is string => value !== null);
  const unique = [...new Set(values)];
  let status: LicenseAssessmentStatus;
  let identifier: string | null = null;
  let osiApproved: boolean | null = null;
  let explanation: string;
  let projectLicenseStatus: LicenseAssessment["projectLicenseStatus"];

  if (unique.length > 1) {
    status = "conflicting_evidence"; explanation = "GitHub license observations disagree; an editor must review the source evidence.";
    projectLicenseStatus = "needs_review";
  } else if (unique[0] === "NOASSERTION") {
    status = "noassertion"; explanation = "GitHub returned NOASSERTION; this does not establish whether terms are present.";
    projectLicenseStatus = "needs_review";
  } else if (unique[0] && /\b(?:AND|OR|WITH)\b|[()]/.test(unique[0])) {
    status = "complex_expression"; identifier = unique[0].slice(0, 128);
    explanation = "A compound SPDX expression needs additional evaluation."; projectLicenseStatus = "needs_review";
  } else if (unique[0] && licenseIds.has(unique[0])) {
    identifier = unique[0];
    const match = licenseIds.get(identifier)!;
    osiApproved = match.osiApproved;
    status = match.osiApproved ? "recognized_osi_approved" : "recognized_not_osi_approved";
    explanation = `SPDX ${SPDX_LICENSE_LIST_VERSION} recognizes ${identifier}${match.deprecated ? " as a deprecated identifier" : ""}; GitHub detection is source evidence, not legal verification.`;
    projectLicenseStatus = "unverified";
  } else if (unique[0]) {
    status = "unknown_identifier"; identifier = unique[0].slice(0, 128);
    explanation = "The reported identifier is not in the pinned SPDX License List."; projectLicenseStatus = "needs_review";
  } else if (!observations.length || observations.some((observation) => observation.state === "unavailable" || observation.state === "unsupported")) {
    status = "unavailable"; explanation = "License source evidence is unavailable or incomplete."; projectLicenseStatus = "needs_review";
  } else {
    status = "missing"; explanation = "No license identifier was detected; absence of detection is not proof of proprietary licensing.";
    projectLicenseStatus = "unknown";
  }
  return {
    policyVersion: LICENSE_POLICY_VERSION, spdxListVersion: SPDX_LICENSE_LIST_VERSION,
    status, identifier, osiApproved, projectLicenseStatus, evidence, explanation,
    requiresReview: true,
  };
}
