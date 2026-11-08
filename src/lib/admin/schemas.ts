import { z } from "zod";
import { isKnownOsiApprovedLicense } from "@/lib/assessment/license";

const uuid = z.uuid();
const reason = z.string().trim().min(8).max(1000);

const httpUrl = z.string().trim().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && Boolean(url.hostname)
      && !url.username && !url.password
      && !["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}, "Enter a safe HTTP or HTTPS URL.");

export const projectRouteSchema = z.object({ projectId: uuid }).strict();

export const saveEditorialSchema = z.object({
  projectId: uuid,
  revision: z.coerce.number().int().nonnegative(),
  name: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(10).max(280),
  description: z.string().max(10000),
  officialWebsiteUrl: z.union([z.literal(""), httpUrl]),
  categoryIds: z.array(uuid).min(1).max(8).refine((values) => new Set(values).size === values.length),
  tags: z.array(z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9][A-Za-z0-9 -]*$/)).max(20)
    .refine((values) => new Set(values.map((value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""))).size === values.length),
  reason,
}).strict();

export const verifyLicenseSchema = z.object({
  projectId: uuid,
  revision: z.coerce.number().int().nonnegative(),
  sourceObservedAt: z.iso.datetime({ offset: true }),
  licenseIdentifier: z.string().trim().min(1).max(128)
    .refine(isKnownOsiApprovedLicense, "Use a current SPDX identifier on the pinned OSI-approved list."),
  evidenceReference: httpUrl.refine((value) => {
    try {
      const host = new URL(value).hostname.toLowerCase();
      return host !== "github.com" && !host.endsWith(".github.com");
    } catch {
      return false;
    }
  }, "Provide independent licensing evidence outside GitHub."),
  reason: z.string().trim().min(20).max(1000),
  confirmOpenSource: z.literal("yes"),
}).strict();

export const verifyQualitySchema = z.object({
  projectId: uuid,
  revision: z.coerce.number().int().nonnegative(),
  sourceObservedAt: z.iso.datetime({ offset: true }),
  reason: z.string().trim().min(20).max(1000),
  confirmReview: z.literal("yes"),
}).strict();

export const reviewStateSchema = z.object({
  projectId: uuid,
  revision: z.coerce.number().int().nonnegative(),
  decision: z.enum(["keep_pending", "mark_review_required", "reject", "return_to_review"]),
  reason,
}).strict();

export const resolveReviewItemSchema = z.object({
  projectId: uuid,
  queueId: uuid,
  revision: z.coerce.number().int().nonnegative(),
  reason,
}).strict();

export const publishProjectSchema = z.object({
  projectId: uuid,
  revision: z.coerce.number().int().nonnegative(),
  reason,
}).strict();

export function formString(formData: FormData, key: string): string {
  const values = formData.getAll(key);
  return values.length === 1 && typeof values[0] === "string" ? values[0] : "__invalid_form_value__";
}

export function formStrings(formData: FormData, key: string): string[] {
  return formData.getAll(key).filter((value): value is string => typeof value === "string");
}
