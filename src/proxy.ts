import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@/lib/supabase/database.types";

const LOGIN_ROUTE_HEADER = "x-outlist-admin-login-route";

function continueAdminRequest(request: NextRequest, isLoginRoute: boolean) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete(LOGIN_ROUTE_HEADER);
  if (isLoginRoute) requestHeaders.set(LOGIN_ROUTE_HEADER, "1");

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  return response;
}

export async function proxy(request: NextRequest) {
  const isLoginRoute = request.nextUrl.pathname === "/admin/login";
  let response = continueAdminRequest(request, isLoginRoute);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) return response;

  try {
    const supabase = createServerClient<Database>(url, publishableKey, {
      cookieOptions: {
        secure: process.env.NODE_ENV === "production",
        httpOnly: true,
        sameSite: "lax",
        path: "/",
      },
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value);
          });
          response = continueAdminRequest(request, isLoginRoute);
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    });

    // getClaims verifies the token and refreshes an expiring session. Proxy
    // only maintains cookies; the admin layout and page authorize separately.
    await supabase.auth.getClaims();
  } catch {
    // The protected server layout will fail closed with a useful admin-only
    // state if the auth service or configuration is unavailable.
  }

  return response;
}

export const config = {
  matcher: ["/admin", "/admin/:path*"],
};
