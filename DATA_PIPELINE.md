# Data pipeline

## Current behavior

The current catalog is the checked-in `src/data/projects.json` sample set. It
contains 33 illustrative project records and is validated by
`bun run validate:data` and Vitest. The UI searches and sorts this data in the
browser. Submission, moderation, and sync actions are local demo behavior.

The production schema starts with no project listings. The only seeded rows
are the 11 category taxonomy records. M1-01 adds a read-only GitHub REST API
adapter. M1-02 adds a bounded repository discovery worker that writes private,
unreviewed candidates and durable page checkpoints. M1-03 enriches and
assesses eligible public repositories into unpublished drafts. M1-05 adds
reviewed logo candidates without changing publication, license, or quality
decisions.

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
M1-03 adds canonical normalization, bounded subresource persistence, and
daily metric snapshots. Scheduled imports, quality and license verification,
classification, and publication remain later work.

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
creates no `projects` or `repositories` rows. Candidate editorial review,
license verification, classification, logo ingestion, and publication remain
subsequent milestones; M1-03 handles source normalization and repository
enrichment without publication.

Queue implementation references: [PostgreSQL row locking and `SKIP LOCKED`](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE),
[Supabase database function security](https://supabase.com/docs/guides/database/functions#secure-a-database-function),
and [GitHub Search API limits](https://docs.github.com/en/rest/search/search?apiVersion=2022-11-28).

## M1-03 GitHub repository enrichment

Enrichment is a separate, serial Bun worker. It consumes candidates from the
existing discovery queue but has its own `enrichment_status`, attempts,
retry time, lease owner, expiry, and random fencing token. Discovery
partition claims and their page checkpoints are unchanged. Only GitHub
candidates with a valid numeric provider ID, an eligible discovery queue
status (`queued` or `retry_wait`), no `discarded` queue status, and a review
status other than `rejected` may be claimed. Due `retry_wait` and expired
`processing` claims can be recovered;
discarded and rejected candidates are never reactivated. Attempts are
bounded, and exhausted or validation-failed records become terminal for
investigation.

The worker fetches the full repository by stable numeric ID with
`getRepositoryById`, then requests languages, topics, and one bounded page of
recent releases. It validates adapter records with the existing GitHub Zod
schemas and normalizes them in `src/lib/enrichment/normalize.ts`. The
repository row is keyed by `(provider, provider_repository_id)` and stores
the current owner/name, canonical URL, source counts and state, provider
timestamps, source license evidence, field-presence states, and source
observation time. Null, absent, and present fields remain distinguishable.
An older observation cannot replace fresher canonical metadata, and
`project_id` plus editorial associations are preserved. A 404 is recorded as
unavailable to that request; it does not prove deletion or privacy. Explicit
private or non-public visibility is handled separately below.

Languages store byte counts and normalized keys; topics preserve source
spelling while deduplicating by case-insensitive normalized key. Membership
is replaced only after a complete, validated response, including a valid
empty response. Releases upsert by GitHub release ID. The default is at most
20 recent releases, with a CLI limit up to 100; older releases outside the
window are not deleted. Failures from languages, topics, or releases are
recorded explicitly: validated repository metadata and available complete
subresources can commit, while failed subresources remain untouched and
schedule a bounded retry (or a terminal failure for permanent errors).
Repository metadata by stable ID is mandatory for any successful canonical
upsert. Only explicitly public responses are eligible: `private: true`, an
explicit visibility other than `public`, or contradictory private/public
signals terminate the candidate before language, topic, or release requests.
The outcome stores only a safe visibility classification and request
provenance. It never stores response content or creates a canonical row. If a
canonical repository already exists, the current lease may mark its
availability `access_restricted`; the repository ID, project association, and
previously validated public observations remain intact. A later public
observation can restore `available`. An ambiguous 404 still means only that the
request could not access the repository and is not treated as proof of
deletion or privacy.

GitHub homepage values are user-controlled. Enrichment accepts only absolute,
well-formed HTTP or HTTPS URLs without credentials or control characters,
stores the URL parser's normalized form, and never fetches the URL. Values with
other schemes, missing schemes, malformed syntax, or embedded credentials are
omitted from `homepage_url`; safe source-field state records them as
`rejected`, distinct from absent or null values. Other valid repository
metadata continues through enrichment. A previously accepted homepage may be
retained when a newer value is rejected. A database URL validator and
canonical write guard enforce the same persistence boundary for direct
service-role RPC calls.

Each successful or partial commit is one restricted PostgreSQL transaction.
It verifies the live claim and fencing token, rechecks candidate eligibility,
upserts the repository and provenance, applies complete language/topic
observations, upserts bounded releases, records the daily snapshot, links the
candidate, and updates item/job counters. A transaction failure commits none
of these effects. The service-role-only claim, commit, fail, and job RPCs use
row locks and `SKIP LOCKED`; expired leases get a new fencing token so a late
GitHub response cannot write. Retries persist a delay and safe error summary.
GitHub rate-limit and `Retry-After` guidance is honored by the adapter; retry
work is scheduled in PostgreSQL rather than polled in a tight loop.

Snapshots are actual observations only. The snapshot date is derived from
the repository response capture time (UTC); one row is kept per repository
per day. A same-day observation replaces counts only when its capture time is
newer. Repeated runs do not create duplicate daily snapshots or fabricate
history.

`source_records` stores compact provider/resource kind, API URL, fetch time,
HTTP status, ETag, API version, safe reuse metadata, candidate, and canonical
repository relationships. It stores no credentials, arbitrary headers, or
unbounded response body. Conditional requests are currently disabled for
enrichment: every fetched resource must be a complete, validated response
before replacing membership data. ETags are retained as provenance but marked
non-reusable; a 304 is never treated as an empty response. GitHub's detected
license stays source evidence and never changes `projects.license_status`.

The worker creates or updates only `repositories`, languages, topics,
releases, snapshots, provenance, candidates, and ingestion job/item state.
It never creates or publishes `projects`. Discovered candidates are source
leads; enriched repositories are normalized source records; published
projects remain editorially controlled records for a later milestone.

The default command is a no-write dry run. Bounded execution requires
`--execute` and server-only Supabase credentials; an optional server-side
`GITHUB_TOKEN` supplies GitHub authentication:

```bash
GITHUB_TOKEN=... bun run enrich -- --dry-run
GITHUB_TOKEN=... bun run enrich -- --execute --max-candidates 5 --max-releases 20
GITHUB_TOKEN=... bun run enrich -- --execute --resume --max-candidates 5
```

Execution is serial with a 900-second lease, at most 100 candidates and 100
releases per invocation. `--resume` resumes a running ingestion job. Output
summarizes claims, successes, retries, failures, and skips without printing
credentials or raw responses. The CLI is separate from `discover` and has no
public HTTP endpoint. It reports partial source failures as operational
failures while retaining validated data and persisted retry state.

The `20261105120000_repository_enrichment.sql` migration adds queue state and
narrow service-role mutation functions. CI runs pgTAP and
`bun run test:enrichment-db`, which executes the real worker orchestration
against local Supabase/PostgreSQL with deterministic mocked GitHub HTTP
responses, then inspects persisted rows. A live GitHub call is optional and
is not part of normal CI. The schema migration remains the source of truth;
CI generates and compares `database.types.ts` from the migrated database.

## M1-04 Repository assessment and project drafts

The standalone `scripts/assess.ts` worker processes repositories that have a
successful M1-03 enrichment, current valid GitHub identity, `available`
availability, explicit public visibility, no disabled state, and no associated
rejected or discarded candidate. It also requires successful provenance for
the repository, languages, topics, and bounded releases resources. Partial
enrichment is intentionally not assessed: it stays in the enrichment retry or
terminal review state until a complete enrichment succeeds. Missing, absent,
null, unsupported, and unavailable field states remain distinct; none is
reinterpreted as a complete observation. Discovery checkpoints and enrichment
leases are not touched by assessment.

### Classification policy

`src/lib/assessment/classify.ts` uses the version `outlist-category-rules-v1`.
It applies explicit topic and phrase rules to the repository name, usable
description, and GitHub topics, resolving category IDs only against the active
seeded taxonomy. Each suggestion stores the evidence value, field, mapping
rule, explanation, score, and bounded confidence. Close conflicting signals
and weak evidence do not select a primary category. Languages and their byte
shares are retained as context but never classify by themselves. No category
outside the existing eleven is emitted, and no description or product claim is
generated.

### License evidence

`src/lib/assessment/data/spdx-licenses-3.29.0.json` is the pinned SPDX License
List 3.29.0 summary snapshot, including the SPDX `isOsiApproved` classification
and deprecated-ID marker. The worker reads M1-03's validated repository
license metadata and links it to the source observation; it does not download
license files or clone repositories. Outcomes distinguish recognized OSI
licenses, recognized IDs without OSI approval, missing, `NOASSERTION`, unknown
IDs, compound expressions, conflicting observations, and unavailable evidence.
GitHub detection does not verify repository terms. OSI approval does not
convert a project to `verified_open_source`; assessment can only set
`unknown`, `unverified`, or `needs_review`. A missing detection is not treated
as proprietary. Compound expressions, custom licenses, exceptions, and
conflicts need human review.

GitHub's REST license endpoint can return the detected repository license file.
M1-04 does not call it because repository-level license metadata is already
available and fetching the file adds no required evidence for this conservative
classification step. GitHub documents that it attempts identification with
Licensee and that its information is provided as-is. See the [GitHub license
API notes](https://docs.github.com/en/rest/licenses/licenses?apiVersion=2022-11-28),
the [SPDX License List](https://spdx.org/licenses/), and the [OSI approved
licenses list](https://opensource.org/licenses).

### Quality signals and drafts

`src/lib/assessment/quality.ts` uses `outlist-source-quality-v1` and emits
structured flags with evidence references and explanations for archived or
forked repositories, missing descriptions, no observed releases, incomplete
enrichment, stale or missing timestamps, license uncertainty, and failed
public-access/identity checks. Archive and fork are review signals; lack of
stars, youth, and low activity do not imply poor quality. This is source-based
screening, not a security audit or software-quality certification.

Assessment state is stored in the private `repository_assessments` table and
normalized `repository_assessment_sources` references. The row is keyed by
canonical repository and assessment policy, with a source-observation revision
so a newer successful enrichment can trigger a fresh assessment. Repeating
the same source observation is idempotent. Database claims use
`FOR UPDATE SKIP LOCKED`, worker IDs, expiring leases, and fencing tokens;
failures use bounded retries and persisted next-attempt times. An expired
final attempt moves to `needs_review`.

`complete_github_repository_assessment` rechecks public eligibility and
candidate editorial state inside one PostgreSQL transaction. It stores source
references and result evidence, and if the evidence supports a primary active
category, creates a deterministic `github-<repository-id>` slug project,
associates the repository as primary, adds only supported categories, and
opens/reuses an editorial review item. A repository rename keeps the stable
numeric ID and project slug. The source repository name and usable description
are copied as-is; missing descriptions and summaries stay empty. Existing
project associations are never reset to draft and their names, descriptions,
categories, overrides, license choices, and visibility are not overwritten.
Insufficient classification or a slug collision creates a review item for the
repository without forcing project creation.

Assessment opens or reuses an `open` review item and can attach it to an
existing `in_review` item. It does not assign, resolve, dismiss, or approve an
item. Controlled editorial actions and review-queue lifecycle tooling remain
outside M1-04.

New drafts use `publication_status = pending_review`,
`quality_status = unreviewed` or `needs_review`, `license_status = unknown`,
`unverified`, or `needs_review`, `featured = false`, and `published_at = NULL`.
The database function cannot set publication, quality, or license approval
fields. Assessment is a server-only Bun command and has no HTTP endpoint.

```bash
bun run assess -- --dry-run
bun run assess -- --execute --max-repositories 5
bun run assess -- --execute --resume --max-repositories 5
```

Dry-run is the default and performs no database operations. Execution is serial
and limited to 100 repositories per invocation. It requires the server-only
Supabase URL and secret key. Output reports assessed, drafted, queued-for-review,
skipped, retried, and failed counts without source bodies or credentials.
`--resume` reuses a running assessment job; queued and retry-wait records remain
durable if the process stops. `bun run test:assessment-db` exercises the actual
CLI against disposable PostgreSQL/PostgREST, seeded by deterministic GitHub
HTTP fixtures. CI also runs assessment pgTAP tests, database lint, and generated
type parity checks without hosted Supabase or a GitHub token.

The stage boundaries are explicit: **discovered candidate ≠ enriched
repository ≠ assessed project draft ≠ published project**. Assessment does
not approve licenses, verify quality, apply editorial actions, fetch logos,
publish projects, or connect the public frontend to Supabase.

Official references: [repository endpoints](https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28),
[languages](https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28#list-repository-languages),
[topics](https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28#get-all-repository-topics),
[releases](https://docs.github.com/en/rest/releases/releases?apiVersion=2022-11-28),
[PostgreSQL row locks and `SKIP LOCKED`](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE),
and [Supabase database function security](https://supabase.com/docs/guides/database/functions#secure-a-database-function).

## M1-05 Logo candidates, approval, and fallback

`src/lib/logos/resolve.ts` is the reusable typed resolution policy. It uses an
approved official logo first (`official_site`, `editorial`, or reviewed
`submitted`), then an approved `provider_avatar`, then a deterministic
single-character fallback. The provider option is always labeled “GitHub owner
avatar”; GitHub's organization or user avatar is never presented as the
project's official product logo. Pending, rejected, revoked, cross-project, or
invalid-path rows are ignored. The fallback normalizes Unicode with NFKC and
uses the first letter or number, or `?` for an empty or symbol-only name. It
does not fetch or create a placeholder image.

### Discovery and provenance

`bun run logos -- --discover --dry-run` previews candidates. Database writes
require `--execute`, and each invocation is capped at 25 draft projects. The
worker reads the primary repository by its stable numeric GitHub ID and uses
only the validated `owner.avatar_url` field in the GitHub API response. It
excludes repositories that are private, restricted, disabled, or not explicitly
public. Accepted avatar URLs must use HTTPS on `avatars.githubusercontent.com`
with the numeric `/u/<owner-id>` path and an optional numeric `v` query.
Redirects and other hosts are rejected during download.

Discovery stores `origin = provider_avatar`, repository and owner identity,
source API URL, observation time, API version, source-record reference, and the
validated avatar URL. Candidate identity includes the repository ID and a
digest of that URL. Repeated observations reuse the candidate and open review
item. Discovery never downloads bytes or inserts into Storage. Official image
candidates can be registered with `--register-official --execute`, an HTTPS
source URL, and operator-provided attribution; this workflow only records the
source and does not fetch it. Those candidates remain pending until an operator
explicitly approves a local file.

### Approval and image trust boundary

The `project-logos` bucket is public. A direct object URL can be readable before
Postgres RLS would reveal its approval row. Therefore the only automated
download is inside `bun run logos -- --approve <id> --avatar-source`, after an
operator names a specific candidate. Official candidates use
`--approve <id> --local-file <path>` and never fetch their source URL.

Image bytes are capped at 2 MiB on input and read with connect, per-read, and
total timeouts. Automated fetching is limited to validated GitHub avatar URLs,
uses HTTPS, rejects credentials and redirects, and has a hard streaming size
limit. Sharp decodes actual PNG, JPEG, or WebP contents; file extensions and
`Content-Type` do not establish the format. SVG, HTML, malformed or truncated
files, animated images, dimensions above 4096 pixels, and decoded images above
16 million pixels are rejected. Accepted images are orientation-corrected,
resized within a 512 by 512 box, stripped of metadata, encoded as WebP, capped
at 1.8 MB, and SHA-256 digested. No arbitrary site crawler, README parser,
remote redirect follower, or general user-image downloader is present.

Approval first claims a candidate for ten minutes with a worker UUID and a
separate random database fencing token. The token is also the identity of one immutable object at
`<project-uuid>/<logo-uuid>/<approval-token>.webp`. The CLI uses
`upsert: false`; a retry or a second worker always gets a different path, and
approved objects are never overwritten. The approval RPC rechecks the candidate
identity, pending state, unexpired token, exact token-derived path, image
digest, media type, operator provenance, and current project/repository
eligibility. It records the winning path and SHA-256 digest together, selects a
primary logo, and resolves the review item atomically. Official approval keeps
priority over avatars and preserves an existing official primary. No review
action changes project publication, license, or quality status.

Database fencing alone cannot protect Storage: Storage writes happen outside a
PostgreSQL transaction, so a worker can finish uploading after its lease has
expired. Token-scoped object identity isolates that late upload from a later
winner. A private, service-role-only attempt ledger records every path at
claim time. Cleanup RPCs return only attempt paths that are not referenced by
an approved row; they never substitute a candidate's current path for a stale
worker's path. Failed removal remains discoverable for another reconciliation
pass. A worker that resumes after a prior cleanup can recreate only its own
orphan path, which the ledger can identify and remove later.

An ambiguous database response is accepted as recovered only if the approved
row contains that exact attempt path and digest and a Storage download hashes
to the same digest. Another attempt's approved row is never treated as proof of
success. Rejection and revocation clear the database pointer first, mark all
attempt paths for cleanup, and remove only those unreferenced paths. A stale
reconciliation cannot restore a revoked asset: it checks approval before
restoring, uses a no-overwrite upload, then checks approval and the downloaded
digest again before reporting success. Concurrent restorations converge on the
same immutable object; if an object already exists with different bytes,
reconciliation reports an integrity error and leaves it unchanged.

`--reconcile <id>` lists and removes orphan attempt objects for pending,
rejected, or revoked candidates. For approved candidates it first downloads and
hashes an existing object. It restores only an object confirmed missing, and
only when the reviewed source still normalizes to the recorded digest. Legacy
approved two-segment paths remain valid and are preserved through migration.
Legacy rows without a recorded digest continue resolving as before, but a
missing or mismatched legacy object needs manual review before restoration.

The bucket remains public. Supabase public-bucket downloads can bypass object
read policies, including before a database row is approved; opaque random
attempt paths reduce accidental discovery but are not access control. Browser
roles have no Storage write policies, and all upload/remove operations use the
trusted server client. The pipeline minimizes exposure by uploading only after
operator approval, never overwriting an object, and removing unreferenced
attempts as cleanup runs. A Storage outage can delay orphan removal, and a
paused stale process can upload its own orphan after cleanup; the durable ledger
keeps that path available for a later retry without affecting the approved
image.

```bash
bun run logos -- --discover --dry-run
bun run logos -- --discover --execute --max-projects 10
bun run logos -- --register-official --execute --project-id <uuid> --source-url https://example.org/logo.png --attribution "Official project mark"
bun run logos -- --approve <logo-id> --avatar-source
bun run logos -- --approve <logo-id> --local-file /path/to/reviewed-logo.png
bun run logos -- --reject <logo-id> --execute
bun run logos -- --revoke <logo-id> --execute
bun run logos -- --reconcile <logo-id>
```

The current public UI remains local demo data and does not query `project_logos`.
The resolver is ready for later UI integration; no browser approval API,
frontend redesign, recurring discovery, automatic publication, or user uploads
are included. GitHub observations and local Supabase Storage integration use
deterministic fixtures in CI and need no live GitHub or hosted Supabase account.

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
checkpoint, incompatible-registration, retry, lease fencing, and RLS tests.
CI also runs `bun run test:discovery-db`, `bun run test:enrichment-db`,
`bun run test:assessment-db`, and `bun run test:logos-db`
against disposable local Supabase. The discovery integration exercises the
discovery CLI and queue; the enrichment integration executes the real
enrichment CLI orchestration with deterministic mocked GitHub HTTP responses,
then verifies persisted canonical and related rows. The fixtures cover stable
IDs across renames, idempotency, complete subresources, bounded releases,
snapshots, provenance, retries, stale-worker fencing, protected candidates,
transaction rollback, RLS denial, and no project publication. These HTTP
fixtures do not constitute a successful live GitHub enrichment or hosted
Supabase verification. Run
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
and the bounded discovery, enrichment, assessment, logo-candidate, and unified
operator workflows are implemented; database-backed UI belongs to later
milestones.

Logo files use a public `project-logos` bucket with a 2 MiB limit and PNG,
JPEG, and WebP input MIME restrictions. M1-05 stores normalized WebP only after
an explicit trusted operator action, because direct bucket URLs can bypass
object-read policy checks. Revocation removes the object through the Storage
API; deleting metadata alone would not delete the object.

Recurring scheduling, remote migration deployment, publication workflows,
search RPC, and public UI integration remain outside these milestones.

## M1-06 end-to-end pilot and operational readiness

`bun run pipeline` is the bounded operator entry point for the existing
discovery, enrichment, assessment, and logo-candidate workers. It calls those
worker implementations directly and keeps their database jobs, partition
checkpoints, claims, retry schedules, and deduplication as the durable source
of truth. A run ID is attached to the existing jobs for reporting and
run-scoped read-only verification; it does not add a second queue.

The safe local sequence is:

```bash
bun run supabase start
eval "$(bun run supabase status --output env)"
export NEXT_PUBLIC_SUPABASE_URL="$API_URL"
export NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$ANON_KEY"
export SUPABASE_SECRET_KEY="$SERVICE_ROLE_KEY"
export OUTLIST_SUPABASE_ENVIRONMENT=local
bun run pipeline -- --status
bun run pipeline -- --audit
bun run pipeline -- --dry-run
bun run pipeline -- --execute --max-queries 1 --max-pages 1 --max-candidates 10
bun run pipeline -- --resume --execute --max-candidates 10
bun run pipeline -- --status
bun run pipeline -- --audit
```

Writes require `--execute`. Defaults are one query, one page, ten discovered
candidates, five enrichments, five assessments, and five logo projects, with
hard ceilings for every stage. Resume continues existing durable queue state.
Reports distinguish `execution_status` (whether workers finished), `data_status`
(eligible records committed in this invocation), and
`end_to_end_project_completed` (one complete validated lineage). Each stage
retains its counters and current-run persisted record IDs; resume also reports
reused record counts and IDs. A run may finish its workers and commit a
candidate while remaining partial because no complete project lineage exists.
An empty resume can still identify a validated reused lineage without claiming
new commits. A pending project draft remains distinct from a published listing.
Status uses aggregate SQL counts and does not start repository search. Audit
findings are structured by severity and record ID; the audit is read-only.

Inventory distinguishes discovered candidates, enrichment-ready candidates,
successful public repositories, partial and failed enrichments, assessments,
pending project drafts, drafts without active category evidence, review items,
logo states, letter fallbacks, published projects, failed/rate-limited jobs,
and last validated source observations. It labels the active GitHub adapter as
deterministic fixtures, live API, or not checked, and the inventory target as
local Supabase, hosted Supabase, or unclassified remote. The audit is
database-only and does not call GitHub. This describes the current invocation;
historical source provenance is retained on source records. A pending project
draft is not a published listing.

An opt-in live smoke run uses actual GitHub API GET requests and requires the
operator to explicitly request writes:

```bash
bun run pipeline -- --live-smoke --execute
```

It is capped at one discovery partition/page, ten candidates, five
enrichments, five assessments, and five logo projects. These are ceilings, not
minimums. The run does not call a GitHub write endpoint, approve a license,
verify quality, approve a logo, or publish a project. A service-only SQL
inspection returns one joined candidate, canonical repository, assessment,
draft, and pending-logo lineage with their IDs and evidence. It verifies
stable provider identity, public eligibility, validated source provenance,
review links, primary repository and category evidence, and the absence of
pipeline approvals. Stage rows from different repositories cannot combine into
success. Resume may reuse earlier validated rows and labels their stage
origins. Fixture-backed integration is always labeled as fixture data and
cannot satisfy `--live-smoke`.

The audit compares candidate and canonical repository provider plus stable
numeric provider ID, so a historical candidate name remains valid after a
canonical rename. It flags ID association conflicts as critical. Published
projects are not called unauthorized merely because assessment originally
created them; the audit flags only objectively invalid published states that
contradict database publication constraints.

Rate-limited work is persisted by the existing workers. The report includes
the safe API reason and matches the retry schedule to the failed partition or
candidate, including its actual next eligible time. A failed stage stops later
stages but keeps earlier committed work and checkpoints. Run `--status` before
resuming and confirm the previous worker has stopped and no active lease
remains.

### Local fixture verification

The complete local integration invokes the real orchestrator and all four
workers through PostgREST/PostgreSQL, using deterministic mocked GitHub HTTP
responses. It covers one complete linked lineage, unrelated stage-record
rejection, discovery-only progress, reused records on resume, idempotency,
rejected/private candidates, partial enrichment, missing classification and
logo evidence, rate limits, checkpoint preservation after stage failure,
rename and provider-ID audit behavior, editorial publication, review
relationships, inventory, read-only audit, and privileged RPC/RLS restrictions:

```bash
eval "$(bun run supabase status --output env)"
NEXT_PUBLIC_SUPABASE_URL="$API_URL" \
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$ANON_KEY" \
SUPABASE_SECRET_KEY="$SERVICE_ROLE_KEY" \
OUTLIST_SUPABASE_ENVIRONMENT=local bun run test:pipeline-db
```

This validates local migrations and worker behavior without external network
or a GitHub token. It is not evidence of actual GitHub API access or hosted
Supabase readiness. The read-only live-smoke verification path is covered by
the service-role SQL contract and the same fixture-backed row inspection, but
CI never labels the fixture responses as live.

### Hosted readiness and approval boundary

Hosted setup is an operator-controlled deployment. No runbook step is
automatically performed by `pipeline`, and the command never links, resets,
migrates, or writes to a hosted database during preflight. Use the normal
Supabase migration history in ascending order, make a restorable backup, and
compare `supabase migration list --remote="$PROJECT_REF"` with the local
migration files before any approved `supabase db push --remote="$PROJECT_REF"
--skip-vault`. Review the M1-06 schema report after migration with `--status`
and `--audit` before approving a small hosted ingestion run.

Configure the URL, publishable key, service key, environment label, and
optional GitHub token in server-side operator secrets. Never use a `NEXT_PUBLIC_`
secret. Public repository discovery needs only read access; use the narrowest
GitHub token that provides the intended public metadata/search budget, with no
GitHub write permission. Verify the `project-logos` bucket remains public with
the 2 MiB limit and PNG/JPEG/WebP MIME types; the pilot only registers pending
candidates and does not upload image bytes.

Remote writes are blocked unless an operator passes both
`--allow-hosted-writes` and `--confirm-project-ref <ref>` for the URL-derived
Supabase project reference. Custom remote hosts that do not expose a
verifiable reference are blocked. This explicit CLI guard does not replace
separate operator approval for any hosted migration or production write.
Fixture validation, live GitHub reads, and hosted Supabase verification are
three different checks and must be reported separately.
