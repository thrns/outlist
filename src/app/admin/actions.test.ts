import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  requireAdmin: vi.fn(),
  signOut: vi.fn(),
  cookies: vi.fn(),
  redirect: vi.fn(),
  cookieSet: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocks.createSupabaseServerClient,
}));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@/lib/auth/admin", () => ({
  AdminAccessDeniedError: class AdminAccessDeniedError extends Error {},
  AdminAuthUnavailableError: class AdminAuthUnavailableError extends Error {},
  requireAdmin: mocks.requireAdmin,
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    mocks.redirect(path);
    throw new Error("redirected");
  },
}));

import { logoutAdmin } from "./actions";

describe("administrator logout", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    mocks.redirect.mockReset();
    mocks.requireAdmin.mockReset().mockResolvedValue({ userId: "00000000-0000-4000-8000-000000000001" });
    mocks.cookieSet.mockReset();
    mocks.signOut.mockReset().mockResolvedValue({ error: null });
    mocks.createSupabaseServerClient.mockReset().mockResolvedValue({
      auth: { signOut: mocks.signOut },
    });
    mocks.cookies.mockReset().mockResolvedValue({
      getAll: () => [
        { name: "sb-local-auth-token", value: "opaque-session" },
        { name: "theme", value: "dark" },
      ],
      set: mocks.cookieSet,
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("invalidates the Supabase session, clears auth cookies, and redirects", async () => {
    await expect(logoutAdmin()).rejects.toThrow("redirected");

    expect(mocks.signOut).toHaveBeenCalledOnce();
    expect(mocks.requireAdmin).toHaveBeenCalledOnce();
    expect(mocks.cookieSet).toHaveBeenCalledWith(
      "sb-local-auth-token",
      "",
      expect.objectContaining({ maxAge: 0, path: "/", httpOnly: true }),
    );
    expect(mocks.cookieSet).not.toHaveBeenCalledWith(
      "theme",
      expect.anything(),
      expect.anything(),
    );
    expect(mocks.redirect).toHaveBeenCalledWith("/admin/login");
  });

  it("clears auth cookies even if Supabase is not configured", async () => {
    mocks.createSupabaseServerClient.mockRejectedValueOnce(
      new Error("missing Supabase configuration"),
    );

    await expect(logoutAdmin()).rejects.toThrow("redirected");

    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(mocks.requireAdmin).toHaveBeenCalledOnce();
    expect(mocks.cookieSet).toHaveBeenCalledOnce();
  });
});
