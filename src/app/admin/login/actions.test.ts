import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getAdminIdentity: vi.fn(),
  signInWithOtp: vi.fn(),
  verifyOtp: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocks.createSupabaseServerClient,
}));
vi.mock("@/lib/auth/admin", () => ({
  getAdminIdentity: mocks.getAdminIdentity,
}));

import { requestAdminOtp, verifyAdminOtp } from "./actions";

const email = "admin@example.com";
const token = "123456";
const expectedRequestMessage =
  "The request was processed. If this address is enabled for administrator access, follow the instructions sent to your inbox.";

describe("administrator OTP actions", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "publishable-test-key");
    vi.stubEnv("SUPABASE_SECRET_KEY", "secret-test-key");
    mocks.signInWithOtp.mockReset().mockResolvedValue({ error: null });
    mocks.verifyOtp.mockReset().mockResolvedValue({ error: null });
    mocks.signOut.mockReset().mockResolvedValue({ error: null });
    mocks.getAdminIdentity.mockReset().mockResolvedValue({
      status: "admin",
      identity: { userId: "00000000-0000-4000-8000-000000000011" },
    });
    mocks.createSupabaseServerClient.mockReset().mockResolvedValue({
      auth: {
        signInWithOtp: mocks.signInWithOtp,
        verifyOtp: mocks.verifyOtp,
        signOut: mocks.signOut,
      },
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("requests email OTP with account creation disabled", async () => {
    const response = await requestAdminOtp({ email });

    expect(mocks.signInWithOtp).toHaveBeenCalledWith({
      email,
      options: { shouldCreateUser: false },
    });
    expect(response).toEqual({
      status: "requested",
      message: expectedRequestMessage,
    });
  });

  it("returns the same generic response whether Auth accepted or rejected an address", async () => {
    const eligible = await requestAdminOtp({ email });
    mocks.signInWithOtp.mockResolvedValueOnce({
      error: { message: "User not found" },
    });
    const unknown = await requestAdminOtp({ email: "unknown@example.com" });

    expect(eligible).toEqual(unknown);
    expect(unknown.message).not.toMatch(/exist|found|registered/i);
  });

  it("rejects malformed email input before calling Supabase", async () => {
    await expect(requestAdminOtp({ email: "bad" })).resolves.toMatchObject({
      status: "invalid",
    });
    expect(mocks.signInWithOtp).not.toHaveBeenCalled();
  });

  it("reports missing Supabase configuration without attempting Auth", async () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", "");

    await expect(requestAdminOtp({ email })).resolves.toMatchObject({
      status: "configuration_error",
    });
    expect(mocks.createSupabaseServerClient).not.toHaveBeenCalled();
  });

  it("verifies the supplied token with email OTP type", async () => {
    const response = await verifyAdminOtp({ email, token });

    expect(mocks.verifyOtp).toHaveBeenCalledWith({ email, token, type: "email" });
    expect(response.status).toBe("authenticated");
  });

  it("uses the same safe response for invalid and expired code rejections", async () => {
    mocks.verifyOtp.mockResolvedValueOnce({
      error: { code: "otp_expired", message: "expired" },
    });
    const expired = await verifyAdminOtp({ email, token });
    mocks.verifyOtp.mockResolvedValueOnce({
      error: { code: "otp_expired", message: "Token has expired or is invalid" },
    });
    const invalid = await verifyAdminOtp({ email, token });

    expect(expired.status).toBe("invalid_or_expired");
    expect(invalid).toEqual(expired);
    expect(invalid.message).not.toContain("Token has expired");
  });

  it("does not preserve a valid Auth session when the allowlist denies access", async () => {
    mocks.getAdminIdentity.mockResolvedValueOnce({ status: "denied" });

    const response = await verifyAdminOtp({ email, token });

    expect(mocks.signOut).toHaveBeenCalledOnce();
    expect(response.status).toBe("not_authorized");
  });
});
