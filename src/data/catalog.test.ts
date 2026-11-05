import { describe, expect, it } from "vitest";
import {
  categories,
  searchProjects,
  seedProjects,
  sortProjects,
} from "./catalog";

const originalProjectIds = [
  "supabase", "cal-com", "appflowy", "penpot", "hoppscotch", "windmill",
  "immich", "ollama", "posthog", "umami", "excalidraw", "appsmith",
  "nocodb", "plane", "meilisearch", "grafana", "coolify", "qdrant",
  "pocketbase", "langfuse", "zed", "docusaurus", "ghost", "mattermost",
  "joplin", "payload", "strapi", "openproject", "openobserve", "dokku",
  "firecrawl", "open-webui", "chatwoot",
];

describe("seed catalog", () => {
  it("preserves the 33 original project records and eight categories", () => {
    expect(seedProjects).toHaveLength(33);
    expect(seedProjects.map((project) => project.id)).toEqual(originalProjectIds);
    expect(categories).toHaveLength(8);
    expect(seedProjects.every((project) =>
      categories.some((category) => category.id === project.category),
    )).toBe(true);
  });
});

describe("project search and sorting", () => {
  it("matches trimmed case-insensitive searches across names, repositories, and tags", () => {
    expect(searchProjects(seedProjects, "  SUPABASE  ").map((p) => p.id)).toContain("supabase");
    expect(searchProjects(seedProjects, "firecrawl/firecrawl").map((p) => p.id)).toContain("firecrawl");
    expect(searchProjects(seedProjects, "diagram").map((p) => p.id)).toContain("excalidraw");
  });

  it("returns the original collection when the query is empty", () => {
    expect(searchProjects(seedProjects, "   ")).toBe(seedProjects);
  });

  it("sorts names ascending and stars descending without mutating its input", () => {
    const projects = [seedProjects[3], seedProjects[0], seedProjects[1]];
    const snapshot = [...projects];

    expect(sortProjects(projects, "name").map((p) => p.name)).toEqual(
      [...projects].map((p) => p.name).sort((a, b) => a.localeCompare(b)),
    );
    expect(sortProjects(projects, "stars").map((p) => p.stars)).toEqual(
      [...projects].map((p) => p.stars).sort((a, b) => b - a),
    );
    expect(projects).toEqual(snapshot);
  });

  it("sorts recent updates in descending date order", () => {
    const dates = sortProjects(seedProjects, "newest").map((p) => p.updated);
    expect(dates).toEqual([...dates].sort((a, b) => b.localeCompare(a)));
  });
});
