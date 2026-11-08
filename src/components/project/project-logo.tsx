"use client";

import { useState } from "react";
import type { PublicCatalogProjectView } from "@/lib/catalog/public";

type LogoProject = Pick<PublicCatalogProjectView, "name" | "fallback" | "logo">;

export function ProjectLogo({ project, size = "default" }: {
  project: LogoProject;
  size?: "default" | "sm" | "lg";
}) {
  const [failed, setFailed] = useState(false);
  const logo = project.logo && !failed ? project.logo : null;
  const className = ["project-logo", size !== "default" && size, logo?.kind === "provider_avatar" && "avatar"]
    .filter(Boolean)
    .join(" ");
  const label = logo?.kind === "provider_avatar"
    ? `GitHub owner avatar for ${project.name}`
    : logo
      ? `Official project logo for ${project.name}`
      : `${project.name} logo fallback`;

  return (
    <span className={className} role="img" aria-label={label} data-logo-kind={logo?.kind ?? "fallback"}>
      {logo
        ? <img src={logo.publicUrl} alt="" onError={() => setFailed(true)} />
        : <span aria-hidden="true">{project.fallback.initial || project.name.slice(0, 1).toUpperCase()}</span>}
    </span>
  );
}
