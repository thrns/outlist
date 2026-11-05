# Architecture

## Current implementation

Outlist is a Next.js 16 App Router modular monolith using React 19, TypeScript,
Tailwind CSS, and component-based routes. The existing home, explore, category,
project, alternatives, submission, and demo admin pages render from the
committed 33-project JSON catalog. The demo's editable state is persisted in
browser `localStorage`.

Supabase infrastructure now includes separated browser, SSR server, and
privileged server clients, Zod configuration validation, versioned SQL
migrations, a normalized PostgreSQL catalog, database policies, and a
`project-logos` Storage bucket. The UI still reads the committed 33-project
JSON catalog and does not call those clients. No ingestion worker or
database-backed public pages run yet.

## Intended system

```text
Browser
  └─ Next.js UI and route handlers / server actions
       ├─ Supabase SSR client: publishable key + request cookies
       ├─ Server-side access checks: user identity, roles, and policies
       └─ Privileged Supabase client: secret key, isolated server modules
            ├─ Supabase PostgreSQL: catalog, provenance, moderation, and ingestion state
            └─ Supabase Storage: approved project logos

Scheduled Bun ingestion worker
  └─ source adapters → validation/normalization → PostgreSQL + Storage
```

The browser/server clients and database schema are implemented, but the public
website and worker do not use them yet. The web application stays a modular
monolith. A Bun worker is a separate scheduled process for repository
ingestion, not another web service. PostgreSQL owns normalized catalog data and
the indexed search document; M2-01 will add the public search RPC. Storage is
limited to approved logo assets. Permitted source payloads are stored as
provenance-linked JSON in the private `source_records` table.

## Security boundaries

- Client components may import only the browser client. It accepts the public
  URL and publishable key.
- Server Components, Server Actions, and Route Handlers may use the cookie-aware
  SSR client. It reads and writes cookies through Next.js 16's async `cookies()`
  API. Cookie writes are ignored during render-only Server Component execution.
- The privileged client uses `SUPABASE_SECRET_KEY` and imports `server-only`.
  It does not read or reuse a browser session and has session persistence,
  refresh, and URL detection disabled.
- Client constructors validate credentials when called. Missing credentials
  therefore do not block rendering or production builds that do not invoke a
  Supabase operation.
- RLS is enabled on every application table. Anonymous and ordinary
  authenticated roles can read only published catalog records and safe
  relationships; there are no client write policies. Submissions, provenance,
  candidate queues, ingestion history, moderation, overrides, and admin
  allowlisting are private. Auth pages and admin authorization workflows are
  reserved for M0-03.

## Schema and generated types

Versioned SQL in `supabase/migrations/` is the source of truth for the schema.
It defines `projects`, `repositories`, normalized categories and tags,
repository metadata and snapshots, source provenance, logo metadata,
alternatives, submissions, moderation, administrator allowlisting, and
restartable ingestion state. The project points to its one primary repository
through a same-project composite foreign key; project/category and project/tag
relationships are many-to-many. Repository candidates remain separate from
published projects until curated.

RLS and column-level grants limit public queries to published projects,
available associated repositories, active taxonomy, approved logos, and
approved alternatives. No browser role can write canonical data. The public
logo bucket accepts PNG, JPEG, and WebP up to 2 MiB. Public bucket URLs bypass
object read policies, so future server ingestion must validate and upload only
approved files. SVG and arbitrary user-controlled object paths are excluded.

Database types are generated from the migrated local database with the pinned
Supabase CLI (`bun run supabase:types`) and then consumed by the browser, SSR,
and privileged client factories. The generated file is checked in CI for
schema drift.

## Local setup

Install dependencies with `bun install --frozen-lockfile`. With Docker Desktop,
OrbStack, or another Docker-compatible runtime available, start local services
with `bun run supabase start`, rebuild a clean database with
`bun run supabase db reset`, run pgTAP tests with `bun run supabase:db-test`,
and lint with `bun run supabase:db-lint`. Generate types after migrations with
`bun run supabase:types`. `bun run supabase status` prints local keys and
`bun run supabase stop` shuts services down. No hosted project or production
credential is required.
