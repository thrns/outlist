import "server-only";

import { createClient } from "@supabase/supabase-js";
import { validateSupabaseAdminEnv } from "@/lib/env/admin";
import type { Database } from "@/lib/supabase/database.types";

export function createSupabaseAdminClient(options: { requestTimeoutMs?: number } = {}) {
  const { url, secretKey } = validateSupabaseAdminEnv({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    secretKey: process.env.SUPABASE_SECRET_KEY,
  });

  return createClient<Database>(url, secretKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: {
      fetch: (input, init) => {
        const timeoutSignal = options.requestTimeoutMs ? AbortSignal.timeout(options.requestTimeoutMs) : undefined;
        const signal = timeoutSignal && init?.signal
          ? AbortSignal.any([init.signal, timeoutSignal])
          : timeoutSignal ?? init?.signal;
        return fetch(input, { ...init, cache: "no-store", ...(signal ? { signal } : {}) });
      },
    },
  });
}
