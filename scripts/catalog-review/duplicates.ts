import type { CatalogReviewQueueItem } from "./queue";
import { catalogSnapshotDataHash, verifyCatalogSnapshot, type OutlistCatalogSnapshot } from "./catalog";

export type CatalogDuplicateCheck = {
  snapshot_complete: boolean;
  snapshot_fresh: boolean;
  snapshot_sha256: string | null;
  snapshot_data_sha256: string | null;
  snapshot_project_ref: string | null;
  snapshot_captured_at: string | null;
  candidate_id: string;
  candidate_repository_id: string;
  candidate_full_name: string;
  current_repository_record_id: string | null;
  repository_rows_checked: number;
  candidate_rows_checked: number;
  project_rows_checked: number;
  candidate_identity_verified: boolean;
  current_candidate_matches: number;
  duplicate_imported_candidates: Record<string, unknown>[];
  candidate_canonical_identity_conflicts: Record<string, unknown>[];
  exact_repository_matches: Record<string, unknown>[];
  canonical_identity_conflicts: Record<string, unknown>[];
  project_associations: Record<string, unknown>[];
  fork_or_mirror_upstream_matches: Record<string, unknown>[];
  duplicate_public_product_listings: Record<string, unknown>[];
  has_material_duplicate_conflict: boolean;
  public_listing_count: number;
};

export function buildCatalogDuplicateCheck(
  item: CatalogReviewQueueItem,
  snapshot: OutlistCatalogSnapshot | null,
  repositoryMetadata: Record<string, unknown> | null,
  now = new Date(),
): CatalogDuplicateCheck {
  const verified = snapshot !== null && verifyCatalogSnapshot(snapshot);
  const fresh = verified && now.getTime() >= Date.parse(snapshot.captured_at)
    && now.getTime() - Date.parse(snapshot.captured_at) <= 24 * 60 * 60 * 1000;
  if (!snapshot || !verified || !fresh) {
    return {
      snapshot_complete: false,
      snapshot_fresh: false,
      snapshot_sha256: snapshot?.sha256 ?? null,
      snapshot_data_sha256: verified && snapshot ? catalogSnapshotDataHash(snapshot) : null,
      snapshot_project_ref: snapshot?.project_ref ?? null,
      snapshot_captured_at: snapshot?.captured_at ?? null,
      candidate_id: item.candidate_id,
      candidate_repository_id: item.repository_id,
      candidate_full_name: item.full_name,
      current_repository_record_id: null,
      repository_rows_checked: 0,
      candidate_rows_checked: 0,
      project_rows_checked: 0,
      candidate_identity_verified: false,
      current_candidate_matches: 0,
      duplicate_imported_candidates: [],
      candidate_canonical_identity_conflicts: [],
      exact_repository_matches: [],
      canonical_identity_conflicts: [],
      project_associations: [],
      fork_or_mirror_upstream_matches: [],
      duplicate_public_product_listings: [],
      has_material_duplicate_conflict: true,
      public_listing_count: 0,
    };
  }

  const githubRepositories = snapshot.repositories.filter((row) => row.provider.toLowerCase() === "github");
  const githubCandidates = snapshot.candidates.filter((row) => row.provider.toLowerCase() === "github");
  const projectsById = new Map(snapshot.projects.map((row) => [row.id, row]));
  const currentCandidates = githubCandidates.filter((row) => row.id === item.candidate_id
    && row.provider_repository_id === item.repository_id
    && sameName(row.full_name, item.full_name));
  const currentCandidate = currentCandidates.length === 1 ? currentCandidates[0] : null;
  const currentRepositoryId = currentCandidate?.repository_id ?? null;

  const duplicateImportedCandidates = githubCandidates
    .filter((row) => row.id !== item.candidate_id && row.provider_repository_id === item.repository_id)
    .map((row) => ({ candidate_id: row.id, repository_id: row.provider_repository_id, full_name: row.full_name, queue_status: row.queue_status }));
  const candidateCanonicalIdentityConflicts = githubCandidates
    .filter((row) => row.id !== item.candidate_id && row.provider_repository_id !== item.repository_id
      && (sameName(row.full_name, item.full_name) || githubIdentity(row.canonical_url) === githubIdentity(item.full_name)))
    .map((row) => ({ candidate_id: row.id, repository_id: row.provider_repository_id, full_name: row.full_name, canonical_url: row.canonical_url, repository_record_id: row.repository_id, queue_status: row.queue_status }));

  const exactRows = githubRepositories.filter((row) => row.provider_repository_id === item.repository_id);
  const ownRepositoryRows = exactRows.filter((row) => currentRepositoryId !== null && row.id === currentRepositoryId);
  const otherExactRows = exactRows.filter((row) => !ownRepositoryRows.includes(row));
  const canonicalIdentityConflictRows = snapshot.repositories
    .filter((row) => (row.provider.toLowerCase() !== "github" || row.provider_repository_id !== item.repository_id)
      && ((row.provider.toLowerCase() === "github" && sameName(row.full_name, item.full_name))
        || canonicalIdentity(row.canonical_url) === canonicalIdentity(`https://github.com/${item.full_name}`)));
  const canonicalIdentityConflicts = canonicalIdentityConflictRows.map((row) => projectMatch(row, projectsById));

  const projectAssociations = item.project_id
    ? githubRepositories.filter((row) => row.project_id === item.project_id).map((row) => projectMatch(row, projectsById))
    : [];

  const upstream = upstreamIdentities(repositoryMetadata);
  const forkOrMirrorUpstreamRows = snapshot.repositories
    .filter((row) => (row.provider.toLowerCase() === "github" && (upstream.githubIds.has(row.provider_repository_id)
        || upstream.githubNames.has(row.full_name.toLowerCase())))
      || upstream.urls.has(canonicalIdentity(row.canonical_url)));
  const forkOrMirrorUpstreamMatches = forkOrMirrorUpstreamRows.map((row) => projectMatch(row, projectsById));

  const candidatesForDuplicateListing = [...otherExactRows, ...canonicalIdentityConflictRows, ...forkOrMirrorUpstreamRows];
  const duplicateListingRows: Record<string, unknown>[] = candidatesForDuplicateListing.flatMap((row) => {
    const project = row.project_id ? projectsById.get(row.project_id) : null;
    if (!project || project.publication_status !== "published" || project.id === item.project_id) return [];
    return [{
      ...projectMatch(row, projectsById), project_id: project.id, project_slug: project.slug,
      project_name: project.name, publication_status: project.publication_status,
    }];
  });
  const duplicatePublicProductListings = uniqueBy(duplicateListingRows, (row) => `${row["repository_record_id"]}:${row["project_id"]}`);

  const hasMaterialDuplicateConflict = duplicateImportedCandidates.length > 0
    || candidateCanonicalIdentityConflicts.length > 0
    || otherExactRows.length > 0
    || canonicalIdentityConflicts.length > 0
    || duplicatePublicProductListings.length > 0;

  return {
    snapshot_complete: true,
    snapshot_fresh: true,
    snapshot_sha256: snapshot.sha256,
    snapshot_data_sha256: catalogSnapshotDataHash(snapshot),
    snapshot_project_ref: snapshot.project_ref,
    snapshot_captured_at: snapshot.captured_at,
    candidate_id: item.candidate_id,
    candidate_repository_id: item.repository_id,
    candidate_full_name: item.full_name,
    current_repository_record_id: currentRepositoryId,
    repository_rows_checked: githubRepositories.length,
    candidate_rows_checked: githubCandidates.length,
    project_rows_checked: snapshot.projects.length,
    candidate_identity_verified: currentCandidate !== null && currentCandidates.length === 1,
    current_candidate_matches: currentCandidates.length,
    duplicate_imported_candidates: duplicateImportedCandidates,
    candidate_canonical_identity_conflicts: candidateCanonicalIdentityConflicts,
    exact_repository_matches: [...ownRepositoryRows, ...otherExactRows].map((row) => ({
      ...projectMatch(row, projectsById),
      current_candidate_repository: currentRepositoryId !== null && row.id === currentRepositoryId,
    })),
    canonical_identity_conflicts: canonicalIdentityConflicts,
    project_associations: projectAssociations,
    fork_or_mirror_upstream_matches: forkOrMirrorUpstreamMatches,
    duplicate_public_product_listings: duplicatePublicProductListings,
    has_material_duplicate_conflict: hasMaterialDuplicateConflict,
    public_listing_count: snapshot.projects.filter((project) => project.publication_status === "published").length,
  };
}

