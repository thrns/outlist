# Roadmap

This roadmap separates the current demo from planned platform capabilities.

## M0-01 — Bun and Supabase foundation

- Standardize Bun, preserve the existing demo and 33-project catalog, and add
  automated checks.
- Add environment-safe browser, SSR, and privileged Supabase client factories.
- Add local Supabase CLI configuration and the SQL migrations workflow.
- Document architecture and future data handling.

## M0-02 — Database schema

- Define the production catalog and ingestion schema in versioned SQL migrations.
- Add indexes and row-level security policies appropriate to the data model.
- Generate and commit TypeScript database types from the local schema.
- No schema is included in M0-01.

## Later milestones

- Implement server-side data access and replace browser-only persistence when
  the server and access-control model is ready.
- Build a scheduled Bun ingestion worker with validation, provenance,
  idempotency, and operational reporting.
- Add administrator authentication and protected moderation workflows.
- Move catalog search and filtering to PostgreSQL as the schema and query
  behavior are established.

These are plans only. Hosted Supabase services, a database-backed catalog,
repository ingestion, production search, and administrator authentication are
not operational in the current demo.
