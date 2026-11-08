import Link from "next/link";
import { Breadcrumb } from "@/components/layout/breadcrumb";
import { Glyph } from "@/components/project/glyph";
import { Button } from "@/components/ui/button";

export function SubmissionPage() {
  return (
    <main className="container page">
      <Breadcrumb items={[{ label: "Home", href: "/" }, { label: "Submit a project" }]} />
      <div className="page-head" style={{ marginTop: 15 }}>
        <div>
          <div className="eyebrow muted">Grow the directory</div>
          <h1 className="page-title">Project submissions are unavailable</h1>
          <p className="muted" style={{ margin: 0 }}>Outlist does not currently have a persistent public submission and moderation queue.</p>
        </div>
      </div>
      <div className="empty-state" role="status">
        <Glyph name="info" size="lg" />
        <strong>No submission was created</strong>
        <p>Submissions will reopen when they can be stored for administrator review. Nothing has been saved in this browser.</p>
        <Button asChild variant="outline"><Link href="/explore">Browse published projects <Glyph name="arrow" /></Link></Button>
      </div>
    </main>
  );
}
