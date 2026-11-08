import Link from "next/link";
import type { PublicCatalogProjectView } from "@/lib/catalog/public";
import { ProjectCard, ProjectCategoryBadges, formatCount } from "./project-card";
import { ProjectLogo } from "./project-logo";
import { Glyph } from "./glyph";
import { Breadcrumb } from "@/components/layout/breadcrumb";
import { SectionHeading } from "@/components/layout/section-heading";
import { Button } from "@/components/ui/button";

function formatActivity(value: string | null): string {
  if (!value) return "Not available";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value)) + " UTC";
}

export function ProjectDetails({ project: p, description, related }: {
  project: PublicCatalogProjectView;
  description: string;
  related: PublicCatalogProjectView[];
}) {
  const info = [
    { label: "Stars", value: formatCount(p.repository.stars) },
    { label: "Forks", value: formatCount(p.repository.forks) },
    { label: "Primary language", value: p.repository.primaryLanguage ?? "Not available" },
    { label: "Verified license", value: p.license.identifier },
    { label: "Latest repository activity", value: formatActivity(p.repository.activityAt) },
  ];

  return (
    <main className="container page">
      <Breadcrumb items={[
        { label: "Home", href: "/" },
        { label: "Projects", href: "/explore" },
        { label: p.primaryCategory.name, href: `/category/${p.primaryCategory.slug}` },
        { label: p.name },
      ]} />
      <div className="detail-top">
        <ProjectLogo project={p} size="lg" />
        <div className="grow">
          <h1>{p.name}</h1>
          <p>{p.summary}</p>
          <ProjectCategoryBadges project={p} />
          {p.tags.length > 0 && <div className="tags" aria-label="Project tags">
            {p.tags.map((tag) => <span key={tag} className="badge border">{tag}</span>)}
          </div>}
        </div>
        <div className="detail-actions">
          <Button asChild variant="outline">
            <a href={p.repository.url} target="_blank" rel="noopener noreferrer">
              <Glyph name="git" /> Source repository <Glyph name="external" size="sm" />
            </a>
          </Button>
          {p.officialWebsiteUrl && <Button asChild>
            <a href={p.officialWebsiteUrl} target="_blank" rel="noopener noreferrer">
              Official website <Glyph name="external" size="sm" />
            </a>
          </Button>}
        </div>
      </div>

      <div className="details-layout">
        <div>
          <section className="details-section">
            <h2>Project description</h2>
            <p className="body-copy">{description || p.summary}</p>
          </section>
          <section className="details-section">
            <h2>Repository</h2>
            <p className="body-copy">
              <a className="text-link" href={p.repository.url} target="_blank" rel="noopener noreferrer">
                {p.repository.fullName} <Glyph name="external" size="sm" />
              </a>
            </p>
          </section>
        </div>
        <aside>
          <div className="info-panel">
            <h3>Repository overview</h3>
            {info.map((item) => <div className="info-row" key={item.label}>
              <span className="muted">{item.label}</span>
              <strong>{item.value}</strong>
            </div>)}
            <div className="info-row">
              <span className="muted">Project website</span>
              {p.officialWebsiteUrl
                ? <a href={p.officialWebsiteUrl} target="_blank" rel="noopener noreferrer" className="text-link">Visit site <Glyph name="external" size="sm" /></a>
                : <strong>Not available</strong>}
            </div>
            <div className="info-row">
              <span className="muted">Published</span>
              <time dateTime={p.publishedAt}>{formatActivity(p.publishedAt)}</time>
            </div>
          </div>
          <div className="info-panel">
            <h3>Discover more</h3>
            <div className="tags">
              {p.categories.map((category) => <Link key={category.id} className="badge border" href={`/category/${category.slug}`}>{category.name}</Link>)}
              {p.repository.primaryLanguage && <Link className="badge border" href={`/explore?language=${encodeURIComponent(p.repository.primaryLanguage)}`}>{p.repository.primaryLanguage}</Link>}
            </div>
          </div>
        </aside>
      </div>

      {related.length > 0 && <section className="section">
        <SectionHeading title="Related projects" subtitle="More published projects in this category." href={`/category/${p.primaryCategory.slug}`} label="View category" />
        <div className="cards-grid">{related.map((item) => <ProjectCard key={item.id} project={item} />)}</div>
      </section>}
    </main>
  );
}
