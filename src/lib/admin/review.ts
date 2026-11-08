import "server-only";

import { requireAdmin } from "@/lib/auth/admin";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/database.types";

type Tables = Database["public"]["Tables"];
export type ProjectRow = Tables["projects"]["Row"];
export type RepositoryRow = Tables["repositories"]["Row"];
export type AssessmentRow = Tables["repository_assessments"]["Row"];
export type QueueItemRow = Tables["review_queue"]["Row"];
export type EditorialOverrideRow = Tables["editorial_overrides"]["Row"];
export type EditorialDecisionRow = Tables["editorial_decisions"]["Row"];

export type QueueFilter = "pending" | "reviewed" | "published" | "rejected" | "review-required";
export const ADMIN_PAGE_SIZE = 25;

export type AdminQueueRow = {
  project: ProjectRow;
  repository: RepositoryRow | null;
  categoryNames: string[];
  assessment: AssessmentRow | null;
  openReviewItems: number;
  openReviewReasons: string[];
  licenseAssessmentStatus: string;
  priority: string;
  qualityFlags: Json[];
};

export type AdminQueuePage = {
  rows: AdminQueueRow[];
  page: number;
  pageSize: number;
  total: number;
};

export type AdminProjectReview = {
  project: ProjectRow;
  repository: RepositoryRow | null;
  assessment: AssessmentRow | null;
  categories: Array<Tables["categories"]["Row"]>;
  selectedCategoryIds: string[];
  tags: string[];
  topics: Tables["repository_topics"]["Row"][];
  languages: Tables["repository_languages"]["Row"][];
  releases: Tables["releases"]["Row"][];
  snapshots: Tables["repository_snapshots"]["Row"][];
  sourceRecords: Array<Pick<Tables["source_records"]["Row"],
    "id" | "record_kind" | "source_key" | "source_url" | "fetched_at" | "http_status" | "source_metadata">>;
  logos: Array<Pick<Tables["project_logos"]["Row"],
    "id" | "source_url" | "origin" | "verification_status" | "attribution_text" | "is_primary" | "verified_at">>;
  overrides: EditorialOverrideRow[];
  queueItems: QueueItemRow[];
  decisions: EditorialDecisionRow[];
};

export class AdminDataUnavailableError extends Error {
  constructor() {
    super("Administrator review data could not be loaded.");
    this.name = "AdminDataUnavailableError";
  }
}

function isObject(value: unknown): value is { [key: string]: Json | undefined } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function qualityValues(result: Json | null) {
  const root = isObject(result) ? result : {};
  const quality = isObject(root.quality) ? root.quality : {};
  const classification = isObject(root.classification) ? root.classification : {};
  const license = isObject(root.license) ? root.license : {};
  const flags = Array.isArray(quality.flags) ? quality.flags : [];
  const priority = typeof quality.priority === "string" ? quality.priority : "normal";
  const primaryCategoryId = typeof classification.primaryCategoryId === "string" ? classification.primaryCategoryId : null;
  const licenseAssessmentStatus = typeof license.status === "string" ? license.status : "not available";
  return { flags, priority, primaryCategoryId, licenseAssessmentStatus };
}

