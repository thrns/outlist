# Roadmap

This roadmap records completed milestones, current limitations, and planned
platform capabilities.

## M0-01 — Bun and Supabase foundation

- Standardize Bun, preserve the existing demo and 33-project catalog, and add
  automated checks.
- Add environment-safe browser, SSR, and privileged Supabase client factories.
- Add local Supabase CLI configuration and the SQL migrations workflow.
- Document architecture and future data handling.

## M0-02 — Database schema

- Define the normalized catalog, repository metadata, provenance, operations,
  moderation, and administration tables in versioned SQL migrations.
- Seed 11 database-driven categories while leaving the 33 illustrative JSON
  projects outside production data.
- Add integrity constraints, publication guards, search and workload indexes,
  RLS policies, least-privilege grants, and the restricted project-logo bucket.
- Generate TypeScript database types from the migrated schema and check for
  drift in database CI.
- Keep the demo's routes and JSON behavior unchanged. The schema is ready for
  later ingestion and server integration, but neither is implemented here.

### Remaining limitations after M0-02

- Local database execution depends on a working Docker-compatible runtime;
  GitHub Actions provides the independent migration, pgTAP, lint, and type
  generation environment.
- Repository ingestion, validated submission endpoints, project publication
  tools, public database queries, search RPC, and UI integration remain later
  work.

## M0-03 — Secure administrator authentication

- Add invite-only Supabase email OTP login with account creation disabled.
- Refresh SSR sessions with a scoped Next.js 16 Proxy using verified claims.
- Protect admin pages with a fresh server-side Auth UUID and allowlist check on
  every request; keep `admin_users` private under RLS and grants.
- Add POST logout, local OTP template configuration, provisioning guidance,
  and tests for validation, authorization, revocation, and allowlist privacy.
- Verify real local OTP delivery and verification through Mailpit, production
  Next.js session cookies, authorization, revocation, logout, and public-route
  compatibility in an isolated Chromium CI job.
- Keep moderation, publishing, and ingestion controls as clearly labeled
  browser-local demonstrations.

### Historical limitations after M0-03 (superseded by M1-07)

- Hosted Supabase project settings and administrator provisioning remain
  outside this verification. The CI suite covers local Supabase Auth,
  PostgreSQL, Mailpit, and the production Next.js browser flow only; it does
  not prove hosted SMTP delivery or hosted Auth behavior.
- At this milestone, moderation controls still updated browser `localStorage`.
  M1-07 replaces the `/admin` moderation demo with a database-backed editorial
  queue and controlled publication workflow.

## M1-01 — GitHub REST API adapter

- Add a typed, Zod-validated, read-only Bun client for repository metadata by
  path or numeric provider ID, languages, topics, detected license metadata,
  releases, and rate-limit diagnostics.
- Support optional server-side `GITHUB_TOKEN`, explicit GitHub API versioning,
  ETags, bounded Link pagination, timeout, cancellation, retries, and structured
  rate-limit and API errors.
- Return parsed source data with provenance and preserve absent, null,
  unavailable, and unsupported source-field states.
- Add a local one-repository inspection CLI and mocked Vitest coverage.
- Do not write to Supabase, discover repositories, verify licenses, classify
  projects, or publish catalog entries.

### Remaining limitations after M1-01

- The M1-01 adapter read one explicitly named repository. M1-02 added bounded
  candidate discovery and restartable Supabase queues. M1-03 adds normalization
  and enrichment; scheduling, quality checks, license verification, and
  publication remain later work.
- The optional CLI smoke test verifies only the requested repository and
  endpoints; it does not validate the future scheduled ingestion pipeline.

## M1-02 — GitHub discovery and candidate queues (implemented)

- Added a typed, endpoint-specific GitHub repository search method with
  validated responses, stable repository IDs, page totals, incomplete-result
  flags, provenance, and search-specific rate-limit metadata.
