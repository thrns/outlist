import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getAdminIdentity: vi.fn(),
  signInWithPassword: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocks.createSupabaseServerClient,
}));
vi.mock("@/lib/auth/admin", () => ({
  getAdminIdentity: mocks.getAdminIdentity,
}));

import { signInAdmin } from "./actions";

const credentials = {
  email: "admin@example.com",
  password: "a strong local test password",
};
const invalidCredentials = {
  status: "invalid_credentials",
  message: "Email or password is incorrect.",
};

describe("administrator password sign-in action", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "publishable-test-key");
    vi.stubEnv("SUPABASE_SECRET_KEY", "secret-test-key");
    mocks.signInWithPassword.mockReset().mockResolvedValue({ error: null });
    mocks.signOut.mockReset().mockResolvedValue({ error: null });
    mocks.getAdminIdentity.mockReset().mockResolvedValue({
      status: "admin",
      identity: { userId: "00000000-0000-4000-8000-000000000011" },
    });
    mocks.createSupabaseServerClient.mockReset().mockResolvedValue({
      auth: {
        signInWithPassword: mocks.signInWithPassword,
        signOut: mocks.signOut,
      },
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("signs in with the supplied email and password, then verifies the allowlist", async () => {
    await expect(signInAdmin(credentials)).resolves.toEqual({
      status: "authenticated",
      message: "Administrator sign-in complete.",
    });

    expect(mocks.signInWithPassword).toHaveBeenCalledWith(credentials);
    expect(mocks.getAdminIdentity).toHaveBeenCalledOnce();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it("returns one generic response for unknown users and incorrect passwords", async () => {
    mocks.signInWithPassword.mockResolvedValueOnce({
      error: { status: 400, message: "Invalid login credentials" },
    });
    const unknownUser = await signInAdmin(credentials);
    mocks.signInWithPassword.mockResolvedValueOnce({
      error: { status: 400, message: "Invalid login credentials" },
    });
    const incorrectPassword = await signInAdmin(credentials);

    expect(unknownUser).toEqual(invalidCredentials);
    expect(incorrectPassword).toEqual(unknownUser);
    expect(mocks.getAdminIdentity).not.toHaveBeenCalled();
  });

  it("rejects missing or malformed credentials before calling Supabase", async () => {
    await expect(signInAdmin({ email: "admin@example.com" })).resolves.toEqual(
      invalidCredentials,
    );
    await expect(
      signInAdmin({ email: "bad", password: "not empty" }),
    ).resolves.toEqual(invalidCredentials);

    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
  });

  it("rejects an empty or oversized password before calling Supabase", async () => {
    await expect(signInAdmin({ email: credentials.email, password: "" })).resolves.toEqual(
      invalidCredentials,
    );
    await expect(
      signInAdmin({ email: credentials.email, password: "x".repeat(1025) }),
    ).resolves.toEqual(invalidCredentials);

    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
  });

  it("fails closed and clears the session for a valid non-allowlisted Auth user", async () => {
    mocks.getAdminIdentity.mockResolvedValueOnce({ status: "denied" });

    await expect(signInAdmin(credentials)).resolves.toEqual(invalidCredentials);

    expect(mocks.signOut).toHaveBeenCalledOnce();
  });

  it("does not expose provider details for a rate-limited Auth request", async () => {
    mocks.signInWithPassword.mockResolvedValueOnce({
      error: { status: 429, message: "internal rate-limit detail" },
    });

    await expect(signInAdmin(credentials)).resolves.toEqual({
      status: "service_error",
      message: "Sign-in is temporarily unavailable. Try again shortly.",
    });
    expect(mocks.getAdminIdentity).not.toHaveBeenCalled();
  });

  it("reports missing server configuration without attempting Auth", async () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", "");

    await expect(signInAdmin(credentials)).resolves.toMatchObject({
      status: "configuration_error",
    });
    expect(mocks.createSupabaseServerClient).not.toHaveBeenCalled();
  });
});
