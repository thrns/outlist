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
`project-logos` Storage bucket. Public UI still reads the committed 33-project
JSON catalog. The admin route uses Supabase Auth for invite-only OTP sign-in
and authorization, while its moderation controls remain localStorage
demonstrations. A standalone, read-only GitHub REST adapter and local
single-repository inspection CLI are implemented. They do not write to
Supabase; no discovery or ingestion worker and no database-backed public pages
run yet.

## Intended system

```text
Browser
  └─ Next.js UI and route handlers / server actions
       ├─ Supabase SSR client: publishable key + request cookies
       ├─ Admin Proxy: verified claims refresh for /admin routes only
       ├─ Admin server gate: verified Auth UUID + fresh admin_users lookup
       └─ Privileged Supabase client: secret key, isolated server modules
            ├─ Supabase PostgreSQL: catalog, provenance, moderation, and ingestion state
            └─ Supabase Storage: approved project logos

Scheduled Bun ingestion worker
  └─ source adapters → validation/normalization → PostgreSQL + Storage
```

The browser/server clients and database schema are implemented, but the public
website and ingestion worker do not use them yet. The standalone GitHub
adapter can read repository metadata by path or stable numeric repository ID,
languages, topics, detected license metadata, releases, and rate-limit status.
It runs independently of Next.js cookies or browser sessions. Its numeric
provider ID is stable across repository renames, and each result carries typed
data and source provenance. It has no Supabase client dependency and makes
only `GET` requests. A Bun worker will be a separate scheduled process for
repository ingestion, not another web service. PostgreSQL owns normalized
catalog data and the indexed search document; M2-01 will add the public search
RPC. Storage is limited to approved logo assets. Permitted source payloads are
stored as provenance-linked JSON in the private `source_records` table by a
future ingestion milestone.

The GitHub client reads optional `GITHUB_TOKEN` configuration at construction
time, sends it only as `Authorization: Bearer`, and uses GitHub REST API
version `2022-11-28`. It remains in server/Bun code and is not imported by
client components. ETags produce explicit `not_modified` results; topic and
release pagination is sequential, origin/path checked, loop checked, and bounded. Rate
limit, retry, timeout, abort, malformed payload, and HTTP errors have
structured kinds. GitHub 404s remain ambiguous and do not establish deletion.
GitHub license identifiers are source data and do not establish Outlist
license verification or publication eligibility.

## Administrator authentication and security boundaries

- Client components may import only the browser client. It accepts the public
  URL and publishable key.
- Server Components, Server Actions, and Route Handlers may use the cookie-aware
  SSR client. It reads and writes cookies through Next.js 16's async `cookies()`
  API. Cookie writes are ignored during render-only Server Component execution.
- The privileged client uses `SUPABASE_SECRET_KEY` and imports `server-only`.
  It does not read or reuse a browser session and has session persistence,
  refresh, and URL detection disabled.
- `/admin/login` requests an email OTP with `shouldCreateUser: false`; a Server
  Action verifies the code using `verifyOtp({ type: "email" })`. Auth errors
  during the request step produce the same generic response for every address.
- Root `proxy.ts` matches only `/admin` and `/admin/*`. It uses the publishable
  key and `getClaims()` to refresh the SSR cookie session, copies cookie updates
  to both the forwarded request and response, and never creates the privileged
  client. Cookies are HTTP-only, same-site lax, and secure in production.
- The dynamic admin layout gates every `/admin/*` page except the login route.
  `/admin` also calls `requireAdmin()` itself. The helper verifies the session
  with `getClaims()`, validates the `sub` UUID, and makes a fresh server-only
  exact-match query against `public.admin_users` for each call. It trusts no
  email, user metadata, client storage, or client-supplied role. Removed rows
  revoke access on the next protected request.
- Protected pages are dynamically rendered and marked `private, no-store`.
  Any future protected Server Action or Route Handler must call
  `requireAdmin()` independently before performing work; Proxy routing alone
  is not authorization.
- Logout is a POST Server Action that calls `signOut()`, clears Supabase Auth
  cookies, and redirects to `/admin/login`.
- `public.admin_users` remains private under its existing RLS and grants. The
  privileged server key performs the membership read; ordinary database roles
  cannot read or modify the allowlist.
- Client constructors validate credentials when called. Missing credentials
  therefore do not block rendering or production builds that do not invoke a
  Supabase operation.
- RLS is enabled on every application table. Anonymous and ordinary
  authenticated roles can read only published catalog records and safe
  relationships; there are no client write policies. Submissions, provenance,
  candidate queues, ingestion history, moderation, overrides, and admin
  allowlisting are private.

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