- Added the small, versioned `initial` plan with topic and language partitions
  bounded by star and creation-date ranges. Saturated partitions split across
  adjacent date ranges when possible; unsafe work remains for review.
- Persisted candidates, page provenance, counters, and cursors transactionally
  in Supabase. Candidates deduplicate on `(provider, provider_repository_id)`;
  rediscovery retains rejected or discarded review states.
- Added atomic partition claims with leases and fencing tokens, bounded retries,
  and recovery after worker interruption.
- Made exact plan registration preserve leases and checkpoints. An incompatible
  query definition in the same plan version fails atomically; an intentional
  change requires a new plan version or explicit reset migration. Candidate
  execution budgets no longer change the persisted search page size.
- Added an explicit bounded Bun CLI with safe Supabase configuration and
  connection errors, plus unit/pgTAP coverage and real disposable Supabase
  integration of the CLI orchestration using deterministic GitHub HTTP fixtures.
- Kept candidates separate from canonical projects and repositories. This
  milestone does not normalize, verify licenses, classify, fetch logos, or
  publish listings.

### Remaining limitations after M1-02

- The ten-partition initial plan is a bounded topic and language sample.
  GitHub Search has
  indexing/scope limits, a 1,000-result window, and possible incomplete
  results; the plan does not claim exhaustive GitHub coverage.
- The worker is manually invoked and serial. It is not scheduled and does not
  enrich or publish candidates. Deterministic GitHub HTTP fixtures do not
  constitute a live GitHub crawl or hosted Supabase verification.
- Local PostgreSQL integration depends on a running Docker-compatible runtime;
  GitHub Actions exercises the queue and actual worker orchestration against
  disposable local Supabase.

## M1-03 — Repository enrichment and normalization (implemented)

- Added a separate candidate enrichment queue with durable attempts, retry
  schedules, expiring leases, fencing tokens, recovery, and rejected/discarded
  candidate protection.
- Fetches current GitHub metadata by stable numeric repository ID and
  normalizes it into canonical repository rows, complete languages and topics,
  bounded releases, daily popularity snapshots, and compact source provenance.
- Uses a restricted transactional PostgreSQL commit RPC for source data,
  related records, candidate/job state, and counters. Existing project
  associations and editorial fields are preserved; no project is created.
- Records source ETags without conditional reuse until a validated reusable
  cache is implemented. Missing subresources have explicit partial and retry
  state; 404 responses do not establish deletion.
- Added a dry-run-by-default bounded CLI, unit tests, pgTAP queue tests, and a
  real local Supabase integration runner with deterministic GitHub HTTP
  fixtures. CI runs the enrichment worker integration and regenerated type
  drift comparison.
- GitHub's detected license remains source evidence. License verification,
  quality checks, classification, and editorial publication are later work.

### Remaining limitations after M1-03

- The worker is manually invoked and serial. It does not schedule recurring
  imports, use conditional requests, or fetch full release history.
- GitHub API responses can be unavailable or ambiguous. A 404 is not treated
  as proof of deletion, and no live GitHub or hosted Supabase run is part of
  normal CI.
- Local database integration depends on a running Docker-compatible runtime;
  GitHub Actions exercises migrations, pgTAP, database lint, type drift, and
  the actual worker orchestration against disposable local Supabase.

## M1-04 — Project classification, license assessment, and review queue (implemented)

- Added deterministic, versioned category mappings against the seeded eleven
  category taxonomy, with rule-level source evidence, bounded confidence, and
  no language-only classification or generated descriptions.
- Pinned SPDX License List metadata at version 3.29.0 and retained OSI
  approval only as a classification attribute, never as legal verification.
- Added source-based repository review flags, conservative license outcomes,
  and a private, policy-versioned assessment queue with independent leases,
  fencing, bounded retries, and source-observation revisions.
- Added a narrow transaction that rechecks public eligibility, persists
  evidence, creates a `pending_review` draft only when category evidence is
  sufficient, links its repository as primary, associates supported
  categories, and creates/reuses an editorial review item.
