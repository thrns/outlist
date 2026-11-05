import { describe, expect, it } from "vitest";
import {
  validateSupabaseAdminEnv,
  validateSupabasePublicEnv,
} from "./env";

describe("Supabase environment validation", () => {
  it("accepts complete public configuration", () => {
    expect(
      validateSupabasePublicEnv({
        url: "https://outlist.supabase.co",
        publishableKey: "sb_publishable_example",
      }),
    ).toEqual({
      url: "https://outlist.supabase.co",
      publishableKey: "sb_publishable_example",
    });
  });

  it("reports all missing public variables when a client is invoked unconfigured", () => {
    expect(() =>
      validateSupabasePublicEnv({ url: undefined, publishableKey: undefined }),
    ).toThrow(
      "Supabase public configuration is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    );
  });

  it("rejects malformed URLs without including credential values in errors", () => {
    expect(() =>
      validateSupabasePublicEnv({
        url: "not-a-url",
        publishableKey: "safe-to-echo?no",
      }),
    ).toThrow("NEXT_PUBLIC_SUPABASE_URL must be a valid URL");
  });

  it("requires a secret key for the privileged client", () => {
    expect(() =>
      validateSupabaseAdminEnv({
        url: "https://outlist.supabase.co",
        secretKey: undefined,
      }),
    ).toThrow("Set SUPABASE_SECRET_KEY");
  });

  it("accepts admin credentials without using a browser session", () => {
    expect(
      validateSupabaseAdminEnv({
        url: "http://127.0.0.1:54321",
        secretKey: "sb_secret_example",
      }),
    ).toEqual({
      url: "http://127.0.0.1:54321",
      secretKey: "sb_secret_example",
    });
  });
});
