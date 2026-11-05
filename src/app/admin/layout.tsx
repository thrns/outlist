import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AdminAccessState } from "@/components/directory/admin-access-state";
import { getAdminIdentity } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const requestHeaders = await headers();

  // Proxy overwrites this internal header from the actual request path. The
  // login form is the only unprotected page in the /admin route tree.
  if (requestHeaders.get("x-outlist-admin-login-route") === "1") {
    return children;
  }

  const result = await getAdminIdentity();
  if (result.status === "admin") return children;
  if (result.status === "unauthenticated") redirect("/admin/login");
  if (result.status === "denied") {
    return <AdminAccessState status="denied" />;
  }
  return (
    <AdminAccessState
      status={result.reason === "configuration" ? "configuration" : "service"}
    />
  );
}
