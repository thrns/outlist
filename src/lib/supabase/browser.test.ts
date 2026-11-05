import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupabaseBrowserClient } from "./browser";

describe("Supabase browser client configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("fails informatively only when the client is invoked without public credentials", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");

    expect(() => createSupabaseBrowserClient()).toThrow(
      "Supabase public configuration is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    );
  });
});
