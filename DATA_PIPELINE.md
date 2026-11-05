# Data pipeline

## Current behavior

The current catalog is the checked-in `src/data/projects.json` sample set. It
contains 33 illustrative project records and is validated by
`bun run validate:data` and Vitest. The UI searches and sorts this data in the
browser. Submission, moderation, and sync actions are local demo behavior.

The M0-02 production schema is present, but it starts with no project listings.
The only seeded rows are the 11 category taxonomy records. M1-01 adds a
read-only GitHub REST API adapter and a one-repository inspection CLI. There is
still no repository discovery, scheduled job, project catalog write, or
operational ingestion pipeline.

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
per-page provenance.

Rate-limit metadata includes `x-ratelimit-limit`, `x-ratelimit-remaining`,
`x-ratelimit-reset`, `x-ratelimit-resource`, and `Retry-After`. The client
distinguishes primary limits from secondary limits when response headers or
the GitHub error message allow it. It respects reset/Retry-After instructions;
when the requested wait exceeds the configurable maximum (30 seconds by
default), it returns a structured `rate_limit` error and retry delay. Network,
timeout, and 5xx failures use at most two retries by default, bounded jittered
backoff, a 15-second request timeout, and a 45-second total elapsed limit.
401, 404, 422, malformed JSON, unexpected content types, cancellation, and
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
network access or a token. The adapter currently retrieves one known
repository at a time; bulk discovery, candidate queues, normalization,
provenance persistence, metric snapshots, scheduled imports, license
verification, and publication remain later work.

Official references: [repository endpoints](https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28),
[release endpoints](https://docs.github.com/en/rest/releases/releases?apiVersion=2022-11-28),
[license endpoints](https://docs.github.com/en/rest/licenses/licenses?apiVersion=2022-11-28),
[authentication](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api?apiVersion=2022-11-28),
[API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions?apiVersion=2022-11-28),
[pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api?apiVersion=2022-11-28),
[conditional requests](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api?apiVersion=2022-11-28),
and [rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2022-11-28).

## Planned ingestion

The later ingestion process is a scheduled Bun worker with explicit source
adapters. The schema is ready to hold the following records, but no worker
executes these steps yet:

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

Runs should be idempotent and observable, and invalid records should not replace
valid catalog data. The GitHub read adapter is implemented, but this workflow
will be designed and implemented in later milestones; none of its steps
currently runs against Supabase.

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

Run `bun run supabase:db-test` for pgTAP authorization and integrity tests,
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
is implemented; the ingestion worker and database-backed UI belong to later
milestones.

Logo files use a public `project-logos` bucket with a 2 MiB limit and PNG,
JPEG, and WebP MIME restrictions. Public bucket downloads bypass object RLS,
therefore future ingestion must decode and validate the image, strip metadata,
reject active content and SVG, assign an opaque project-owned path, and upload
only after editorial approval. Record safe attribution on the approved logo
metadata. Revocation must remove the object through the Storage API; deleting
only its Postgres metadata does not delete the stored object.

Scheduled execution, source credential provisioning, logo downloading, remote
migration deployment, publication workflows, search RPC, and public UI
integration are outside M1-01.
