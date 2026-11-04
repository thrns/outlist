import type { Project } from "@/data/catalog";
export function ProjectLogo({project,size="default"}: {project:Pick<Project,"name">;size?:"default"|"sm"|"lg"}) {
  const initials = (project.name || "?").split(/\s+/).slice(0,2).map(s=>s[0]).join("").slice(0,2).toUpperCase();
  return <span className={`project-logo${size === "default" ? "" : " " + size}`} aria-hidden="true">{initials}</span>;
}
