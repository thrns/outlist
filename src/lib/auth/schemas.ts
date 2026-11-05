import { z } from "zod";

export const adminEmailSchema = z
  .string()
  .trim()
  .email("Enter a valid email address.")
  .max(254, "Email address is too long.")
  .transform((email) => email.toLowerCase());

export const adminOtpSchema = z
  .string()
  .trim()
  .regex(/^\d{6,8}$/, "Enter the one-time code from your email.");

export const adminOtpRequestSchema = z.object({ email: adminEmailSchema });
export const adminOtpVerificationSchema = z.object({
  email: adminEmailSchema,
  token: adminOtpSchema,
});
