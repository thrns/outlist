import "server-only";

import { z } from "zod";

const adminEnvSchema = z.object({
  url: z.url(),
  secretKey: z.string().trim().min(1),
});

type AdminEnvInput = {
  url: string | undefined;
  secretKey: string | undefined;
};

function configurationError(
  label: string,
  missing: string[],
  details: string[],
): Error {
  if (missing.length > 0) {
    return new Error(
      `${label} is not configured. Set ${missing.join(" and ")} in your environment (for local development, use .env.local).`,
    );
  }

  return new Error(`${label} is invalid: ${details.join("; ")}`);
}

export function validateSupabaseAdminEnv(input: AdminEnvInput) {
  const parsed = adminEnvSchema.safeParse(input);
  if (parsed.success) return parsed.data;

  const missing: string[] = [];
  if (!input.url?.trim()) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!input.secretKey?.trim()) missing.push("SUPABASE_SECRET_KEY");

  const details = parsed.error.issues.map((issue) => {
    if (issue.path[0] === "url") {
      return "NEXT_PUBLIC_SUPABASE_URL must be a valid URL";
    }
    return "SUPABASE_SECRET_KEY must not be empty";
  });

  throw configurationError("Supabase admin configuration", missing, details);
}
