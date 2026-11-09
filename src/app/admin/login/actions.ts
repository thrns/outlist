"use server";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAdminIdentity } from "@/lib/auth/admin";
import { validateSupabaseAdminEnv } from "@/lib/env/admin";
import { validateSupabasePublicEnv } from "@/lib/env/public";
import { adminPasswordSignInSchema } from "@/lib/auth/schemas";

export type AdminAuthActionResult = {
  status:
    | "authenticated"
    | "invalid_credentials"
    | "configuration_error"
    | "service_error";
  message: string;
};

const INVALID_CREDENTIALS_MESSAGE = "Email or password is incorrect.";

function hasAdminAuthConfiguration() {
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

function configurationError(): AdminAuthActionResult {
  return {
    status: "configuration_error",
    message:
      "Administrator sign-in is not configured on this server. Contact the site administrator.",
  };
}

function serviceError(): AdminAuthActionResult {
  return {
    status: "service_error",
    message: "Sign-in is temporarily unavailable. Try again shortly.",
  };
}

function isRetryableAuthFailure(error: unknown) {
  if (error instanceof TypeError) return true;
  if (typeof error !== "object" || error === null) return false;

  if (
    "name" in error &&
    (error.name === "AuthRetryableFetchError" || error.name === "TypeError")
  ) {
    return true;
  }

  return "status" in error &&
    typeof error.status === "number" &&
    (error.status === 429 || error.status >= 500);
}

async function clearUnverifiedSession(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
) {
  try {
    await supabase.auth.signOut();
  } catch {
    // Supabase SSR clears the local session cookie when signOut is available.
  }
}

export async function signInAdmin(input: unknown): Promise<AdminAuthActionResult> {
  const parsed = adminPasswordSignInSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: "invalid_credentials",
      message: INVALID_CREDENTIALS_MESSAGE,
    };
  }
  if (!hasAdminAuthConfiguration()) return configurationError();

  let supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  try {
    supabase = await createSupabaseServerClient();
  } catch {
    return configurationError();
  }

  try {
    const { error } = await supabase.auth.signInWithPassword({
      email: parsed.data.email,
      password: parsed.data.password,
    });

    if (error) {
      return isRetryableAuthFailure(error)
        ? serviceError()
        : {
            status: "invalid_credentials",
            message: INVALID_CREDENTIALS_MESSAGE,
          };
    }
  } catch (error) {
    return isRetryableAuthFailure(error)
      ? serviceError()
      : {
          status: "invalid_credentials",
          message: INVALID_CREDENTIALS_MESSAGE,
        };
  }

  let authorization;
  try {
    authorization = await getAdminIdentity();
  } catch {
    await clearUnverifiedSession(supabase);
    return serviceError();
  }

  if (authorization.status === "admin") {
    return {
      status: "authenticated",
      message: "Administrator sign-in complete.",
    };
  }

  await clearUnverifiedSession(supabase);

  if (authorization.status === "unavailable") {
    return authorization.reason === "configuration"
      ? configurationError()
      : serviceError();
  }

  // Keep a valid but non-allowlisted Auth account indistinguishable from bad
  // credentials in the public login response.
  return {
    status: "invalid_credentials",
    message: INVALID_CREDENTIALS_MESSAGE,
  };
}
