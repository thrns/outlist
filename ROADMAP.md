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
- M0-03 still needs administrator authentication and authorization.
- Repository ingestion, validated submission endpoints, project publication
  tools, public database queries, search RPC, and UI integration remain later
  work.

## Later milestones

- Implement server-side data access and replace browser-only persistence when
  the server and access-control model is ready.
- Build a scheduled Bun ingestion worker with validation, provenance,
  idempotency, and operational reporting.
- Add administrator authentication and protected moderation workflows.
- Move catalog search and filtering to PostgreSQL as the schema and query
  behavior are established.

These are plans only. The local schema and policies exist, but hosted Supabase
deployment, a database-backed catalog, repository ingestion, production
search, and administrator authentication are not operational in the current
demo.
