# Data pipeline

## Current behavior

The current catalog is the checked-in `src/data/projects.json` sample set. It
contains 33 illustrative project records and is validated by
`bun run validate:data` and Vitest. The UI searches and sorts this data in the
browser. Submission, moderation, and sync actions are local demo behavior.

The production schema starts with no project listings. The only seeded rows
are the 11 category taxonomy records. M1-01 adds a read-only GitHub REST API
adapter. M1-02 adds a bounded repository discovery worker that writes private,
unreviewed candidates and durable page checkpoints. Neither milestone writes
canonical projects or repositories.

## M1-01 GitHub source adapter

The reusable Bun/TypeScript adapter lives under `src/lib/github/`. It uses
native `fetch` and endpoint-specific Zod schemas. Supported read endpoints are:

- `GET /repos/{owner}/{repo}` and `GET /repositories/{repository_id}` for
  repository identity, metadata, counts, state, timestamps, primary language,
  topics included in the repository payload when GitHub returns them, and raw
  license summary fields.
- `GET /repos/{owner}/{repo}/languages` for language byte counts.
- `GET /repos/{owner}/{repo}/topics` for repository topics.
- `GET /repos/{owner}/{repo}/license` for GitHub's detected license metadata.
- `GET /repos/{owner}/{repo}/releases` for bounded, Link-header-paginated
  release metadata.
- `GET /rate_limit` for an explicit diagnostic snapshot.

The numeric GitHub repository ID is the stable provider identity. Owner and
name are retained as current source attributes and locators; renames do not
change the provider ID. The adapter returns typed records and provenance with
provider, resource type and identity, source API URL, fetch time, HTTP status,
ETag, rate-limit fields, API version, and parsed data. Optional source fields
preserve `present`, `null`, and `absent`; adapter result types also represent
`unavailable` and `unsupported` fields. No raw HTTP payload or response headers
are written to disk or Supabase.

Set an optional `GITHUB_TOKEN` in the Bun worker's server environment to raise
the available API rate limit or access authorized repositories. Public
inspection also works without a token. Requests use `Authorization: Bearer`,
`Accept: application/vnd.github+json`, `User-Agent: outlist-github-api-adapter`,
and the explicit `X-GitHub-Api-Version: 2022-11-28`. The token is read when a
client is created, is never included in browser configuration, and is never
printed. Do not put it in a `NEXT_PUBLIC_` variable or commit it.

