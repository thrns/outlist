import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { AdminAccessState } from "@/components/directory/admin-access-state";
import { AdminProjectReview } from "@/components/directory/admin-project-review";
import { AdminDataUnavailableError, getAdminProjectReview } from "@/lib/admin/review";
import { AdminAccessDeniedError, AdminAuthUnavailableError, requireAdmin } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const metadata: Metadata = {
  title: "Project editorial review",
  description: "Private Outlist project source evidence and editorial decisions.",
  robots: { index: false, follow: false },
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  let accessError: "denied" | "service" | undefined;
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof AdminAccessDeniedError) accessError = "denied";
    else if (error instanceof AdminAuthUnavailableError) accessError = "service";
    else throw error;
  }
  if (accessError) return <AdminAccessState status={accessError} />;

  const { id } = await params;
  if (!uuidPattern.test(id)) notFound();
  let review: Awaited<ReturnType<typeof getAdminProjectReview>> = null;
  let dataUnavailable = false;
  try {
    review = await getAdminProjectReview(id);
  } catch (error) {
    if (error instanceof AdminAccessDeniedError) accessError = "denied";
    else if (error instanceof AdminAuthUnavailableError) accessError = "service";
    else if (error instanceof AdminDataUnavailableError) dataUnavailable = true;
    else throw error;
  }
  if (accessError) return <AdminAccessState status={accessError} />;
  if (dataUnavailable) return <main className="container page"><div className="alert-inline" role="alert">Review data could not be loaded from Supabase. Try again when the database is available.</div></main>;
  if (!review) notFound();
  const query = await searchParams;
  const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
  return <AdminProjectReview review={review} result={first(query.result)} error={first(query.error)} />;
}
