import type { Metadata } from "next";
import { AdminLoginForm } from "@/components/directory/admin-login-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Administrator sign in",
  description: "Invite-only sign in for Outlist administrators.",
  robots: { index: false, follow: false },
};

export default function AdminLoginPage() {
  return <AdminLoginForm />;
}