All requests are read-only `GET`s. The client supports caller ETags through
`If-None-Match`; a `304` is returned as `kind: "not_modified"` without an empty
or fabricated repository body. A fresh client revalidating repository metadata
must also be given the known numeric `repositoryId`, so conditional provenance
keeps the stable provider identity. Topic and release pages follow GitHub's `Link`
header serially, validate the trusted API origin and expected resource path,
detect loops, and enforce caller-configurable limits (default: 10 pages and
1,000 items; GitHub's page size is capped at 100). The
`iterateRepositoryTopicPages` and `iterateRepositoryReleasePages` methods allow
page-at-a-time consumption; their aggregate methods return bounded results and
per-page provenance. The inspection CLI previews up to five releases from the
first 20-item page only; it says so in its output and does not fetch later pages.

Rate-limit metadata includes `x-ratelimit-limit`, `x-ratelimit-remaining`,
`x-ratelimit-reset`, `x-ratelimit-resource`, and `Retry-After`. The client
distinguishes primary limits from secondary limits when response headers or
the GitHub error message allow it. It respects reset/Retry-After instructions;
when the requested wait exceeds the configurable maximum (30 seconds by
default), it returns a structured `rate_limit` error and retry delay. Network,
timeout, and 5xx failures, including transient response-body read failures, use
at most two retries by default with bounded jittered backoff. The 15-second
request timeout and 45-second total elapsed limit cover response-body reads.
JSON response bodies are limited to 2 MiB and error bodies to 32 KiB; oversized
responses fail with a structured `response_too_large` error. 401, 404, 422,
malformed JSON, unexpected content types, cancellation, and
pagination violations have distinct error kinds. A 404 means unavailable to
this request; it cannot confirm deletion or distinguish private access.

GitHub license keys and SPDX identifiers, including `NOASSERTION`, are source
facts only. The adapter never sets Outlist's `verified_open_source` status.
Stars and pushed timestamps are not trending scores, and source metadata does
not verify quality. GitHub may return 404 from its license endpoint when it
does not detect license information or when access is restricted; that result
is represented as ambiguous and unavailable, not as a verified license.

Inspect one repository locally with:

```bash
GITHUB_TOKEN=... bun run github:inspect -- vercel/next.js --topics --languages --releases
```

`GITHUB_TOKEN` is optional for public repositories. A limited one-repository
live smoke check (which does not prove the complete pipeline) is available
with:

```bash
GITHUB_TOKEN=... bun run github:smoke -- vercel/next.js
```

The CLI validates `owner/name`, displays only selected fields, and never writes
to Supabase. Ordinary unit tests use mocked HTTP responses and do not need
network access or a token. The M1-01 adapter retrieved one known repository at
a time. M1-02 adds bounded repository search and candidate persistence;
normalization, metric snapshots, scheduled imports, license verification, and
publication remain later work.

Official references: [repository endpoints](https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28),
[repository search](https://docs.github.com/en/rest/search/search?apiVersion=2022-11-28),
[release endpoints](https://docs.github.com/en/rest/releases/releases?apiVersion=2022-11-28),
[license endpoints](https://docs.github.com/en/rest/licenses/licenses?apiVersion=2022-11-28),
[authentication](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api?apiVersion=2022-11-28),
[API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions?apiVersion=2022-11-28),
[pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api?apiVersion=2022-11-28),
[conditional requests](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api?apiVersion=2022-11-28),
and [rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2022-11-28).

## M1-02 GitHub discovery and candidate queue

The standalone `scripts/discover.ts` Bun worker executes only an approved
`initial` plan. The plan contains ten deterministic partitions: three topic
groups (`developer-tools`, `self-hosted`, `ai-machine-learning`) and two
language groups (`TypeScript`, `Python`), each split into `stars:0..99` and
`stars:>=100`. All partitions add `is:public`, `fork:false`, and a bounded
repository creation range from 2020-01-01 through 2026-11-05. Topic and
language partitions may overlap, so candidates are deduplicated by provider
repository ID. Each partition records a stable key, plan version, fingerprint
of the exact query and parameters, result order, per-page size, date
boundaries, and intended coverage. The plan is a representative sample, not
exhaustive GitHub coverage.

GitHub Search returns at most 100 results per page and at most 1,000 results
per query. Its documentation also describes a limited search scope, timeouts
with `incomplete_results`, and separate search rate limits. The worker checks
`total_count` and `incomplete_results`; it never records those partitions as
exhausted. It bisects creation-date ranges into adjacent, non-overlapping child
queries when a split is possible. A saturated single-day range, or a result
that cannot be split safely, remains `needs_review`. Overlapping results are
deduplicated by stable numeric GitHub repository ID, while every page
observation retains source provenance.

The default command only prints the plan and makes no database writes:

```bash
bun run discover -- --plan initial --dry-run
```

Real writes require `--execute`, validated server-only Supabase configuration,
and bounded limits. Work is serial by default; limits are capped at 20 query
partitions, 10 pages, and 1,000 search results per run:

```bash
bun run discover -- --plan initial --execute --max-queries 2 --max-pages 2 --max-candidates 200
bun run discover -- --plan initial --execute --resume --max-queries 2 --max-pages 2 --max-candidates 200
```

`--resume` reuses the compatible persisted checkpoint. Executions without the
flag also preserve compatible checkpoints; neither path restarts a completed
or partially committed partition at page one. Query definitions and their
fingerprints remain stable when execution limits change. `--max-candidates`
is a run budget, not a page-size setting: if a fetched page exceeds the
remaining budget, the worker releases the lease without committing or moving
the cursor, so no search results are skipped. The registered page size stays
at 100 for the initial plan. A genuinely changed query or page size in the same
plan version is rejected with the partition name and preserves its checkpoint.
An intentional incompatible definition requires a new plan version, which
resets that partition's checkpoint only after any live lease ends, or an
explicit reset migration. Existing candidate rows, provenance, and review
decisions remain intact.

A worker claim uses PostgreSQL row locking and `SKIP LOCKED`, a worker ID,
expiring lease, and random fencing token. Exact plan re-registration is a
no-op for the partition row, including its lease, owner, checkpoint, counters,
and job attribution. An incompatible registration cannot invalidate a live
lease. A stale worker cannot commit after expiry or after another worker
reclaims the row. Retry eligibility and safe error summaries are persisted.
GitHub's `search` resource headers are stored separately from the core API
budget. Long retry delays are scheduled in PostgreSQL rather than causing a
tight retry loop.

The CLI constructs its privileged Supabase client inside its operational error
handler. Missing configuration and PostgREST connectivity failures return
structured, nonzero errors without credentials or success summaries. Database
connection failures are reported separately from GitHub API failures; the
worker never switches to a hosted project when local Supabase is unreachable.

Each committed page is one database function transaction. It inserts compact
page provenance (no raw search payload), upserts validated candidate metadata,
links candidates to the page source, updates counters, and advances the page
cursor together. A failed transaction advances none of these. Repeated page
commits do not repeat counters. Candidate identity is
`(provider, provider_repository_id)`. Renames update descriptive metadata;
rejected and discarded review states are preserved. GitHub's license summary
is source metadata only and never sets `verified_open_source`.

The migration adds checkpoint and lease fields to `discovery_queries`, search
metadata and review state to `repository_candidates`, compact `source_metadata`
to `source_records`, and the `repository_candidate_sources` provenance join.
Atomic queue functions are callable only by `service_role`; operational tables
remain unavailable to browser roles under RLS and grants. Successful discovery
creates no `projects` or `repositories` rows. Candidate review, normalization,
license verification, classification, enrichment, logos, and publication are
subsequent milestones.

Queue implementation references: [PostgreSQL row locking and `SKIP LOCKED`](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE),
[Supabase database function security](https://supabase.com/docs/guides/database/functions#secure-a-database-function),
and [GitHub Search API limits](https://docs.github.com/en/rest/search/search?apiVersion=2022-11-28).

## Planned enrichment

The later enrichment process is a separate Bun worker with explicit source
adapters. M1-02 only discovers and queues candidates. Later milestones may:

1. Fetch repository metadata from approved source APIs with rate-limit handling.
2. Normalize source records into the catalog model and validate them with Zod.
3. Store permissible response payloads and reuse context in private
   `source_records`; use Storage only for approved, validated project logos.
4. Upsert normalized repositories, languages, source topics, releases, and
   project data into PostgreSQL.
5. Record metric snapshots by repository and date, job counters, item results,
   attempts, retry times, and provenance.
6. Keep discovered `repository_candidates` separate from curated projects.
   Publication requires verified quality, an explicitly verified
   open-source license, an available primary repository, and at least one
   category.

Later runs should be idempotent and observable, and invalid records should not
replace valid catalog data. M1-02 does not normalize candidates, verify their
licenses, or publish a listing.

## Database workflow

SQL migrations under `supabase/migrations/` will define the schema and remain
the schema source of truth. Local development uses the project-pinned Supabase
CLI through Bun:

```bash
bun run supabase start
bun run supabase migration new <name>
bun run supabase db reset
bun run supabase stop
```

`db reset` is a destructive reset of the local database. Migrations under
`supabase/migrations/` are the single schema source of truth; the category seed
uses an upsert and can be re-applied without adding duplicate rows. The
illustrative `src/data/projects.json` and `src/data/categories.json` remain in
place for demo compatibility; no sample project is imported into production
tables.

Run `bun run supabase:db-test` for pgTAP authorization, integrity, transaction,
checkpoint, incompatible-registration, retry, lease fencing, and RLS tests. CI
also runs `bun run test:discovery-db` against disposable local Supabase. It
exercises real PostgreSQL/PostgREST claims and page commits, and runs the actual
discovery CLI orchestration against deterministic mocked GitHub Search HTTP
responses. The fixtures cover resume, execution-budget changes, overlapping
IDs and renames, saturation and date splitting, retry persistence, and the
absence of canonical writes. These HTTP fixtures do not constitute a successful
live GitHub crawl or hosted Supabase verification. Run
`bun run supabase:db-lint` for local database linting, and
`bun run supabase:types` to regenerate `src/lib/supabase/database.types.ts`
from the local database. CI starts the pinned local Supabase stack on GitHub
Actions, resets it from migrations, repeats the category seed, executes tests
and lint, and compares the generated types with the committed file. The
Supabase CLI can run these operations without hosted credentials.

Public and authenticated clients can read published catalog data and safe
relationships only. Source records, candidate queues, job history,
submissions, review queue entries, editorial overrides, and administrator
allowlisting have no client grants or read policies. Direct submission writes
are disabled pending a validated server endpoint. Administrator authentication
and the bounded candidate-discovery worker are implemented; enrichment and
database-backed UI belong to later milestones.

Logo files use a public `project-logos` bucket with a 2 MiB limit and PNG,
JPEG, and WebP MIME restrictions. Public bucket downloads bypass object RLS,
therefore future ingestion must decode and validate the image, strip metadata,
reject active content and SVG, assign an opaque project-owned path, and upload
only after editorial approval. Record safe attribution on the approved logo
metadata. Revocation must remove the object through the Storage API; deleting
only its Postgres metadata does not delete the stored object.

Recurring scheduling, source credential provisioning, logo downloading,
remote migration deployment, publication workflows, search RPC, and public UI
integration are outside M1-02.
