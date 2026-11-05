import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { validateSupabasePublicEnv } from "@/lib/env";

export async function createSupabaseServerClient() {
  const { url, publishableKey } = validateSupabasePublicEnv({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    publishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
  const cookieStore = await cookies();

  return createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Server Components cannot write cookies; Server Actions and Route Handlers can.
        }
      },
    },
  });
}
