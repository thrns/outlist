import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  getClaims: vi.fn(),
  maybeSingle: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocks.createSupabaseServerClient,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocks.createSupabaseAdminClient,
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    mocks.redirect(path);
    throw new Error(`redirect:${path}`);
  },
}));

import {
  AdminAccessDeniedError,
  getAdminIdentity,
  requireAdmin,
} from "./admin";

const userId = "00000000-0000-4000-8000-000000000011";

function setClaims(claims: unknown, error: unknown = null) {
  mocks.getClaims.mockResolvedValue({ data: { claims }, error });
}

describe("getAdminIdentity", () => {
  afterEach(() => vi.unstubAllEnvs());

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "publishable-test-key");
    vi.stubEnv("SUPABASE_SECRET_KEY", "secret-test-key");
    mocks.getClaims.mockReset();
    mocks.redirect.mockReset();
    mocks.maybeSingle.mockReset();
    mocks.createSupabaseServerClient.mockReset().mockResolvedValue({
      auth: { getClaims: mocks.getClaims },
    });
    mocks.createSupabaseAdminClient.mockReset().mockReturnValue({
      from: () => ({
        select: () => ({
          eq: (_column: string, id: string) => {
            expect(id).toBe(userId);
            return { maybeSingle: mocks.maybeSingle };
          },
        }),
      }),
    });
    mocks.maybeSingle.mockResolvedValue({
      data: { user_id: userId },
      error: null,
    });
  });

  it("denies an unauthenticated request before checking the allowlist", async () => {
    setClaims(null);

    await expect(getAdminIdentity()).resolves.toEqual({
      status: "unauthenticated",
    });
    expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("redirects anonymous protected requests to the login page", async () => {
    setClaims(null);

    await expect(requireAdmin()).rejects.toThrow("redirect:/admin/login");
    expect(mocks.redirect).toHaveBeenCalledWith("/admin/login");
  });

  it("throws an access-denied result for an authenticated non-admin", async () => {
    setClaims({ sub: userId });
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });

    await expect(requireAdmin()).rejects.toBeInstanceOf(AdminAccessDeniedError);
  });

  it("returns the verified identity for an allowlisted administrator", async () => {
    setClaims({ sub: userId });

    await expect(requireAdmin()).resolves.toEqual({ userId });
  });

  it("denies invalid or forged claims without trusting their user object", async () => {
    setClaims({ sub: userId }, { name: "AuthApiError", message: "invalid JWT" });

    await expect(getAdminIdentity()).resolves.toEqual({
      status: "unauthenticated",
    });
    expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("denies malformed verified subject UUIDs", async () => {
    setClaims({ sub: "admin@example.com", email: "admin@example.com" });

    await expect(getAdminIdentity()).resolves.toEqual({ status: "denied" });
    expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("denies a verified user who has no exact allowlist row", async () => {
    setClaims({ sub: userId, email: "admin@example.com", role: "admin" });
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });

    await expect(getAdminIdentity()).resolves.toEqual({ status: "denied" });
    expect(mocks.maybeSingle).toHaveBeenCalledOnce();
  });

  it("allows only a verified UUID with an exact matching allowlist row", async () => {
    setClaims({ sub: userId, email: "admin@example.com", user_metadata: { role: "user" } });

    await expect(getAdminIdentity()).resolves.toEqual({
      status: "admin",
      identity: { userId },
    });
    expect(mocks.createSupabaseAdminClient).toHaveBeenCalledOnce();
    expect(mocks.maybeSingle).toHaveBeenCalledOnce();
  });

  it("observes allowlist revocation on the next protected request", async () => {
    setClaims({ sub: userId });
    mocks.maybeSingle
      .mockResolvedValueOnce({ data: { user_id: userId }, error: null })
      .mockResolvedValueOnce({ data: null, error: null });

    await expect(getAdminIdentity()).resolves.toMatchObject({ status: "admin" });
    await expect(getAdminIdentity()).resolves.toEqual({ status: "denied" });
    expect(mocks.maybeSingle).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the privileged database query fails", async () => {
    setClaims({ sub: userId });
    mocks.maybeSingle.mockResolvedValue({ data: null, error: new Error("db offline") });

    await expect(getAdminIdentity()).resolves.toEqual({
      status: "unavailable",
      reason: "service",
    });
  });

  it("fails closed with an administrator-only configuration state when credentials are missing", async () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", "");

    await expect(getAdminIdentity()).resolves.toEqual({
      status: "unavailable",
      reason: "configuration",
    });
    expect(mocks.createSupabaseServerClient).not.toHaveBeenCalled();
  });
});