- Preserved existing project/editorial data, stable repository-ID slugs,
  service-only assessment mutation, and the existing publication guard.
- Added dry-run-by-default `bun run assess`, unit tests, pgTAP safeguards, and
  an actual PostgREST/PostgreSQL worker integration seeded with deterministic
  GitHub HTTP fixtures. CI runs assessment integration and generated-type
  parity checks without hosted Supabase or a live GitHub token.
- Kept all project drafts unpublished and all source-only license and quality
  assessments unverified.

### Remaining limitations after M1-04

- Partial enrichments wait for a complete successful enrichment before
  assessment. Custom and compound license expressions require editorial review.
- Category mappings are deliberately small, deterministic rules. They can
  return no category or conflicting evidence and never generate descriptions.
- The assessment CLI is manual and serial. Recurring scheduling and
  database-backed frontend integration remain later milestones. Public search
  is delivered in M1-08; connecting the interface remains M1-09.

## M1-05 — Project logo acquisition, verification, and fallbacks (implemented)

- Added approved-only logo resolution: official project logo, approved GitHub
  owner avatar labeled as an avatar, then a deterministic Unicode-safe
  single-character fallback.
- Extended the GitHub repository adapter with its owner avatar URL and added
  stable-ID candidate discovery for eligible public repositories.
- Added immutable source and repository provenance, per-project deduplication,
  and one open review item per candidate. Discovery defaults to dry-run and
  never uploads image bytes.
- Added a trusted operator CLI for official-source registration, explicit
  avatar or local-file approval, rejection, revocation, and orphan
  reconciliation. Service-role RPCs fence approvals, enforce eligibility,
  preserve official-logo priority, and leave publication, license, and quality
  decisions untouched.
- Added Sharp-based bounded image decoding and WebP normalization, a migration
  for logo provenance and approval state, pgTAP permission checks, and a real
  local Supabase database/Storage integration suite in CI.
- Documented the public-bucket trust boundary, approval compensation,
  reconciliation, CLI, resolver policy, and limitations. The demo UI still
  uses its existing fallback and has no browser moderation or redesign.

### Remaining limitations after M1-05

- Discovery supports GitHub repository owner avatars only. It does not crawl
  project websites, READMEs, or third-party image hosts.
- Official candidates must be supplied by a trusted operator as local files;
  no browser moderation or remote official-logo fetch is available.
- The public frontend is not database-backed and does not render stored logo
  assets yet. Discovery and reconciliation are manual, not scheduled.
- A public bucket object may be briefly visible between explicit approval upload
  and the approval transaction, because Storage and Postgres cannot commit
  atomically. Failed transactions trigger fenced cleanup and explicit
  reconciliation.

## M1-06 — End-to-end ingestion pilot and operational readiness (implemented)

- Added a bounded operator command that runs discovery, enrichment,
  assessment, pending logo-candidate discovery, and final inventory/audit in
  order by invoking the existing workers and durable queues.
- Added dry-run, explicit execute, resume, read-only status, read-only
  integrity audit, and opt-in live GitHub smoke modes. Remote writes require
  explicit project-reference guards; unclassifiable remote hosts are blocked.
- Added service-role-only aggregate inventory/preflight and run-scoped row
  relationship reports, without replacing ingestion-job or checkpoint state.
- Added bounded coherent-lineage verification that joins candidate, canonical
  repository, assessment, draft, and pending logo through real relationships
  and stable GitHub repository IDs. Reports matching IDs and their evidence;
  unrelated stage records cannot satisfy end-to-end completion.
- Separates worker execution, eligible records committed in this invocation,
  records reused on resume, complete project lineage, and published listings.
  Discovery-only progress and empty results do not claim a newly completed
  project.
- Corrected integrity auditing to preserve historical candidate names after a
  canonical repository rename, retain critical provider-ID conflict findings,
  and avoid treating constraint-valid editorial publication as corruption.
