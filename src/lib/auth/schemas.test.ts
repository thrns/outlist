import { describe, expect, it } from "vitest";
import { adminEmailSchema, adminPasswordSchema, adminPasswordSignInSchema } from "./schemas";

describe("administrator password sign-in input validation", () => {
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

  it("requires a nonempty password and preserves its exact value", () => {
    expect(adminPasswordSchema.parse("  strong password  ")).toBe(
      "  strong password  ",
    );
    expect(adminPasswordSchema.safeParse("").success).toBe(false);
    expect(adminPasswordSchema.safeParse("x".repeat(1025)).success).toBe(false);
  });

  it("validates the complete email and password payload", () => {
    expect(
      adminPasswordSignInSchema.safeParse({
        email: " ADMIN@example.com ",
        password: "correct horse battery staple",
      }),
    ).toMatchObject({
      success: true,
      data: {
        email: "admin@example.com",
        password: "correct horse battery staple",
      },
    });
    expect(adminPasswordSignInSchema.safeParse({ email: "admin@example.com" }).success).toBe(
      false,
    );
  });
});
