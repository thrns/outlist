import Link from "next/link";
import type { PublicCatalogCategory } from "@/lib/catalog/public";
import { Glyph } from "@/components/project/glyph";

export function CategoriesPage({ categories, categoryCounts }: {
  categories: PublicCatalogCategory[];
  categoryCounts: Record<string, number>;
}) {
  return (
    <main className="container page">
      <div className="eyebrow muted">Browse the ecosystem</div>
      <h1 className="page-title">Explore categories</h1>
      <p className="muted" style={{ margin: "0 0 26px", maxWidth: 680 }}>
        Browse active categories and see how many published projects are currently available in each.
      </p>
      {categories.length > 0
        ? <div className="category-grid category-index-grid" style={{ gridTemplateColumns: "repeat(2,minmax(0,1fr))" }}>
          {categories.map((category) => <Link key={category.id} className="category-tile" style={{ minHeight: 135, alignItems: "flex-start" }} href={`/category/${category.slug}`}>
            <span className="category-icon"><Glyph name={category.icon} /></span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="category-name" style={{ fontSize: 15 }}>{category.name}</div>
              <p className="muted small" style={{ margin: "7px 0" }}>{category.description}</p>
              <div className="category-count">{categoryCounts[category.slug] ?? 0} published projects <Glyph name="arrow" size="sm" /></div>
            </div>
          </Link>)}
        </div>
        : <div className="empty-state"><Glyph name="grid" size="lg" /><strong>No active categories</strong><p>Active categories will appear here when available.</p></div>}
    </main>
  );
}
