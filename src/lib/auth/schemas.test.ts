import { describe, expect, it } from "vitest";
import { adminEmailSchema, adminOtpSchema } from "./schemas";

describe("administrator login input validation", () => {
  it("normalizes a valid email address", () => {
    expect(adminEmailSchema.parse("  ADMIN@Example.COM  ")).toBe(
      "admin@example.com",
    );
  });

  it("rejects malformed and oversized email addresses", () => {
    expect(adminEmailSchema.safeParse("not-an-email").success).toBe(false);
    expect(adminEmailSchema.safeParse(`${"a".repeat(250)}@x.co`).success).toBe(
      false,
    );
  });

  it("accepts numeric OTP lengths supported by Auth settings", () => {
    expect(adminOtpSchema.safeParse("123456").success).toBe(true);
    expect(adminOtpSchema.safeParse("12345678").success).toBe(true);
  });

  it("rejects short, long, and non-numeric OTP values", () => {
    expect(adminOtpSchema.safeParse("12345").success).toBe(false);
    expect(adminOtpSchema.safeParse("123456789").success).toBe(false);
    expect(adminOtpSchema.safeParse("12ab56").success).toBe(false);
  });
});
