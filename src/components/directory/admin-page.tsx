import Link from "next/link";
import { Breadcrumb } from "@/components/layout/breadcrumb";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { AdminActionSubmit } from "@/components/directory/admin-action-submit";
import { logoutAdmin } from "@/app/admin/actions";
import { ADMIN_PAGE_SIZE, type AdminQueuePage, type QueueFilter } from "@/lib/admin/review";

const filters: Array<{ id: QueueFilter; label: string }> = [
  { id: "pending", label: "Pending" },
  { id: "reviewed", label: "Reviewed" },
  { id: "published", label: "Published" },
  { id: "rejected", label: "Rejected" },
  { id: "review-required", label: "Review required" },
];

function filterValue(value: string | undefined): QueueFilter {
  return filters.some((filter) => filter.id === value) ? value as QueueFilter : "pending";
}

function displayStatus(status: string) {
  return status.replaceAll("_", " ");
}

function date(value: string | null) {
  if (!value) return "No observation";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value));
}

export function AdminPage({
  queue,
  selectedFilter,
  error,
  access,
}: {
  queue: AdminQueuePage;
  selectedFilter: QueueFilter;
  error?: string;
  access?: string;
}) {
  const pageCount = Math.max(1, Math.ceil(queue.total / ADMIN_PAGE_SIZE));
  const safePage = Math.min(queue.page, pageCount);
  return (
    <main className="container page">
      <Breadcrumb items={[{ label: "Outlist", href: "/" }, { label: "Editorial review" }]} />
      <div className="page-head" style={{ marginTop: 14 }}>
        <div>
          <h1 className="page-title">Editorial review</h1>
          <p className="muted" style={{ margin: 0 }}>Review source evidence, record human decisions, and publish eligible projects.</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button asChild variant="outline"><Link href="/explore">View public directory</Link></Button>
          <form action={logoutAdmin}><AdminActionSubmit variant="outline" pendingLabel="Signing out…">Sign out</AdminActionSubmit></form>
        </div>
      </div>

      {access === "denied" && <div className="alert-inline" role="alert"><strong>Administrator access denied.</strong> The current account is not on the administrator allowlist.</div>}
      {access === "unavailable" && <div className="alert-inline" role="alert"><strong>Access could not be verified.</strong> Try again after Supabase is available.</div>}
      {error === "load" && <div className="alert-inline" role="alert"><strong>Review data is unavailable.</strong> The database read failed, so no cached or demo data is shown.</div>}

      <div className="alert-inline" role="note"><strong>Publication policy:</strong> GitHub license detection is evidence only. Publishing requires recorded administrator license and quality decisions, current public repository evidence, active categories, and no unresolved review items.</div>

      <nav className="admin-tabs" aria-label="Project review filters">
        {filters.map((filter) => (
          <Link key={filter.id} className={`admin-tab ${selectedFilter === filter.id ? "active" : ""}`} href={`/admin?filter=${filter.id}`} aria-current={selectedFilter === filter.id ? "page" : undefined}>
            {filter.label}
          </Link>
        ))}
      </nav>

      <div className="section-head">
        <div><h2 className="section-title" style={{ fontSize: 18 }}>{filters.find((filter) => filter.id === selectedFilter)?.label} projects</h2><p className="section-subtitle">Showing {queue.rows.length ? (safePage - 1) * queue.pageSize + 1 : 0}–{Math.min(safePage * queue.pageSize, queue.total)} of {queue.total} database records.</p></div>
      </div>
      {queue.rows.length ? <div className="table-scroll">
        <table className="data-table">
          <thead><tr><th>Project and source</th><th>Primary category</th><th>Publication / assessment</th><th>License</th><th>Flags / open items</th><th>Last source observation</th><th>Priority</th></tr></thead>
          <tbody>{queue.rows.map(({ project, repository, categoryNames, assessment, openReviewItems, openReviewReasons, licenseAssessmentStatus, priority, qualityFlags }) => (
            <tr key={project.id}>
              <td><Link href={`/admin/projects/${project.id}`}><strong>{project.name || "Unnamed project"}</strong><div className="fine muted mono">{repository?.full_name ?? "Primary repository missing"}</div></Link>{repository?.canonical_url && <a className="fine muted" href={repository.canonical_url} target="_blank" rel="noreferrer">GitHub source ↗</a>}</td>
              <td>{categoryNames[0] ?? <span className="muted">Uncategorized</span>}{categoryNames.length > 1 && <div className="fine muted">+{categoryNames.length - 1} more</div>}</td>
              <td><Badge variant="dot">{displayStatus(project.publication_status)}</Badge><div className="fine muted" style={{ marginTop: 5 }}>Assessment: {assessment?.status ?? "not available"}</div></td>
              <td><Badge>{displayStatus(project.license_status)}</Badge><div className="fine muted" style={{ marginTop: 5 }}>{project.license_identifier ?? "No identifier"}</div><div className="fine muted">Assessment: {displayStatus(licenseAssessmentStatus)}</div></td>
              <td>{qualityFlags.length ? <><span>{qualityFlags.length} flag(s)</span><div className="fine muted" style={{ marginTop: 4 }}>{qualityFlags.slice(0, 2).map((flag, index) => {
                const item = typeof flag === "object" && flag !== null && !Array.isArray(flag) ? flag : {};
                const code = "code" in item && typeof item.code === "string" ? item.code : "assessment flag";
                const severity = "severity" in item && typeof item.severity === "string" ? item.severity : "review";
                return <div key={`${code}-${index}`}>{severity}: {code}</div>;
              })}</div></> : "No assessment flags"}<div className="fine muted" style={{ marginTop: 5 }}>{openReviewItems} open review item(s)</div>{openReviewReasons.map((reason, index) => <div className="fine muted" key={`${index}-${reason}`}>{reason}</div>)}</td>
              <td>{date(repository?.source_observed_at ?? assessment?.source_observed_at ?? null)}</td>
              <td><Badge variant={priority === "high" ? "dot" : "default"}>{priority}</Badge></td>
            </tr>
          ))}</tbody>
        </table>
      </div> : <EmptyState title="No projects in this view" description="The selected database filter has no review records." />}

      <div className="flex justify-between items-center gap-3 flex-wrap" style={{ marginTop: 18 }}>
        <span className="fine muted">Page {safePage} of {pageCount}</span>
        <div className="flex gap-2">
          {safePage > 1 && <Button asChild variant="outline" size="sm"><Link href={`/admin?filter=${selectedFilter}&page=${safePage - 1}`}>Previous</Link></Button>}
          {safePage < pageCount && <Button asChild variant="outline" size="sm"><Link href={`/admin?filter=${selectedFilter}&page=${safePage + 1}`}>Next</Link></Button>}
        </div>
      </div>
    </main>
  );
}

export { filterValue };
