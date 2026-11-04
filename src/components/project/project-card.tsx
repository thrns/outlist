import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Glyph } from "./glyph";
import { ProjectLogo } from "./project-logo";
import { categoryById, formatCount, type Project } from "@/data/catalog";
export function ProjectCard({project:p}:{project:Project}) {
  return <Link href={`/project/${p.id}`} className="project-card"><div className="project-card-top"><ProjectLogo project={p}/><div className="project-main"><h3 className="project-name">{p.name}</h3><div className="fine muted">{categoryById(p.category)?.name}</div></div>{p.featured && <Badge>Featured</Badge>}</div><p className="description">{p.tagline} {p.description}</p><div className="project-card-footer"><span className="meta"><Glyph name="star" size="sm"/> {formatCount(p.stars)}</span><span className="meta"><Glyph name="git" size="sm"/> {formatCount(p.forks)}</span><span className="meta">{p.language}</span><span className="spacer"/><Glyph name="arrow" size="sm"/></div></Link>;
}
export function ProjectMini({project:p}:{project:Project}) {
  return <Link href={`/project/${p.id}`} className="mini-project"><ProjectLogo project={p} size="sm"/><span className="grow"><strong>{p.name}</strong><p>{p.tagline}</p></span><span className="meta fine muted"><Glyph name="star" size="sm"/> {formatCount(p.stars)}</span></Link>;
}
