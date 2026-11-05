import "server-only";

import { createClient } from "@supabase/supabase-js";
import { validateSupabaseAdminEnv } from "@/lib/env";

export function createSupabaseAdminClient() {
  const { url, secretKey } = validateSupabaseAdminEnv({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    secretKey: process.env.SUPABASE_SECRET_KEY,
  });

  return createClient(url, secretKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}
