"use client";

import { createBrowserClient } from "@supabase/ssr";
import { validateSupabasePublicEnv } from "@/lib/env";
import type { Database } from "@/lib/supabase/database.types";

export function createSupabaseBrowserClient() {
  const { url, publishableKey } = validateSupabasePublicEnv({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    publishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });

  return createBrowserClient<Database>(url, publishableKey);
}
