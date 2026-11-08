import type { Metadata } from "next";
import { AdminPage, filterValue } from "@/components/directory/admin-page";
import { AdminAccessState } from "@/components/directory/admin-access-state";
import { AdminDataUnavailableError, getAdminQueue, type AdminQueuePage, type QueueFilter } from "@/lib/admin/review";
import { AdminAccessDeniedError, AdminAuthUnavailableError, requireAdmin } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const metadata: Metadata = {
  title: "Editorial review",
  description: "Private Outlist administrator review queue.",
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function emptyQueue(page: number) {
  return { rows: [], page, pageSize: 25, total: 0 };
}

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const selectedFilter: QueueFilter = filterValue(first(params.filter));
  const requestedPage = Number(first(params.page) ?? "1");
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  let queue: AdminQueuePage | undefined;
  let accessError: "denied" | "service" | undefined;
  let loadError = false;
  try {
    await requireAdmin();
    queue = await getAdminQueue(selectedFilter, page);
  } catch (error) {
    if (error instanceof AdminAccessDeniedError) accessError = "denied";
    else if (error instanceof AdminAuthUnavailableError) accessError = "service";
    else if (error instanceof AdminDataUnavailableError) loadError = true;
    else throw error;
  }
  if (accessError) return <AdminAccessState status={accessError} />;
  return <AdminPage queue={queue ?? emptyQueue(page)} selectedFilter={selectedFilter} error={loadError ? "load" : first(params.error)} access={first(params.access)} />;
}
