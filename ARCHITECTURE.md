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
and has a separate Supabase-backed editorial review and publication workflow.
A standalone, read-only GitHub REST adapter and local
single-repository inspection CLI are implemented. M1-02 extends the adapter
with repository search and adds a separate, bounded Bun worker that writes
unreviewed candidates and durable checkpoints to Supabase. The public UI still
does not use the database. M1-03 adds a separate, restartable GitHub
enrichment worker that normalizes candidate source metadata into canonical
repository tables without creating projects. M1-04 adds a private assessment
worker that turns successfully enriched repositories into explainable
assessments and pending-review drafts through a single transaction. M1-05 adds
pending logo candidates, and M1-06 composes all four existing workers through
a bounded operator command with service-only inventory and integrity reports.
M1-07 adds private queue/detail reads, evidence-backed editorial corrections,
explicit license and quality decisions, conflict-fenced status changes, and
atomic service-role-only publication.

## Intended system

```text
Browser
  └─ Next.js UI and route handlers / server actions
       ├─ Supabase SSR client: publishable key + request cookies
       ├─ Admin Proxy: verified claims refresh for /admin routes only
       ├─ Admin server gate: verified Auth UUID + fresh admin_users lookup
       ├─ Editorial Server Actions: fresh allowlist check + strict Zod inputs
       └─ Privileged Supabase client: secret key, isolated server modules
            ├─ Supabase PostgreSQL: catalog, provenance, moderation, and ingestion state
            │    └─ Narrow editorial RPCs: eligibility checks + revision + audit + publish transaction
            └─ Supabase Storage: approved project logos

Standalone Bun discovery worker (M1-02)
  └─ GitHub Search API → validated candidate pages → transactional PostgreSQL queue

Standalone Bun enrichment worker (M1-03)
  └─ candidate lease → GitHub repository ID lookup → validated normalization
       → atomic PostgreSQL repository, subresource, snapshot, and provenance commit

Standalone Bun assessment worker (M1-04)
  └─ assessment lease → source-backed category/license/quality rules
       → atomic assessment evidence, draft association, and editorial review queue

Standalone Bun operator (M1-06)
  └─ safe preflight → discovery → enrichment → assessment → pending logo candidates
       → aggregate inventory, run-scoped persisted-row checks, read-only audit
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
- Editorial Server Actions call `requireAdmin()` and validate a fixed set of
  fields with Zod. The service-role functions recheck `admin_users` using the
  authenticated UUID passed only by the server action. They accept only narrow
  operations: save editorial fields, verify a license, verify minimum quality,
  change review state, resolve one queue item, or publish one project.
- Queue and detail reads use the privileged client only after an allowlist
  check, and are bounded (25 projects per page and finite evidence lists).
  Private source payloads, assessments, overrides, review items, and decisions
  are never queried from browser code. The service key is server-only.
- `editorial_revision` fences stale forms. License and quality decisions also
  bind to the exact source observation the administrator saw. The publication
  RPC takes project and repository locks, rechecks evidence and open review
  items, updates publication state, closes applicable queue rows, and appends
  one audit record in a single transaction. Repeated publication is
  idempotent. Audit rows reject update and delete operations.
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
M1-07 adds the project editorial revision and the private append-only
`editorial_decisions` table. Editorial field overrides are applied when
service/pipeline updates leave the revision unchanged; review actions increment
the revision and write their overrides and audit rows atomically.
The project points to its one primary repository
through a same-project composite foreign key; project/category and project/tag
relationships are many-to-many. Repository candidates remain separate from
published projects until curated.

RLS and column-level grants limit public queries to published projects,
available associated repositories, active taxonomy, approved logos, and
approved alternatives. No browser role can write canonical data. The public
logo bucket accepts normalized WebP output up to 2 MiB. Public bucket URLs
bypass object read policies, so M1-05 uploads only after explicit trusted
operator approval; random paths reduce guessing but do not provide access
control. Discovery stores candidate provenance and review metadata but no image
bytes. Every approval attempt uses its database token in the immutable path
`<project-uuid>/<logo-uuid>/<approval-token>.webp` and uploads with no overwrite.
The approval RPC commits the winning path and SHA-256 digest together. Database
fencing alone cannot fence an external Storage request, so this path identity
prevents a stale worker from changing a later winner. A private service-role
attempt ledger supports cleanup of unreferenced uploads after errors or
crashes. Reconciliation verifies existing bytes and restores only a confirmed
missing object; a digest mismatch needs review. Legacy approved paths remain
valid, and legacy rows without a digest are not restored automatically.
Official logos outrank approved GitHub owner avatars; avatars remain labeled
as avatars. The resolver otherwise returns a deterministic letter fallback.
SVG and arbitrary user-controlled object paths are excluded. Browser roles have
no Storage write policy; approval RPCs are service-role-only.

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
hosted project or production credential is required. `bun run test:editorial-db`
uses local Auth identities and PostgreSQL to exercise
administrator allowlisting, independent license evidence, explicit quality
review, publication blockers, concurrency, revocation, audit events, and public
RLS visibility. Playwright also signs in through local OTP/Mailpit and edits a
real Supabase draft in the production Next.js build.

## M1-06 ingestion operator boundary

`scripts/pipeline.ts` is a server-side Bun operator command, not a browser API.
It composes the existing discovery, enrichment, assessment, and logo discovery
workers in order and keeps their PostgreSQL jobs, claims, retry state, and
discovery checkpoints authoritative. Its random run identifier is attached to
the existing job metadata and logo provenance only so the operator can
attribute persisted rows and inspect their relationships. It does not create
a second queue or checkpoint table.

The command preflights the server-only Supabase credential, database schema
and RPC grants, category seed, Storage bucket, target host/reference,
running jobs and active leases, and GitHub API rate budget. `--status` and
`--audit` are read-only and do not start search. The aggregate report and
run-scoped verifier are service-role-only security-definer functions. Browser
roles cannot read the ingestion inventory or call them.

The default is dry-run; writes require `--execute`. Per-stage limits are
bounded, hosted writes require explicit target flags, and custom remote hosts
without an inferable project reference are blocked. Live smoke uses read-only
GitHub HTTP requests, then inspects committed rows and relationships through
the privileged report before it can be called successful. It never approves
licenses or logos, verifies quality, uploads logo bytes, or publishes a
project. Hosted migration and ingestion remain separately approved operator
actions; CI uses local Supabase and deterministic HTTP fixtures only.

The run report separates worker execution, durable records committed during
the invocation, records reused during resume, and completion of one coherent
candidate-to-pending-logo project lineage. The service-only verifier joins the
stages through their actual foreign keys and matching stable GitHub repository
ID, caps inspection to the pilot's 50-record budget, and returns the matched
record IDs and provenance/review evidence. A discovery candidate alone can be
committed while execution finishes without producing a project. Reused
lineage can be reported on resume without counting its rows as new commits.
Publication remains a separate editorial state.

Inventory counts come from aggregate SQL queries. Integrity findings identify
duplicate provider identities, invalid candidate/project/review relationships,
restricted assessments, unsupported draft categories, missing provenance,
inconsistent snapshots, invalid approved-logo object references, objectively
invalid published states, and job-counter mismatches. Candidate identity uses
provider and stable numeric provider ID, so an older discovered name can differ
from the renamed canonical name without a false finding. Candidate-to-repository
ID conflicts remain critical. A valid editorial publication is not classified
as unauthorized based only on automated-assessment provenance. The audit
returns findings only; it never repairs or deletes records.

## M1-07 editorial boundary

M1-07 does not expose a generic privileged project update. Admins can change
name, summary, description, official website, active categories, and tags;
slug, stable repository identity, featured rank, and logo approval remain
outside the review form. License verification accepts current OSI-approved
SPDX identifiers with independent non-GitHub evidence and an explicit human
decision. The database binds both license and quality reviews to current
validated source provenance. Quality review records minimum catalog checks and
states explicitly that it is not a security/code audit or reliability claim.

Only projects with complete current evidence, public available repositories,
active categories, verified license and quality decisions, and no unresolved
blocking review items can be published. Public readers continue using the
existing RLS policy. This milestone does not connect the public directory to
PostgreSQL search or perform hosted migrations. Published projects have no
rollback action in the admin UI; the append-only audit remains available for a
separately reviewed correction or unpublishing policy.