function projectMatch(
  repository: OutlistCatalogSnapshot["repositories"][number],
  projects: Map<string, OutlistCatalogSnapshot["projects"][number]>,
): Record<string, unknown> {
  const project = repository.project_id ? projects.get(repository.project_id) : null;
  return {
    repository_record_id: repository.id,
    repository_id: repository.provider_repository_id,
    full_name: repository.full_name,
    canonical_url: repository.canonical_url,
    project_id: repository.project_id,
    project_slug: project?.slug ?? null,
    project_name: project?.name ?? null,
    publication_status: project?.publication_status ?? null,
    is_fork: repository.is_fork,
    is_archived: repository.is_archived,
    availability_status: repository.availability_status,
  };
}

function upstreamIdentities(metadata: Record<string, unknown> | null): { githubIds: Set<string>; githubNames: Set<string>; urls: Set<string> } {
  const githubIds = new Set<string>();
  const githubNames = new Set<string>();
  const urls = new Set<string>();
  if (!metadata) return { githubIds, githubNames, urls };
  const parent = isRecord(metadata.parent) ? metadata.parent : null;
  const source = isRecord(metadata.source) ? metadata.source : null;
  for (const identity of [parent, source]) {
    if (!identity) continue;
    if (typeof identity.id === "number" || typeof identity.id === "string") githubIds.add(String(identity.id));
    if (typeof identity.full_name === "string") githubNames.add(identity.full_name.toLowerCase());
    if (typeof identity.html_url === "string") urls.add(canonicalIdentity(identity.html_url));
  }
  if (typeof metadata.mirror_url === "string" && metadata.mirror_url) {
    urls.add(canonicalIdentity(metadata.mirror_url));
  }
  return { githubIds, githubNames, urls };
}

function canonicalIdentity(value: string): string {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const path = url.pathname.replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
    return `${host}${path}`;
  } catch { return value.trim().replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase(); }
}
function githubIdentity(value: string): string {
  const normalized = canonicalIdentity(value.includes("://") ? value : `https://github.com/${value}`);
  return normalized.startsWith("github.com/") ? normalized.slice("github.com/".length) : normalized;
}
function sameName(left: string, right: string): boolean { return left.trim().toLowerCase() === right.trim().toLowerCase(); }
function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => { const identity = key(value); if (seen.has(identity)) return false; seen.add(identity); return true; });
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