- Reports run-associated committed records, duplicates, skips, partial and
  terminal failures, retry reasons/times, API rate budget, durations, and
  durable checkpoints.
- Added a local PostgREST/PostgreSQL integration that exercises the real
  orchestrator and all four workers against deterministic GitHub fixtures,
  including resume/idempotency, private/rejected candidates, partial data,
  rate limits, failure recovery, review links, pending logos, inventory, audit,
  and RLS boundaries.
- Documented the hosted backup, migration, preflight, small-pilot, audit, and
  recovery procedure. Hosted migration and writes remain operator-controlled;
  no hosted run is included in CI.

### Remaining limitations after M1-06

- The live GitHub smoke mode is opt-in and still depends on the operator's
  GitHub API access and remaining budget. A live hosted Supabase smoke run is
  not required for CI and has not been represented by fixture results.
- SQL integrity audit checks approved logo object references and stored
  provenance metadata; it does not download and hash public Storage object
  bytes. Use the existing logo reconciliation workflow for byte-level checks.
- Discovery remains a bounded sample rather than an exhaustive GitHub crawl.
- Hosted migration and ingestion have not been executed automatically; each
  requires explicit operator target verification and approval.

## M1-07 — Functional editorial review and publishing (implemented)

- Replaced `/admin` local demonstration actions with a private paginated
  Supabase review queue and authenticated `/admin/projects/[id]` evidence page.
- Added narrow Zod-validated server actions for editorial corrections,
  categories/tags, license verification, quality review, pending/review-required
  outcomes, rejection, explicit return-to-review, queue-item resolution, and
  publication. Every action performs a fresh administrator allowlist check.
- Added project revisions, field overrides, and an append-only decision log.
  Stale forms conflict. Source refreshes preserve editorial overrides and
  rejected project state.
- Added independent human licensing evidence requirements and a separate
  quality decision that is explicitly not a security or code audit.
- Added a service-role-only atomic publication RPC. It rechecks allowlisting,
  source freshness/provenance, repository visibility and availability, human
  decisions, active categories, unresolved review items, and concurrency before
  making a project public under existing RLS.
- Added a narrow source-safety correction: a validated terminal GitHub access
  restriction on a published primary repository atomically moves the project
  to `pending_review`, advances its revision, records a system-origin safety
  event, opens one blocking review item, and marks repository availability
  `access_restricted`. Public RLS hides the project and repository at commit.
- Public-source recovery restores repository availability only. Renewed current
  evidence, human verification where needed, review resolution, and a new
  explicit administrator publication decision are required; both publication
  decisions remain in the append-only audit.
- Added pgTAP security assertions, real local Auth/PostgreSQL workflow
  integration, an authenticated Playwright review/edit flow, generated type
  parity, and CI coverage. No hosted migration, production publication, merge,
  or deployment is included.
- Documented policy, evidence, audit, and rollback limits in the README,
  architecture, and data pipeline guides.

### Remaining limitations after M1-07

- Public catalog UI integration is delivered in M1-09; public submissions and
  alternatives remain unavailable until their persistence and query boundaries
  are implemented.
- Hosted migrations and live project publication have not been run. The audit
  is append-only and administrators have no general unpublish or destructive
  rollback action; confirmed primary-source access restrictions are handled by
  the narrow system safety demotion described above.

## M1-08 — Production public catalog search (implemented)

- Added `search_public_projects`, a bounded `SECURITY INVOKER` PostgreSQL RPC
  using public RLS, the existing full-text and trigram indexes, database-level
  pagination, exact totals, five deterministic sort orders, and OR-within /
  AND-across filter groups.
- Tightened project and repository RLS so public project reads require verified
  quality, licensing, and a current available primary repository with
  explicitly public, non-private, non-disabled source state. Search and detail
  results also require an active category.
- Added server-only typed accessors for search, published slug lookup, and
  active categories. Public reads use the publishable key; no service-role
  credential or JSON fallback is used by the access library.
