"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AdminAccessDeniedError, AdminAuthUnavailableError, requireAdmin } from "@/lib/auth/admin";
import {
  formString,
  formStrings,
  publishProjectSchema,
  resolveReviewItemSchema,
  reviewStateSchema,
  saveEditorialSchema,
  verifyLicenseSchema,
  verifyQualitySchema,
} from "@/lib/admin/schemas";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

async function authorizedAdmin() {
  try {
    return await requireAdmin();
  } catch (error) {
    if (error instanceof AdminAccessDeniedError) redirect("/admin?access=denied");
    if (error instanceof AdminAuthUnavailableError) redirect("/admin?access=unavailable");
    throw error;
  }
}

function actionErrorCode(code: string | undefined): string {
  if (code === "42501") return "permission";
  if (code === "40001") return "stale";
  if (code === "23514") return "requirements";
  if (code === "22023") return "validation";
  if (code === "55000") return "transition";
  if (code === "P0002") return "missing";
  return "service";
}

async function runProjectAction<T extends { projectId: string }>(
  formData: FormData,
  schema: { safeParse(input: unknown): { success: boolean; data?: T } },
  candidate: unknown,
  action: (userId: string, value: T) => PromiseLike<{ error: { code?: string } | null }>,
  result: string,
): Promise<never> {
  const identity = await authorizedAdmin();
  const routeProjectId = formString(formData, "projectId");
  const parsed = schema.safeParse(candidate);
  const route = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(routeProjectId)
    ? `/admin/projects/${routeProjectId}`
    : "/admin";
  if (!parsed.success || !parsed.data) redirect(`${route}?error=invalid`);
  let operationErrorCode: string | undefined;
  try {
    const { error } = await action(identity.userId, parsed.data);
    operationErrorCode = error?.code;
  } catch {
    redirect(`${route}?error=service`);
  }
  if (operationErrorCode) redirect(`${route}?error=${actionErrorCode(operationErrorCode)}`);
  redirect(`${route}?result=${result}`);
}

function common(formData: FormData) {
  return {
    projectId: formString(formData, "projectId"),
    revision: formString(formData, "revision"),
  };
}

export async function saveProjectEditorial(formData: FormData): Promise<never> {
  const base = common(formData);
  const tags = formString(formData, "tags").split(/[\n,]+/).map((tag) => tag.trim()).filter(Boolean);
  const candidate = {
    ...base,
    name: formString(formData, "name"),
    summary: formString(formData, "summary"),
    description: formString(formData, "description"),
    officialWebsiteUrl: formString(formData, "officialWebsiteUrl"),
    categoryIds: formStrings(formData, "categoryIds"),
    tags,
    reason: formString(formData, "reason"),
  };
  return runProjectAction(formData, saveEditorialSchema, candidate, (userId, value) => {
    const supabase = createSupabaseAdminClient();
    return supabase.rpc("admin_save_project_editorial", {
      p_actor: userId,
      p_project_id: value.projectId,
      p_expected_revision: value.revision,
      p_changes: {
        name: value.name,
        summary: value.summary,
        description: value.description,
        official_website_url: value.officialWebsiteUrl,
      },
      p_category_ids: value.categoryIds,
      p_tags: value.tags,
      p_reason: value.reason,
    });
  }, "saved");
}

export async function verifyProjectLicense(formData: FormData): Promise<never> {
  const candidate = {
    ...common(formData),
    licenseIdentifier: formString(formData, "licenseIdentifier"),
    sourceObservedAt: formString(formData, "sourceObservedAt"),
    evidenceReference: formString(formData, "evidenceReference"),
    reason: formString(formData, "reason"),
    confirmOpenSource: formString(formData, "confirmOpenSource"),
  };
  return runProjectAction(formData, verifyLicenseSchema, candidate, (userId, value) => {
    const supabase = createSupabaseAdminClient();
    return supabase.rpc("admin_verify_project_license", {
      p_actor: userId,
      p_project_id: value.projectId,
      p_expected_revision: value.revision,
      p_expected_source_observed_at: value.sourceObservedAt,
      p_license_identifier: value.licenseIdentifier,
      p_evidence_reference: value.evidenceReference,
      p_reason: value.reason,
      p_confirm_open_source: value.confirmOpenSource === "yes",
    });
  }, "license-verified");
}

export async function verifyProjectQuality(formData: FormData): Promise<never> {
  const candidate = {
    ...common(formData),
    sourceObservedAt: formString(formData, "sourceObservedAt"),
    reason: formString(formData, "reason"),
    confirmReview: formString(formData, "confirmReview"),
  };
  return runProjectAction(formData, verifyQualitySchema, candidate, (userId, value) => {
    const supabase = createSupabaseAdminClient();
    return supabase.rpc("admin_verify_project_quality", {
      p_actor: userId,
      p_project_id: value.projectId,
      p_expected_revision: value.revision,
      p_expected_source_observed_at: value.sourceObservedAt,
      p_reason: value.reason,
      p_confirm_review: value.confirmReview === "yes",
    });
  }, "quality-verified");
}

export async function setProjectReviewState(formData: FormData): Promise<never> {
  const candidate = {
    ...common(formData),
    decision: formString(formData, "decision"),
    reason: formString(formData, "reason"),
  };
  return runProjectAction(formData, reviewStateSchema, candidate, (userId, value) => {
    const supabase = createSupabaseAdminClient();
    return supabase.rpc("admin_set_project_review_state", {
      p_actor: userId,
      p_project_id: value.projectId,
      p_expected_revision: value.revision,
      p_action: value.decision,
      p_reason: value.reason,
    });
  }, "review-updated");
}

export async function resolveProjectReviewItem(formData: FormData): Promise<never> {
  const candidate = {
    ...common(formData),
    queueId: formString(formData, "queueId"),
    reason: formString(formData, "reason"),
  };
  return runProjectAction(formData, resolveReviewItemSchema, candidate, (userId, value) => {
    const supabase = createSupabaseAdminClient();
    return supabase.rpc("admin_resolve_project_review_item", {
      p_actor: userId,
      p_project_id: value.projectId,
      p_queue_id: value.queueId,
      p_expected_revision: value.revision,
      p_reason: value.reason,
    });
  }, "review-item-resolved");
}

export async function publishProject(formData: FormData): Promise<never> {
  const candidate = {
    ...common(formData),
    reason: formString(formData, "reason"),
  };
  return runProjectAction(formData, publishProjectSchema, candidate, (userId, value) => {
    const supabase = createSupabaseAdminClient();
    return supabase.rpc("admin_publish_project", {
      p_actor: userId,
      p_project_id: value.projectId,
      p_expected_revision: value.revision,
      p_reason: value.reason,
    });
  }, "published");
}

export async function logoutAdmin(): Promise<never> {
  await authorizedAdmin();
  try {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
  } catch {
    // Clear the browser's server-managed session even if Auth is unavailable.
  }

  try {
    const cookieStore = await cookies();
    for (const cookie of cookieStore.getAll()) {
      if (cookie.name.startsWith("sb-") && cookie.name.includes("-auth-token")) {
        cookieStore.set(cookie.name, "", {
          path: "/",
          maxAge: 0,
          expires: new Date(0),
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
        });
      }
    }
  } catch {
    // The redirect still removes this browser from the protected route flow.
  }

  redirect("/admin/login");
}
