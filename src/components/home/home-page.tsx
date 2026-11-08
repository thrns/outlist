import Link from "next/link";
import type { PublicCatalogCategory, PublicCatalogProjectView } from "@/lib/catalog/public";
import { Glyph } from "@/components/project/glyph";
import { ProjectCard, ProjectMini, formatCount } from "@/components/project/project-card";
import { ProjectLogo } from "@/components/project/project-logo";
import { SectionHeading } from "@/components/layout/section-heading";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export function HomePage({ categories, categoryCounts, mostStarred, recentlyPublished, totalProjects }: {
  categories: PublicCatalogCategory[];
  categoryCounts: Record<string, number>;
  mostStarred: PublicCatalogProjectView[];
  recentlyPublished: PublicCatalogProjectView[];
  totalProjects: number;
}) {
  const popularCategories = categories.filter((category) => (categoryCounts[category.slug] ?? 0) > 0).slice(0, 3);
  return (
    <>
      <section className="hero">
        <div className="container hero-inner">
          <div>
            <div className="eyebrow muted">The independent open-source directory <Badge variant="outline" style={{ marginLeft: 8 }}>Discover · Build · Explore</Badge></div>
            <h1>Discover great software.<br /><span>Built in the open.</span></h1>
            <p className="hero-copy">Explore projects reviewed and published in the Outlist catalog, compare their source-backed details, and find tools built in the open.</p>
            <form className="search-large" action="/explore" method="get">
              <Glyph name="search" size="lg" />
              <input name="q" type="search" aria-label="Search open-source projects" placeholder="Search published projects by name or description..." autoComplete="off" />
              <Button type="submit" size="lg">Explore <Glyph name="arrow" /></Button>
            </form>
            <div className="popular-row">
              <span className="muted fine">Browse:</span>
              {popularCategories.map((category) => <Link key={category.id} className="badge border" href={`/category/${category.slug}`}>{category.name}</Link>)}
            </div>
            <div className="hero-note">{totalProjects} published projects across {categories.length} active categories</div>
          </div>
          <div>
            <div className="hero-visual">
              <div className="mini-head">
                <div>
                  <div className="semibold">Recently published</div>
                  <div className="muted fine">Latest additions to the catalog</div>
                </div>
                <Badge variant="dot">Live catalog</Badge>
              </div>
              {recentlyPublished.slice(0, 4).map((project) => <ProjectMini key={project.id} project={project} />)}
              {recentlyPublished.length === 0 && <p className="small muted">No projects have been published yet.</p>}
            </div>
          </div>
        </div>
      </section>
      <main className="container" style={{ paddingBottom: 75 }}>
        <section className="section">
          <SectionHeading title="Explore by category" subtitle="Browse active categories with published projects." href="/categories" label="All categories" />
          <div className="category-grid">
            {categories.slice(0, 6).map((category) => <Link className="category-tile" href={`/category/${category.slug}`} key={category.id}>
              <span className="category-icon"><Glyph name={category.icon} /></span>
              <span><span className="category-name">{category.name}</span><span className="category-count block">{categoryCounts[category.slug] ?? 0} projects <Glyph name="arrow" size="sm" /></span></span>
            </Link>)}
          </div>
        </section>
        <section className="section">
          <SectionHeading title="Most-starred projects" subtitle="Ranked by their current repository star counts." href="/explore?sort=stars" label="Browse directory" />
          {mostStarred.length > 0
            ? <div className="cards-grid">{mostStarred.slice(0, 6).map((project) => <ProjectCard key={project.id} project={project} />)}</div>
            : <p className="muted">No published projects are available yet.</p>}
        </section>
        <section className="section">
          <SectionHeading title="Recently published" subtitle="Projects added to the public catalog most recently." href="/explore?sort=newest" label="View all" />
          {recentlyPublished.length > 0
            ? <div>{recentlyPublished.slice(0, 6).map((project) => <Link className="recent-row" href={`/project/${project.slug}`} key={project.id}>
              <ProjectLogo project={project} size="sm" />
              <span className="grow"><strong>{project.name}</strong><p>{project.primaryCategory.name}</p></span>
              <span className="meta muted fine"><Glyph name="star" size="sm" /> {formatCount(project.repository.stars)}</span>
            </Link>)}</div>
            : <p className="muted">Published projects will appear here when available.</p>}
        </section>
        <section className="section">
          <div className="alt-banner">
            <div>
              <div className="eyebrow muted">Open catalog</div>
              <h3>Explore public, reviewed software.</h3>
              <p className="muted" style={{ maxWidth: 610, margin: 0 }}>Every project shown here comes from Outlist&apos;s published catalog.</p>
            </div>
            <Button asChild size="lg"><Link href="/explore">Explore projects <Glyph name="arrow" /></Link></Button>
          </div>
        </section>
      </main>
    </>
  );
}
