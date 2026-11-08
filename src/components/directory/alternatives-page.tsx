import Link from "next/link";
import { Glyph } from "@/components/project/glyph";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export function AlternativesPage() {
  return (
    <main className="container page">
      <div className="eyebrow muted">Open-source alternatives</div>
      <h1 className="page-title" style={{ maxWidth: 750, fontSize: 36 }}>Great software. More freedom.</h1>
      <p className="muted" style={{ maxWidth: 650, margin: "0 0 28px", fontSize: 15 }}>
        Find open-source options for the proprietary tools you already know.
      </p>
      <EmptyState
        icon={<Glyph name="list" size="lg" />}
        title="Approved alternative relationships are not available yet"
        description="This page will list alternatives after relationships have been reviewed and published in the catalog. No unverified recommendations are shown."
      >
        <Button asChild variant="outline"><Link href="/explore">Browse published projects <Glyph name="arrow" /></Link></Button>
      </EmptyState>
    </main>
  );
}
