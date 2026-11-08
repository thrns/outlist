import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Glyph } from "@/components/project/glyph";

export function CatalogError({ description, retryHref = "/", title = "Published catalog temporarily unavailable" }: {
  description: string;
  retryHref?: string;
  title?: string;
}) {
  return (
    <main className="container page">
      <EmptyState
        icon={<Glyph name="info" size="lg" />}
        title={title}
        description={description}
      >
        <Button variant="outline" asChild>
          <Link href={retryHref}>Try again</Link>
        </Button>
      </EmptyState>
    </main>
  );
}
