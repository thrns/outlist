import projectsJson from "./projects.json";
import categoriesJson from "./categories.json";

export type CategoryIcon = "code" | "brain" | "grid" | "paint" | "chart" | "server" | "database" | "message";
export interface Category { id: string; name: string; icon: CategoryIcon; description: string }
export interface Project {
  id: string;
  name: string;
  tagline: string;
  description: string;
  category: string;
  language: string;
  license: string;
  stars: number;
  forks: number;
  repo: string;
  updated: string;
  alternative: string;
  website: string;
  featured: boolean;
  created: number;
  visible: boolean;
  userAdded?: boolean;
  tags?: string[];
}
export type SubmissionStatus = "pending" | "approved" | "rejected";
export interface Submission {
  id: string;
  name: string;
  repo: string;
  category: string;
  description: string;
  created: string;
  status: SubmissionStatus;
  language?: string;
  license?: string;
  website?: string;
  tags?: string[];
}
export const seedProjects = projectsJson as Project[];
export const categories = categoriesJson as Category[];
export const initialSubmissions: Submission[] = [
  { id: "P-201", name: "Docmost", repo: "docmost/docmost", category: "productivity", description: "Collaborative wiki and documentation for teams.", created: "Nov 3, 2026", status: "pending" },
  { id: "P-202", name: "Evidently", repo: "evidentlyai/evidently", category: "ai-machine-learning", description: "ML monitoring and data quality evaluations.", created: "Nov 2, 2026", status: "pending" },
  { id: "P-203", name: "OpenStatus", repo: "openstatusHQ/openstatus", category: "infrastructure", description: "Open-source monitoring and status pages.", created: "Nov 1, 2026", status: "pending" },
];
export interface AlternativeGroup {name: string; desc: string; ids: string[]}
export const alternativeGroups: AlternativeGroup[] = [
  {name:"Notion",desc:"Docs and connected workspaces",ids:["appflowy","joplin"]},
  {name:"Figma",desc:"Collaborative interface design",ids:["penpot","excalidraw"]},
  {name:"Postman",desc:"API development and testing",ids:["hoppscotch"]},
  {name:"Firebase",desc:"Backend and app infrastructure",ids:["supabase","pocketbase"]},
  {name:"Google Analytics",desc:"Web and product analytics",ids:["umami","posthog"]},
  {name:"Airtable",desc:"Spreadsheets and databases",ids:["nocodb"]},
  {name:"Slack",desc:"Team messaging and collaboration",ids:["mattermost"]},
  {name:"Heroku",desc:"Application hosting and deployment",ids:["coolify","dokku"]},
  {name:"Jira",desc:"Issue tracking and team planning",ids:["plane","openproject"]},
];
export const languages = ["TypeScript", "JavaScript", "Python", "Rust", "Go", "Clojure", "Dart", "PHP", "Ruby", "Java", "Other"];
export const licenses = ["MIT", "Apache-2.0", "GPL-3.0", "AGPL-3.0", "MPL-2.0", "BSD-3-Clause", "Other / check repository"];
export const categoryById = (id: string) => categories.find(c => c.id === id);
export const formatCount = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, "")}k` : String(n);
export type SortKey = "trending" | "stars" | "newest" | "name";
export function sortProjects(items: Project[], sort: SortKey): Project[] {
  return [...items].sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : sort === "newest" ? b.updated.localeCompare(a.updated) : sort === "stars" ? b.stars - a.stars : (b.stars * .55 + b.forks * .45) - (a.stars * .55 + a.forks * .45));
}
export function searchProjects(items: Project[], query: string): Project[] {
  const q = query.trim().toLowerCase();
  return q ? items.filter(p => [p.name, p.tagline, p.description, p.language, categoryById(p.category)?.name || "", p.alternative, p.repo, ...(p.tags || [])].join(" ").toLowerCase().includes(q)) : items;
}
