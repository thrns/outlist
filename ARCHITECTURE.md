# Architecture

## Current implementation

Outlist is a Next.js 16 App Router modular monolith using React 19, TypeScript,
Tailwind CSS, and component-based routes. The existing home, explore, category,
project, alternatives, submission, and demo admin pages render from the
committed 33-project JSON catalog. The demo's editable state is persisted in
browser `localStorage`.

Supabase infrastructure in M0-01 consists of separated browser, SSR server,
and privileged server clients, Zod configuration validation, a project-local
CLI configuration, and a migrations directory. The UI does not call those
clients, and there is no production database schema or active ingestion
pipeline yet.

## Intended system

```text
Browser
  └─ Next.js UI and route handlers / server actions
       ├─ Supabase SSR client: publishable key + request cookies
       ├─ Server-side access checks: user identity, roles, and policies
       └─ Privileged Supabase client: secret key, isolated server modules
            ├─ Supabase PostgreSQL: catalog, moderation, and ingestion state
            └─ Supabase Storage: source snapshots and project assets

Scheduled Bun ingestion worker
  └─ source adapters → validation/normalization → PostgreSQL + Storage
```

This is the target architecture, not a claim that these services or flows are
already operational. The web application stays a modular monolith. A Bun worker
is a separate scheduled process for repository ingestion, not another web
service. PostgreSQL will own catalog search and filtering; Supabase Storage is
for file assets and retained source artifacts.

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
- Authentication routes, a Next.js proxy, role checks, and production row-level
  security policies are intentionally left for the administrator-auth and
  schema milestones.

## Schema and generated types

Versioned SQL in `supabase/migrations/` will be the source of truth for the
PostgreSQL schema. Migrations are applied in order by the Supabase CLI. Once
M0-02 creates the schema, generate and commit TypeScript database types from
the local database, then use those types in the Supabase client factories.
Generated types must follow migrations rather than becoming a second schema
definition.

## Local setup

Install dependencies with `bun install --frozen-lockfile`. With Docker Desktop,
OrbStack, or another Docker-compatible runtime available, start local services
with `bun run supabase start`; inspect printed local keys with
`bun run supabase status`; stop with `bun run supabase stop`. No hosted project
is required for this workflow.
