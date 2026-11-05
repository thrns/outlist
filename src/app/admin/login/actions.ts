"use server";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getAdminIdentity } from "@/lib/auth/admin";
import { validateSupabaseAdminEnv } from "@/lib/env/admin";
import { validateSupabasePublicEnv } from "@/lib/env/public";
import {
  adminOtpRequestSchema,
  adminOtpVerificationSchema,
} from "@/lib/auth/schemas";

export type AdminAuthActionResult = {
  status:
    | "requested"
    | "authenticated"
    | "invalid"
    | "invalid_or_expired"
    | "not_authorized"
    | "configuration_error"
    | "service_error";
  message: string;
};

const GENERIC_REQUEST_MESSAGE =
  "The request was processed. If this address is enabled for administrator access, follow the instructions sent to your inbox.";

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

export async function requestAdminOtp(
  input: unknown,
): Promise<AdminAuthActionResult> {
  const parsed = adminOtpRequestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: "invalid",
      message: "Enter a valid email address.",
    };
  }
  if (!hasAdminAuthConfiguration()) return configurationError();

  let supabase;
  try {
    supabase = await createSupabaseServerClient();
  } catch {
    return configurationError();
  }

  try {
    await supabase.auth.signInWithOtp({
      email: parsed.data.email,
      options: { shouldCreateUser: false },
    });
  } catch {
    // Keep Auth service errors and account-existence outcomes indistinguishable.
  }

  return { status: "requested", message: GENERIC_REQUEST_MESSAGE };
}

export async function verifyAdminOtp(
  input: unknown,
): Promise<AdminAuthActionResult> {
  const parsed = adminOtpVerificationSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: "invalid",
      message: "Enter the one-time code from your email.",
    };
  }
  if (!hasAdminAuthConfiguration()) return configurationError();

  let supabase;
  try {
    supabase = await createSupabaseServerClient();
  } catch {
    return configurationError();
  }

  let verificationError: unknown;
  try {
    const { error } = await supabase.auth.verifyOtp({
      email: parsed.data.email,
      token: parsed.data.token,
      type: "email",
    });
    verificationError = error;
  } catch (error) {
    verificationError = error;
  }

  if (verificationError) {
    if (
      verificationError instanceof TypeError ||
      (typeof verificationError === "object" &&
        verificationError !== null &&
        "name" in verificationError &&
        verificationError.name === "AuthRetryableFetchError")
    ) {
      return {
        status: "service_error",
        message:
          "Administrator sign-in is temporarily unavailable. Try again shortly.",
      };
    }
    return {
      status: "invalid_or_expired",
      message: "That code is invalid or expired. Request a new one to continue.",
    };
  }

  const authorization = await getAdminIdentity();
  if (authorization.status === "admin") {
    return {
      status: "authenticated",
      message: "Administrator sign-in complete.",
    };
  }

  try {
    await supabase.auth.signOut();
  } catch {
    // signOut also clears the local cookie session when Auth is unreachable.
  }

  if (authorization.status === "unavailable") {
    return authorization.reason === "configuration"
      ? configurationError()
      : {
          status: "service_error",
          message:
            "Administrator access could not be verified. Try again shortly.",
        };
  }
  return {
    status: "not_authorized",
    message:
      "Sign-in could not be completed. Check the code or contact the site administrator.",
  };
}