export async function getAdminQueue(filter: QueueFilter, requestedPage: number): Promise<AdminQueuePage> {
  await requireAdmin();
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const offset = (page - 1) * ADMIN_PAGE_SIZE;
  const supabase = createSupabaseAdminClient();
  let projectQuery = supabase.from("projects").select("*", { count: "exact" });
  switch (filter) {
    case "pending": projectQuery = projectQuery.in("publication_status", ["draft", "pending_review"]); break;
    case "reviewed": projectQuery = projectQuery.or("license_status.eq.verified_open_source,quality_status.eq.verified"); break;
    case "published": projectQuery = projectQuery.eq("publication_status", "published"); break;
    case "rejected": projectQuery = projectQuery.eq("publication_status", "rejected"); break;
    case "review-required": projectQuery = projectQuery.or("license_status.eq.needs_review,quality_status.eq.needs_review"); break;
  }
  const { data: projects, error: projectsError, count } = await projectQuery
    .order("created_at", { ascending: false }).order("id", { ascending: true })
    .range(offset, offset + ADMIN_PAGE_SIZE - 1);
  if (projectsError || !projects) throw new AdminDataUnavailableError();
  if (count !== null && page > 1 && offset >= count) {
    return getAdminQueue(filter, Math.max(1, Math.ceil(count / ADMIN_PAGE_SIZE)));
  }

  const projectIds = projects.map((project) => project.id);
  const repoIds = projects.map((project) => project.primary_repository_id).filter((id): id is string => id !== null);
  const [repositoriesResult, categoryLinksResult, categoriesResult, assessmentsResult, projectQueuesResult, repositoryQueuesResult] = await Promise.all([
    repoIds.length ? supabase.from("repositories").select("*").in("id", repoIds) : Promise.resolve({ data: [], error: null }),
    projectIds.length ? supabase.from("project_categories").select("project_id,category_id").in("project_id", projectIds) : Promise.resolve({ data: [], error: null }),
    supabase.from("categories").select("id,name,is_active"),
    repoIds.length ? supabase.from("repository_assessments").select("*").in("repository_id", repoIds).order("assessed_at", { ascending: false }) : Promise.resolve({ data: [], error: null }),
    projectIds.length ? supabase.from("review_queue").select("id,project_id,repository_id,status,reason").in("project_id", projectIds).in("status", ["open", "in_review"]) : Promise.resolve({ data: [], error: null }),
    repoIds.length ? supabase.from("review_queue").select("id,project_id,repository_id,status,reason").in("repository_id", repoIds).in("status", ["open", "in_review"]) : Promise.resolve({ data: [], error: null }),
  ]);
  if (repositoriesResult.error || categoryLinksResult.error || categoriesResult.error || assessmentsResult.error || projectQueuesResult.error || repositoryQueuesResult.error) {
    throw new AdminDataUnavailableError();
  }
  const repoById = new Map((repositoriesResult.data ?? []).map((repository) => [repository.id, repository]));
  const categoryNameById = new Map((categoriesResult.data ?? []).filter((category) => category.is_active).map((category) => [category.id, category.name]));
  const categoriesByProject = new Map<string, string[]>();
  for (const link of categoryLinksResult.data ?? []) {
    const name = categoryNameById.get(link.category_id);
    if (name) categoriesByProject.set(link.project_id, [...(categoriesByProject.get(link.project_id) ?? []), name]);
  }
  const assessmentByRepository = new Map<string, AssessmentRow>();
  for (const assessment of assessmentsResult.data ?? []) {
    if (!assessmentByRepository.has(assessment.repository_id)) assessmentByRepository.set(assessment.repository_id, assessment);
  }
  const openItemsByProject = new Map<string, Map<string, string>>();
  for (const item of [...(projectQueuesResult.data ?? []), ...(repositoryQueuesResult.data ?? [])]) {
    const key = item.project_id ?? (item.repository_id ? projects.find((project) => project.primary_repository_id === item.repository_id)?.id : null);
    if (key) {
      const items = openItemsByProject.get(key) ?? new Map<string, string>();
      items.set(item.id, item.reason);
      openItemsByProject.set(key, items);
    }
  }
  return {
    rows: projects.map((project) => {
      const repository = project.primary_repository_id ? repoById.get(project.primary_repository_id) ?? null : null;
      const assessment = repository ? assessmentByRepository.get(repository.id) ?? null : null;
      const { flags, priority, primaryCategoryId, licenseAssessmentStatus } = qualityValues(assessment?.result ?? null);
      const categoryNames = categoriesByProject.get(project.id) ?? [];
      const primaryCategoryName = primaryCategoryId ? categoryNameById.get(primaryCategoryId) : undefined;
      if (primaryCategoryName && categoryNames.includes(primaryCategoryName)) {
        categoryNames.sort((left, right) => left === primaryCategoryName ? -1 : right === primaryCategoryName ? 1 : left.localeCompare(right));
      } else {
        categoryNames.sort((left, right) => left.localeCompare(right));
      }
      return {
        project, repository, categoryNames, assessment,
        openReviewItems: openItemsByProject.get(project.id)?.size ?? 0,
        openReviewReasons: [...(openItemsByProject.get(project.id)?.values() ?? [])].slice(0, 2),
        licenseAssessmentStatus,
        priority, qualityFlags: flags,
      };
    }),
    page,
    pageSize: ADMIN_PAGE_SIZE,
    total: count ?? 0,
  };
}

