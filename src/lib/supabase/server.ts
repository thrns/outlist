import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { validateSupabasePublicEnv } from "@/lib/env/public";
import type { Database } from "@/lib/supabase/database.types";

export async function createSupabaseServerClient() {
  const { url, publishableKey } = validateSupabasePublicEnv({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    publishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
  const cookieStore = await cookies();

  return createServerClient<Database>(url, publishableKey, {
    global: {
      // Public catalog reads must reflect current RLS visibility. In particular,
      // a safety demotion must take effect on the next request.
      fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }),
    },
    cookieOptions: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    },
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
