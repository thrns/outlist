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
single-repository inspection CLI are implemented. M1-02 extends the adapter
with repository search and adds a separate, bounded Bun worker that writes
unreviewed candidates and durable checkpoints to Supabase. The public UI still
does not use the database. M1-03 adds a separate, restartable GitHub
enrichment worker that normalizes candidate source metadata into canonical
repository tables without creating projects. M1-04 adds a private assessment
worker that turns successfully enriched repositories into explainable
assessments and pending-review drafts through a single transaction.

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

Standalone Bun discovery worker (M1-02)
  └─ GitHub Search API → validated candidate pages → transactional PostgreSQL queue

Standalone Bun enrichment worker (M1-03)
  └─ candidate lease → GitHub repository ID lookup → validated normalization
       → atomic PostgreSQL repository, subresource, snapshot, and provenance commit

Standalone Bun assessment worker (M1-04)
  └─ assessment lease → source-backed category/license/quality rules
       → atomic assessment evidence, draft association, and editorial review queue
```

The browser/server clients and database schema are implemented, but the public
website does not use them yet. The GitHub adapter reads repository metadata by
path or stable numeric repository ID, languages, topics, detected license
metadata, releases, repository search results, and rate-limit status. Search
results use an endpoint-specific schema because GitHub's Search API does not
guarantee every field returned by the full repository endpoint. Numeric
provider IDs remain stable across renames. The adapter makes only `GET`
requests.

The M1-02 Bun worker is a separate CLI process, not a web endpoint. It accepts
only the ten topic and language partitions in the versioned `initial` plan,
uses conservative serial claims, and persists candidates and page provenance
through narrow service-role SQL functions. `discovery_queries` holds the query
fingerprint, cursor, retry time, lease, and fencing token. Exact plan
re-registration leaves the partition row unchanged. An incompatible definition
cannot reset an active lease or alter a same-version checkpoint; an intentional
definition change requires a new plan version or an explicit reset migration.
The candidate limit is an execution budget and does not alter the persisted
query page size. If a whole fetched page exceeds the remaining budget, the
worker releases it without advancing the cursor. Each page commit updates
source provenance, candidates, counts, and the checkpoint in one PostgreSQL
transaction. The 2020–2026 topic and language sample is intentionally bounded
and is not an exhaustive GitHub crawl. Search results above the 1,000-result
window or marked incomplete are split by adjacent creation-date ranges when
possible; otherwise they are left for review. Candidate rows remain separate
from canonical projects and repositories. The CI worker integration runs the
actual CLI orchestration against disposable local Supabase with deterministic
GitHub HTTP fixtures; it does not verify a live GitHub crawl or hosted Supabase.
The M1-03 enrichment worker claims eligible GitHub candidates through a
separate queue status, expiring lease, worker ID, and random fencing token.
It resolves repositories by stable numeric ID, validates source responses,
and uses the normalization layer before a single transaction persists
canonical repositories, complete language/topic sets, bounded releases,
daily snapshots, provenance, candidate links, and job counters. A failed
subresource is recorded and scheduled for retry without replacing that
subresource's prior valid data. Expired claims can be reclaimed; stale workers
cannot commit. Source ETags are retained but conditional reuse is disabled
until validated cached response support exists. Enrichment does not write
`projects`; assessment creates only `pending_review` drafts when category
evidence supports a primary category. License detection remains unverified
and quality remains unreviewed. Editorial approval and publication remain
later work. PostgreSQL owns normalized catalog data and
the indexed search document; M2-01 will add the public search RPC. Storage
remains limited to approved logo assets.

Enrichment accepts repository metadata only when GitHub's response indicates
public visibility. A private flag, explicit non-public visibility, or
contradictory visibility indicators produce a lease-fenced terminal candidate
outcome containing only safe classification and request provenance. The
database rejects private canonical writes. For an existing canonical row, the
worker may change availability to `access_restricted` while preserving its ID,
project association, and prior public observations. Ambiguous 404 responses do
not establish that a repository became private or was deleted. Repository
homepage values are normalized as absolute HTTP or HTTPS URLs; credentials,
control characters, malformed values, and non-web schemes are rejected and
represented with a safe `rejected` source-field state. Homepages are never
fetched, and an unsafe homepage does not block other repository metadata. A
previously accepted homepage may remain stored after a newer value is rejected.

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
alternatives, submissions, moderation, administrator allowlisting, restartable
ingestion state, and private repository assessments with source-reference rows.
The project points to its one primary repository
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
schema drift. The enrichment migration adds canonical source fields, compact
resource provenance, release observation times, and candidate queue state;
the five mutation RPCs are executable only by `service_role`.

## Local setup

Install dependencies with `bun install --frozen-lockfile`. With Docker Desktop,
OrbStack, or another Docker-compatible runtime available, start local services
with `bun run supabase start`, rebuild a clean database with
`bun run supabase db reset`, run pgTAP tests with `bun run supabase:db-test`,
and lint with `bun run supabase:db-lint`. Generate types after migrations with
`bun run supabase:types`. `bun run supabase status` prints local keys and
`bun run supabase stop` shuts services down. Run
`bun run test:discovery-db`, `bun run test:enrichment-db`, and
`bun run test:assessment-db` against disposable local Supabase. The assessment
test executes the real CLI through PostgREST using deterministic GitHub HTTP
fixtures, then checks draft creation, review queue linkage, idempotency,
rename handling, editorial preservation, and ordinary-client denial. No
hosted project or production credential is required.
