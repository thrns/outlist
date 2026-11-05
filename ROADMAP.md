# Roadmap

This roadmap separates the current demo from planned platform capabilities.

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

### Remaining limitations after M0-03

- Hosted Supabase project settings and administrator provisioning remain
  outside this verification. The CI suite covers local Supabase Auth,
  PostgreSQL, Mailpit, and the production Next.js browser flow only; it does
  not prove hosted SMTP delivery or hosted Auth behavior.
- Admin moderation, project publishing, and sync controls still update only
  browser `localStorage`; these administrator controls do not write to the
  production database.

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
  candidate discovery and restartable Supabase queues; normalization,
  enrichment, scheduling, quality checks, license verification, and
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
- Added an explicit bounded Bun CLI, unit/pgTAP coverage, disposable Supabase
  concurrency tests in CI, and operations documentation.
- Kept candidates separate from canonical projects and repositories. This
  milestone does not normalize, verify licenses, classify, fetch logos, or
  publish listings.

### Remaining limitations after M1-02

- The ten-partition initial plan is a bounded topic and language sample.
  GitHub Search has
  indexing/scope limits, a 1,000-result window, and possible incomplete
  results; the plan does not claim exhaustive GitHub coverage.
- The worker is manually invoked and serial. It is not scheduled and does not
  enrich or publish candidates. No live collection is run by ordinary CI.
- Local PostgreSQL integration depends on a running Docker-compatible runtime;
  GitHub Actions exercises the queue against disposable local Supabase.

## Later milestones

- Implement server-side data access and replace browser-only persistence when
  the server and access-control model is ready.
- **M1-03:** Consume queued candidates and normalize verified repository
  metadata into the canonical database without automatically publishing
  projects.
- Build later scheduled enrichment workflows with validation, provenance,
  idempotency, and operational reporting.
- Move catalog search and filtering to PostgreSQL as the schema and query
  behavior are established.

The local schema, service-only candidate queue, and bounded discovery worker
are implemented. Hosted Supabase deployment, a database-backed catalog,
candidate enrichment, production search, and database-backed moderation remain
outside the current demo.
