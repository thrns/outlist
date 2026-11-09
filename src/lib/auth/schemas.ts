import { z } from "zod";

export const adminEmailSchema = z
  .string()
  .trim()
  .email("Enter a valid email address.")
  .max(254, "Email address is too long.")
  .transform((email) => email.toLowerCase());

export const adminPasswordSchema = z
  .string()
  .min(1, "Enter your password.")
  .max(1024, "Password is too long.");

export const adminPasswordSignInSchema = z.object({
  email: adminEmailSchema,
  password: adminPasswordSchema,
});
