import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Glyph } from "./glyph";
import { ProjectLogo } from "./project-logo";
import type { PublicCatalogProjectView } from "@/lib/catalog/public";

export function formatCount(count: number): string {
  return count >= 1_000
    ? `${(count / 1_000).toFixed(count >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k`
    : String(count);
}

export function ProjectCard({ project: p }: { project: PublicCatalogProjectView }) {
  return (
    <Link href={`/project/${p.slug}`} className="project-card">
      <div className="project-card-top">
        <ProjectLogo project={p} />
        <div className="project-main">
          <h3 className="project-name">{p.name}</h3>
          <div className="fine muted">{p.primaryCategory.name}</div>
        </div>
      </div>
      <p className="description">{p.summary}</p>
      <div className="project-card-footer">
        <span className="meta"><Glyph name="star" size="sm" /> {formatCount(p.repository.stars)}</span>
        <span className="meta"><Glyph name="git" size="sm" /> {formatCount(p.repository.forks)}</span>
        <span className="meta">{p.repository.primaryLanguage ?? "Language unavailable"}</span>
        <span className="spacer" />
        <Glyph name="arrow" size="sm" />
      </div>
    </Link>
  );
}

export function ProjectMini({ project: p }: { project: PublicCatalogProjectView }) {
  return (
    <Link href={`/project/${p.slug}`} className="mini-project">
      <ProjectLogo project={p} size="sm" />
      <span className="grow">
        <strong>{p.name}</strong>
        <p>{p.summary}</p>
      </span>
      <span className="meta fine muted"><Glyph name="star" size="sm" /> {formatCount(p.repository.stars)}</span>
    </Link>
  );
}

export function ProjectCategoryBadges({ project }: { project: PublicCatalogProjectView }) {
  return <div className="tags">{project.categories.map((category) =>
    <Badge key={category.id} variant="outline">{category.name}</Badge>,
  )}</div>;
}
