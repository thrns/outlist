import "server-only";

import { redirect } from "next/navigation";
import {
  validateSupabaseAdminEnv,
} from "@/lib/env/admin";
import { validateSupabasePublicEnv } from "@/lib/env/public";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type AdminIdentity = { userId: string };

export type AdminIdentityResult =
  | { status: "admin"; identity: AdminIdentity }
  | { status: "unauthenticated" }
  | { status: "denied" }
  | { status: "unavailable"; reason: "configuration" | "service" };

export class AdminAccessDeniedError extends Error {
  constructor() {
    super("Administrator access is not allowed.");
    this.name = "AdminAccessDeniedError";
  }
}

export class AdminAuthUnavailableError extends Error {
  constructor() {
    super("Administrator access could not be verified.");
    this.name = "AdminAuthUnavailableError";
  }
}

function isAdminAuthConfigured() {
  try {
    validateSupabasePublicEnv({
      url: process.env.NEXT_PUBLIC_SUPABASE_URL,
      publishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    });
    validateSupabaseAdminEnv({
      url: process.env.NEXT_PUBLIC_SUPABASE_URL,
      secretKey: process.env.SUPABASE_SECRET_KEY,
    });
    return true;
  } catch {
    return false;
  }
}

function isRetryableAuthFailure(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "AuthRetryableFetchError" || error.name === "TypeError")
  );
}

/**
 * Verifies the cookie-backed identity and performs a fresh privileged lookup
 * for every call. No email, user metadata, or client-supplied role is trusted.
 */
export async function getAdminIdentity(): Promise<AdminIdentityResult> {
  if (!isAdminAuthConfigured()) {
    return { status: "unavailable", reason: "configuration" };
  }

  let claims: { sub?: unknown } | null;
  try {
    const supabase = await createSupabaseServerClient();
    const result = await supabase.auth.getClaims();
    if (result.error) {
      return isRetryableAuthFailure(result.error)
        ? { status: "unavailable", reason: "service" }
        : { status: "unauthenticated" };
    }
    if (!result.data) return { status: "unauthenticated" };
    claims = result.data.claims;
  } catch {
    return { status: "unavailable", reason: "service" };
  }

  if (!claims) return { status: "unauthenticated" };
  if (typeof claims.sub !== "string") return { status: "denied" };

  // Auth user IDs are UUIDs. Reject malformed claims before they reach PostgREST.
  const userId = claims.sub;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    return { status: "denied" };
  }

  try {
    const admin = createSupabaseAdminClient();
    const { data, error } = await admin
      .from("admin_users")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) return { status: "unavailable", reason: "service" };
    if (!data || data.user_id !== userId) return { status: "denied" };
    return { status: "admin", identity: { userId } };
  } catch {
    return { status: "unavailable", reason: "service" };
  }
}

/** Call from each protected Server Component, Server Action, and Route Handler. */
export async function requireAdmin(): Promise<AdminIdentity> {
  const result = await getAdminIdentity();
  if (result.status === "admin") return result.identity;
  if (result.status === "unauthenticated") redirect("/admin/login");
  if (result.status === "denied") throw new AdminAccessDeniedError();
  throw new AdminAuthUnavailableError();
}