- Added UI-ready bounded project metadata, approved logo selection with owner
  avatar attribution, deterministic letter fallback, pgTAP security checks,
  and a disposable local 1,000-project integration with query-plan probes.
- Updated the README and architecture with the response contract, RLS, index
  strategy, pagination, empty-catalog behavior, logo policy, and verified
  versus unverified performance claims. No hosted migration, data import,
  deployment, or merge is included.

### Remaining limitations after M1-08

- Public pages are wired to the public catalog in M1-09. Hosted latency and
  production data distribution have not been measured.
- Trending remains unavailable until repository snapshots establish enough
  comparable history for a defensible calculation.

## M1-09 — Live Supabase public catalog UI (implemented)

- Connected home, explore, category index/detail, and project detail routes to
  published Supabase records through the existing public RLS API.
- Added URL-backed combined filters, sorting, short-query handling, exact
  totals, database pagination, bounded active-category counts, and command
  search. Empty and unavailable database states never show sample projects.
- Added canonical slug details and metadata, complete source-backed descriptions,
  public related-project lookup, and approved Storage logos with explicit avatar
  attribution and deterministic fallback.
- Removed browser-local publication and submission demonstrations. Appearance
  is the only persisted public UI preference; alternatives and public submission
  routes clearly state they are unavailable. The existing authenticated admin
  editor remains intact.
- Added local Supabase and Playwright public frontend coverage to CI, including
  safety demotion freshness. No hosted migration, publication, deployment, or
  merge is included.

### Remaining limitations after M1-09

- Public alternatives need an approved relationship query, and public
  submissions need persistent storage and moderation before either route can
  accept or claim live data.
- Featured flags are not included in the public catalog query, so the homepage
  uses recent and most-starred sections without trending or featured claims.
- Hosted Supabase configuration, production catalog contents, and production
  latency have not been verified.

## M1-10 — Production launch readiness and first live pilot preparation (implemented)

- Added a read-only `bun run launch:preflight` report for target classification,
  required configuration, applied migration versions, category taxonomy,
  Storage, anonymous public search/RLS, administrator OTP/allowlist setup,
  pipeline operations, integrity findings, inventory, and optional GitHub
  rate-limit data. It redacts credential values and never starts ingestion or
  writes database or Storage records.
- Added a forward migration that updates the existing service-only pipeline
  report to recognize M1-08, M1-09, and the launch-readiness migration. The
  prior report's stale migration list could incorrectly mark a current schema
  incomplete.
- Added a read-only database security assertion, targeted unit coverage, and a
  disposable-local-Supabase preflight integration in the existing database CI
  job. The CI database job still applies the full chain from an empty database.
- Documented the minimum Bun/Next.js deployment settings, human-controlled
  migration workflow, bounded hosted pilot, lineage and editorial checks,
  anonymous website smoke tests, measured scale-up gates, and separate website
  and database recovery procedures. Corrected stale JSON and admin-demo docs.
- No hosted resource, migration, deployment, live GitHub import, or real
  publication was performed. Alternatives and public submissions remain
  unavailable; ingestion remains manually operated.

### Remaining limitations after M1-10

- Hosted Supabase configuration, SMTP delivery, migration application, public
  catalog contents, production latency, and website deployment remain
  unverified. A separate authorization is required for each hosted operation.
- The application has no general administrator unpublish action. The existing
  system-origin demotion handles validated primary-source restrictions; other
  publication corrections require an independently reviewed forward fix.

## Later milestones

- Add a validated public submission/correction endpoint after abuse controls
  and review handling are designed.
- Add recurring enrichment only after operational limits and quality controls
  are established.

The local schema, bounded ingestion pilot, authenticated editorial publishing,
public PostgreSQL search/access layer, live public catalog UI, and launch
preflight/runbook are implemented. Hosted Supabase deployment and the first
real pilot remain unverified.
