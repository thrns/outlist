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
  browser `localStorage`; no production database writes are implemented.

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

- The adapter reads one explicitly named repository. Candidate discovery,
  restartable Supabase queues, normalization, data persistence, scheduling,
  quality checks, license verification, and publication are not implemented.
- The optional CLI smoke test verifies only the requested repository and
  endpoints; it does not validate the future scheduled ingestion pipeline.

## Later milestones

- Implement server-side data access and replace browser-only persistence when
  the server and access-control model is ready.
- **M1-02:** Discover GitHub repository candidates, collect them from approved
  queries, and ingest through restartable Supabase queues.
- Build later scheduled ingestion workflows with validation, provenance,
  idempotency, and operational reporting.
- Move catalog search and filtering to PostgreSQL as the schema and query
  behavior are established.

These are plans only. The local schema and policies exist, but hosted Supabase
deployment, a database-backed catalog, repository discovery and ingestion,
production search, and database-backed moderation are not operational in the
current demo.