export async function getAdminProjectReview(projectId: string): Promise<AdminProjectReview | null> {
  await requireAdmin();
  const supabase = createSupabaseAdminClient();
  const { data: project, error: projectError } = await supabase.from("projects").select("*").eq("id", projectId).maybeSingle();
  if (projectError) throw new AdminDataUnavailableError();
  if (!project) return null;

  const repoResult = project.primary_repository_id
    ? await supabase.from("repositories").select("*").eq("id", project.primary_repository_id).maybeSingle()
    : { data: null, error: null };
  if (repoResult.error) throw new AdminDataUnavailableError();
  const repository = repoResult.data;

  const [categoriesResult, categoryLinksResult, tagsLinksResult, overridesResult, projectQueuesResult, repositoryQueuesResult, decisionsResult, logosResult,
    assessmentResult, topicsResult, languagesResult, releasesResult, snapshotsResult, sourceRecordsResult] = await Promise.all([
    supabase.from("categories").select("*").eq("is_active", true).order("sort_order").order("name"),
    supabase.from("project_categories").select("category_id").eq("project_id", projectId),
    supabase.from("project_tags").select("tag_id").eq("project_id", projectId).limit(20),
    supabase.from("editorial_overrides").select("*").eq("project_id", projectId).order("field_key"),
    supabase.from("review_queue").select("*").eq("project_id", projectId).order("created_at", { ascending: false }).limit(50),
    repository ? supabase.from("review_queue").select("*").eq("repository_id", repository.id).order("created_at", { ascending: false }).limit(50) : Promise.resolve({ data: [], error: null }),
    supabase.from("editorial_decisions").select("*").eq("project_id", projectId).order("created_at", { ascending: false }).limit(50),
    supabase.from("project_logos").select("id,source_url,origin,verification_status,attribution_text,is_primary,verified_at").eq("project_id", projectId).order("created_at", { ascending: false }).limit(20),
    repository ? supabase.from("repository_assessments").select("*").eq("repository_id", repository.id).order("assessed_at", { ascending: false }).limit(1).maybeSingle() : Promise.resolve({ data: null, error: null }),
    repository ? supabase.from("repository_topics").select("*").eq("repository_id", repository.id).order("source_topic").limit(50) : Promise.resolve({ data: [], error: null }),
    repository ? supabase.from("repository_languages").select("*").eq("repository_id", repository.id).order("bytes", { ascending: false }).limit(50) : Promise.resolve({ data: [], error: null }),
    repository ? supabase.from("releases").select("*").eq("repository_id", repository.id).order("published_at", { ascending: false, nullsFirst: false }).limit(10) : Promise.resolve({ data: [], error: null }),
    repository ? supabase.from("repository_snapshots").select("*").eq("repository_id", repository.id).order("captured_at", { ascending: false }).limit(30) : Promise.resolve({ data: [], error: null }),
    repository ? supabase.from("source_records").select("id,record_kind,source_key,source_url,fetched_at,http_status,source_metadata").eq("repository_id", repository.id).order("fetched_at", { ascending: false }).limit(50) : Promise.resolve({ data: [], error: null }),
  ]);
  const results = [categoriesResult, categoryLinksResult, tagsLinksResult, overridesResult, projectQueuesResult, repositoryQueuesResult, decisionsResult, logosResult,
    assessmentResult, topicsResult, languagesResult, releasesResult, snapshotsResult, sourceRecordsResult];
  if (results.some((result) => result.error)) throw new AdminDataUnavailableError();

  const tagIds = (tagsLinksResult.data ?? []).map(({ tag_id }) => tag_id);
  const tagsResult = tagIds.length ? await supabase.from("tags").select("id,name").in("id", tagIds) : { data: [], error: null };
  if (tagsResult.error) throw new AdminDataUnavailableError();
  const queueById = new Map<string, QueueItemRow>();
  for (const item of [...(projectQueuesResult.data ?? []), ...(repositoryQueuesResult.data ?? [])]) queueById.set(item.id, item);

  return {
    project,
    repository,
    assessment: assessmentResult.data,
    categories: categoriesResult.data ?? [],
    selectedCategoryIds: (categoryLinksResult.data ?? []).map(({ category_id }) => category_id),
    tags: (tagsResult.data ?? []).map(({ name }) => name),
    topics: topicsResult.data ?? [],
    languages: languagesResult.data ?? [],
    releases: releasesResult.data ?? [],
    snapshots: snapshotsResult.data ?? [],
    sourceRecords: sourceRecordsResult.data ?? [],
    logos: logosResult.data ?? [],
    overrides: overridesResult.data ?? [],
    queueItems: [...queueById.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    decisions: decisionsResult.data ?? [],
  };
}
