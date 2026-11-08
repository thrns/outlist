# Outlist

Outlist is an open-source discovery directory built as a Next.js 16 modular
monolith. Its public catalog routes read published projects from Supabase;
authenticated editorial tools review and publish catalog records. Bun is the
package manager and runtime.

## Requirements

- Bun **1.3.14** (pinned by `.bun-version` and `package.json`)
- A supported operating system for Next.js
- Docker-compatible container runtime only when starting the local Supabase stack
- Chromium browser installation when running the real Auth browser integration suite

## Quick start

```bash
bun install --frozen-lockfile
bun run dev
```

Public catalog routes require `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. To use local Supabase, start and seed
the database, copy the local API URL and anon key from `bun run supabase status`
into `.env.local`, then start the app:

```bash
bun run supabase start
bun run supabase db reset
bun run supabase status
bun run dev
```

Open [http://localhost:3000](http://localhost:3000). If the public database is
unconfigured or unavailable, catalog pages show an explicit error state and
never fall back to sample projects.

## Commands

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start the Next.js development server using Bun |
| `bun run build` | Create the production build using Bun |
| `bun run start` | Run the production server using Bun |
| `bun run typecheck` | Run the strict TypeScript check |
| `bun run lint` | Run ESLint with the Next.js rules |
| `bun run test` | Run Vitest tests |
| `bun run test:auth-e2e` | Verify real local Supabase OTP authentication in production Chromium |
| `bun run test:discovery-db` | Exercise the discovery queue against disposable local Supabase |
| `bun run test:enrichment-db` | Exercise real enrichment orchestration and persisted rows against local Supabase |
| `bun run test:assessment-db` | Exercise real assessment and draft transactions against local Supabase |
| `bun run test:logos-db` | Exercise real logo discovery, approval, and public Storage against local Supabase |
| `bun run test:editorial-db` | Exercise real authenticated editorial decisions and publication against local Supabase |
| `bun run test:public-search-db` | Verify anonymous search, filters, sorts, pagination, logo selection, RLS, and indexed query plans against local Supabase |
| `bun run test:public-frontend-e2e` | Verify live public routes, catalog filters, URL state, logos, safety demotion, and browser behavior with local Supabase and Chromium |
| `bun run test:pipeline-db` | Run the complete bounded pipeline against local Supabase with deterministic GitHub HTTP fixtures |
| `bun run github:inspect -- owner/repo` | Inspect one public GitHub repository (optional `GITHUB_TOKEN`) |
| `bun run github:smoke -- owner/repo` | Explicitly marked live GitHub smoke check |
| `bun run discover -- --plan initial --dry-run` | Print the bounded GitHub discovery plan without database writes |
| `bun run discover -- --plan initial --execute --max-queries 2 --max-pages 2 --max-candidates 200` | Run a bounded queue collection with server credentials |
| `bun run enrich -- --dry-run` | Preview enrichment eligibility and limits without database writes |
| `bun run enrich -- --execute --max-candidates 5 --max-releases 20` | Enrich up to five candidates with server credentials |
| `bun run enrich -- --execute --resume --max-candidates 5` | Resume a running enrichment job |
| `bun run assess -- --dry-run` | Preview assessment eligibility without database writes |
| `bun run assess -- --execute --max-repositories 5` | Assess up to five eligible repositories |
| `bun run assess -- --execute --resume --max-repositories 5` | Resume durable assessment work |
| `bun run logos -- --discover --dry-run` | Preview bounded GitHub avatar candidates without database writes |
| `bun run logos -- --discover --execute --max-projects 10` | Register pending avatar candidates and review items |
| `bun run pipeline -- --dry-run` | Preflight and preview all four ingestion stages without database writes |
| `bun run pipeline -- --execute --max-queries 1 --max-pages 1 --max-candidates 10` | Run the bounded local end-to-end pilot |
| `bun run pipeline -- --resume --execute --max-candidates 10` | Safely resume existing durable stage queues and discovery checkpoints |
| `bun run pipeline -- --status` | Read actual database inventory, checkpoints, leases, and GitHub rate budget without a crawl |
| `bun run pipeline -- --audit` | Read-only structured data-integrity findings |
| `bun run pipeline -- --live-smoke --execute` | Opt into a live GitHub smoke test, capped at one search page and five enrichment, assessment, and logo-project checks |
| `bun run logos -- --register-official --execute --project-id <uuid> --source-url <https-url> --attribution <text>` | Register an operator-supplied official logo candidate |
| `bun run logos -- --approve <logo-id> --avatar-source` | Validate and approve a pending GitHub avatar candidate |
| `bun run logos -- --approve <logo-id> --local-file <path>` | Validate and approve an official candidate from a local operator file |
| `bun run logos -- --reject <logo-id> --execute` | Reject a pending candidate |
| `bun run logos -- --revoke <logo-id> --execute` | Revoke an approved logo and remove its object |
| `bun run logos -- --reconcile <logo-id>` | Remove a pending orphan or restore an approved object from its reviewed source |
| `bun run validate:data` | Check sample-data integrity |
| `bun run check` | Run typecheck, lint, tests, data validation, and build |
| `bun run supabase <command>` | Run the project-pinned Supabase CLI |
| `bun run supabase:db-test` | Run the database pgTAP suite against local Supabase |
| `bun run supabase:db-lint` | Lint local database functions and schema |
| `bun run supabase:types` | Generate TypeScript types from the local database |

`bun.lock` is the committed dependency lockfile. Do not commit other package
manager lockfiles.

## Public routes and remaining unavailable features

- `/` — Home with genuine recent and most-starred projects and active categories
- `/explore` — Search, category/license/language filters, sorting, pagination
- `/categories` and `/category/[slug]` — Active database categories, visible project counts, and filtered listings
- `/project/[slug]` — Published project details and related published projects
- `/alternatives` — Coming soon until approved public relationships can be queried
- `/submit` — Unavailable until persistent submission moderation is implemented
- `/admin/login` — Invite-only administrator email OTP sign-in
- `/admin` — Protected, paginated Supabase-backed editorial review queue
- `/admin/projects/[id]` — Private source evidence, assessments, editorial corrections, decisions, and publishing

All listed public catalog routes use published Supabase records under public
RLS. Search and filters are database-paginated and encoded in the URL; there is
no JSON catalog fallback. Trending scores, public alternatives, and persistent
public submissions are unavailable. The admin review queue is separate: it
reads actual database drafts and private evidence on the server, and its
actions write through service-role-only PostgreSQL functions after a fresh
administrator allowlist check. Assessment creates pending-review drafts but
never verifies a license or quality. See
[ADMIN_AUTH.md](ADMIN_AUTH.md) for OTP setup and administrator provisioning,
and [DATA_PIPELINE.md](DATA_PIPELINE.md) for editorial evidence and publication
policy.

The pipeline stages are distinct: **discovered candidate ≠ enriched
repository ≠ assessed project draft ≠ published project**.

## Public catalog search (M1-08)

The `public.search_public_projects` PostgreSQL RPC and server-only library in
[`src/lib/catalog/public.ts`](src/lib/catalog/public.ts) read real published
records through the publishable Supabase key and public RLS. They never use the
service-role credential. Available functions are `searchPublicProjects`,
`getPublicProjectBySlug`, and `getPublicCategories`. Query failures are surfaced
as typed errors; the library does not fall back to JSON when Supabase is
configured but unavailable. An empty catalog returns an empty page with a zero
total count.

`searchPublicProjects` accepts `query`, `categories` (category slugs),
`licenses` (verified identifiers), `languages` (primary language names),
`sort`, `page`, and `pageSize`. Text is optional; non-empty queries must be 3 to
120 characters and contain at most eight whitespace-separated terms. Each
filter group accepts up to 20 values. Pages are one-based, capped at 1,000,
with a page size from 1 to 50. Oversized and malformed arguments fail with a
validation error rather than expanding an unbounded query.

Selected values use OR within a category, license, or language group; separate
groups combine with AND, and all selected groups combine with the text query.
Search uses the stored English `tsvector` with its existing GIN index and the
existing trigram indexes for partial or misspelled names and summaries. Exact
and prefix name matches rank above partial name matches, which rank above
summary and description matches. Query words are combined with AND semantics.

Supported sorts are `relevance`, `stars`, `updated`, `newest`, and `name`. Every
sort has a project UUID tie-breaker. Relevance without a text query falls back
to publication date. Pagination and exact total counts run in PostgreSQL; page
membership is stable for unchanged records. Inserts or updates between page
requests can change offset-based page membership. There is no trending sort:
the snapshot table can store history, but the available repository history has
not established a defensible trending window.

Each result includes a bounded description excerpt, primary and full category
identity, tags, primary repository identity and metrics, verified license ID,
publication and activity times, and fallback initials/seed. Only approved
logos with project-scoped Storage paths are eligible. Approved official,
editorial, and submitted logos are preferred before approved owner avatars;
avatars retain an explicit avatar type and attribution. Pending, rejected, and
revoked assets are omitted, and records without an approved asset include
deterministic letter-fallback metadata.

At 1,003 local project rows, PostgreSQL chooses sequential scans for full-text
and partial-name probes and naturally uses the selective license and language
indexes. Separate indexed plan probes confirm available GIN and trigram paths.
This verifies index eligibility on local data; hosted latency and larger
production distributions have not been measured.

Public RLS exposes only published projects with verified quality and license
and a current available primary GitHub repository whose source state explicitly
says public, non-private, and non-disabled. Search and detail results also
require an active category. Private source-state columns, provenance payloads,
candidates, reviewer identities, admin rows, and editorial audit rows remain
unavailable to public roles.
Authenticated users have the same read-only catalog access as anonymous users.

The local database integration creates and removes 1,003 temporary projects
and checks anonymous RPC access and direct RLS boundaries. M1-09 connects the
public routes to this access library and adds a local Supabase plus Playwright
browser suite to CI.

## Supabase local development

The CLI is a locked project dependency. Starting the local stack requires a
Docker-compatible runtime and downloads the Supabase service images the first
time. No hosted project or production credentials are needed.

```bash
bun run supabase start
bun run supabase status
bun run supabase stop
```

The local stack configuration is in `supabase/config.toml`. SQL migrations in
`supabase/migrations/` are the single source of truth for the production
schema. Use `bun run supabase migration new <name>` to create a migration, then
apply and verify it locally:

```bash
bun run supabase db reset
bun run supabase:db-test
bun run supabase:db-lint
bun run supabase:types
```

`db reset` destroys and recreates the local database from migrations. Do not
link a hosted project or use a remote migration command for local setup.

The schema contains normalized projects, provider repositories, categories,
tags, source provenance, releases, daily repository snapshots, languages,
topics, project logos and alternatives, discovery queries, candidates, job
history, submissions, moderation, editorial overrides, and an administrator
allowlist. It seeds 11 categories and no sample projects. RLS and explicit
grants expose only published catalog information to anonymous and ordinary
authenticated users. Those roles cannot read discovery state or write
projects, submissions, or logo objects. The discovery and enrichment CLIs use
service-only transactional database functions; the dashboard does not write
to these tables. Enrichment commits repository metadata and its validated
relationships atomically. Incomplete language, topic, or release fetches
preserve prior membership and schedule a retry; source ETags are recorded but
not reused for conditional requests. Daily snapshots reflect actual capture
time and update only when the new same-day observation is later.

The `initial` plan has ten topic and language partitions, each bounded by star
bands and creation dates. It is a bounded sample, not an exhaustive GitHub
crawl. GitHub Search allows at most 1,000 results per query and uses a separate
rate-limit resource. The worker checkpoints each committed page, deduplicates
by stable GitHub repository ID, stores page provenance, and fences stale workers with expiring
leases. Saturated or incomplete queries are split into safe date ranges or
left in a review state. Candidates remain distinct from canonical projects
and repositories. See [Data pipeline](DATA_PIPELINE.md) for partition and
recovery details.

Assessment is a separate private worker. It requires current, explicitly
public canonical metadata and successful enrichment of repository, languages,
topics, and bounded releases. Partial enrichment remains in retry/review state
and is not silently assessed. Classification uses deterministic, versioned
mappings over the seeded 11-category taxonomy; it does not use language alone
or generate descriptions. License outcomes use the pinned SPDX 3.29.0 list and
preserve GitHub detection as unverified source evidence. The worker records
quality flags and creates source-backed drafts in one PostgreSQL transaction,
with a linked editorial review item. Drafts remain `pending_review`,
unfeatured, and unpublished. See [Data pipeline](DATA_PIPELINE.md) for rules,
evidence, retries, and CLI details.

Logo resolution prefers an approved official project logo, then an approved
GitHub owner avatar explicitly labeled as an avatar, then a deterministic
single-character fallback. Pending, rejected, and revoked assets never resolve
as images. GitHub discovery reads only the repository owner's avatar URL from
the stable-ID GitHub API response and creates a pending review item; it does not
crawl homepages or README images. Official candidates are registered with
operator attribution and remain pending until an explicit approval command.

The `project-logos` bucket is public and capped at 2 MiB. Direct object URLs can
be readable before a metadata row is approved, so discovery never uploads
candidate bytes. Explicit approval decodes only PNG/JPEG/WebP, enforces input
and pixel limits, strips metadata, normalizes to WebP, and uploads without
overwrite to `<project-uuid>/<logo-uuid>/<approval-token>.webp`. Database
fencing cannot stop a Storage write after a lease expires; unique token paths
ensure a stale upload cannot replace the next worker's image. The winning path
and SHA-256 digest are committed together, and a private attempt ledger supports
safe orphan cleanup. Reconciliation verifies downloaded bytes, restores only a
confirmed missing object, and refuses digest mismatches. Legacy approved paths
remain valid; old records without digests require manual review before a
missing object can be restored. Public bucket URLs are not access control, and
random attempt paths are not confidential. See [Data pipeline](DATA_PIPELINE.md)
for recovery and exposure details. M1-05 kept the existing letter fallback;
M1-09 now renders approved stored logos within the current design.

### M1-06 operator runbook

Start a disposable local Supabase stack and load its keys into the current
shell. Keep the service key server-side and do not paste the CLI status output
into tickets or logs.

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

`--execute` is required for database writes. The default is dry-run. Status
reads aggregate counts, active leases, retry schedules, and source observations;
it does not run repository search. The audit returns structured findings with
severity and record IDs and never repairs rows. Discovery, enrichment,
assessment, and logo candidates use their existing jobs, claims, checkpoints,
retry state, and deduplication. Project drafts remain `pending_review`; license
and quality decisions remain unverified; logos remain pending; nothing is
published.

The fixture integration is repeatable without GitHub credentials:

```bash
eval "$(bun run supabase status --output env)"
NEXT_PUBLIC_SUPABASE_URL="$API_URL" \
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$ANON_KEY" \
SUPABASE_SECRET_KEY="$SERVICE_ROLE_KEY" \
OUTLIST_SUPABASE_ENVIRONMENT=local bun run test:pipeline-db
```

This test calls the real workers against local PostgREST/PostgreSQL and
deterministic mocked GitHub HTTP responses. It proves local schema and workflow
behavior; it is not a live GitHub crawl or hosted database verification.

Pipeline reports separate stages executed from eligible records committed in
this invocation. On `--resume`, `reused_record_count` and
`reused_record_ids` identify earlier durable records used by a validated
chain. `end_to_end_project_completed` requires one coherent candidate →
repository → assessment → pending draft → pending logo chain with matching
stable GitHub repository IDs and valid provenance/review links. A run can
finish its workers and commit candidates while reporting no completed project.
An empty resume can still identify a validated reused chain. A pending draft
is not a published listing; this pipeline performs no publication, license or
quality verification, or logo approval.

The integrity audit compares provider and stable numeric repository ID, so a
candidate's historical name survives a repository rename without a false
critical finding. It keeps critical findings for actual candidate/repository ID
conflicts and reports objectively invalid published states without inferring
that a constraint-valid editorial publication was unauthorized.

To opt into actual public GitHub API reads, use the deliberately small smoke
budget:

```bash
bun run pipeline -- --live-smoke --execute
```

Set a server-only `GITHUB_TOKEN` for the authenticated API budget when needed.
Live smoke output labels GitHub access and Supabase commits separately, then
uses a service-only read endpoint to verify one joined stable-ID lineage and
return its candidate, repository, assessment, project, and logo IDs with
evidence. Valid records from different repositories cannot combine into
success. Fixture responses cannot be reported as live smoke output.

#### Hosted Supabase change control

Hosted migration and ingestion steps below are operator-run procedures. M1-06
does not link, reset, migrate, or write to a hosted project automatically.
Confirm the intended project reference and environment with the project owner,
obtain explicit approval for the hosted operation, and keep production
credentials in a server-side secret manager. Do not place `SUPABASE_SECRET_KEY`
or `GITHUB_TOKEN` in any `NEXT_PUBLIC_` variable.

1. Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
   `SUPABASE_SECRET_KEY`, `GITHUB_TOKEN` (optional), and
   `OUTLIST_SUPABASE_ENVIRONMENT=staging` or `production` in the operator's
   server environment. Confirm the URL-derived project reference independently.
2. Review the ascending migration chain in `supabase/migrations/`, beginning
   with the catalog schema and category seed, followed by discovery,
   enrichment/source safety, assessment, logos, immutable logo assets,
   `20261107130000_m1_06_pipeline_operations.sql`, and
   `20261107140000_m1_06_lineage_integrity_correction.sql`. Run a schema-only read first
   with `bun run supabase migration list --remote="$PROJECT_REF"` and compare
   the remote history with the local files.
3. Take a named, restorable Supabase dashboard backup/PITR restore point. For
   an additional operator-held SQL backup, use the pinned CLI and protect the
   output file:

   ```bash
   umask 077
   bun run supabase db dump --remote="$PROJECT_REF" --schema public,private \
     --file "$BACKUP_DIR/outlist-before-m1-06.sql"
   ```

   Keep database dumps out of the repository and verify the backup can be
   retained and restored under the organization's normal process.
4. After the migration operation itself is explicitly approved, deploy through
   the standard Supabase migration workflow. If linking is preferred, link
   manually to the already-confirmed project reference first. Then preview and
   apply only the pending migration chain:

   ```bash
   bun run supabase db push --remote="$PROJECT_REF" --skip-vault --dry-run
   bun run supabase db push --remote="$PROJECT_REF" --skip-vault
   bun run supabase migration list --remote="$PROJECT_REF"
   ```

   The second `db push` is a hosted database write. Never run it without that
   separate operator approval. The migration does not create projects, approve
   licenses or logos, or publish listings.
5. Before ingestion, configure the service key only in the operator's server
   environment and run `bun run pipeline -- --status` and
   `bun run pipeline -- --audit`. Confirm the host, project reference,
   environment label, applied migration version, category seed, service RPC
   permissions, Storage bucket settings, current leases, and inventory. Resolve
   blockers and review findings first.
6. After separate approval for the hosted ingestion itself, execute a small
   batch with both explicit target guards:

   ```bash
   bun run pipeline -- --execute --max-queries 1 --max-pages 1 --max-candidates 10 \
     --allow-hosted-writes --confirm-project-ref "$PROJECT_REF"
   ```

   For an actual GitHub API smoke run, add `--live-smoke`; its stricter limits
   remain one search page and no more than five enrichments, assessments, or
   logo projects. The CLI blocks custom remote hosts whose project reference
   cannot be verified.
7. Save the structured run output, then run `--status` and `--audit`. Compare
   actual inventory, run-scoped persisted-row checks, retries, and integrity
   findings. Project drafts and logo candidates require human review.
8. After interruption, inspect `--status`, confirm the prior worker has
   stopped and leases have expired, then use `--resume --execute` with the same
   hosted target guards. Existing discovery checkpoints and queue state remain
   authoritative.

Hosted setup is documented but is not verified by local fixtures or the CI
workflow. No hosted migration or data write was performed for this milestone.

### Real authentication integration checks

The separate `auth-e2e` CI job installs Chromium and runs
`bun run test:auth-e2e`. The runner starts disposable local Supabase services,
applies migrations, provisions temporary Auth users through the trusted Admin
API, inserts their UUIDs into `public.admin_users`, runs the production Next.js
server, reads actual OTPs from Mailpit, and tests the login and protected pages
in Chromium. The local runner requires Docker and a stopped Supabase stack; it
resets the local database and stops/removes the stack afterward. It never uses
hosted credentials. Local Mailpit verification does not test hosted SMTP
delivery or hosted Supabase configuration.

When configuring the app to use local Supabase, copy `.env.example` to
`.env.local` and fill it with values printed by `bun run supabase status`.
Never put a secret key in a `NEXT_PUBLIC_` variable.

## M1-07 editorial review and publication

Administrators use `/admin` to review paginated database drafts and
`/admin/projects/[id]` to inspect repository observations, assessment evidence,
license uncertainty, category suggestions, queue items, overrides, and audit
decisions. Editable fields are limited to project name, summary, description,
official website, categories, and tags. The project slug and repository
identity do not change through this workflow.

Publishing requires an administrator to cite independent licensing evidence,
select an SPDX identifier on the pinned OSI-approved list, and explicitly
confirm the project is open source. GitHub's detected license is only source
evidence. The administrator must separately confirm current repository
availability and minimum catalog quality; this is not a security or code
audit. Current validated source observations, an active category, and resolved
blocking review items are required. Database functions recheck the allowlist,
source freshness, decisions, and project revision in the same transaction that
publishes and appends the audit event. Anonymous and ordinary authenticated
clients cannot call these functions or read the decision table.

Editorial decisions are append-only. A stale form cannot replace a newer
administrator decision. There is no bulk publication, destructive delete, or
automated publication path. Rollback limitations: a published project is not
removed by this workflow, and audit decisions are immutable; a future
unpublishing or correction policy requires a separately reviewed migration and
decision path. CI exercises the complete workflow against local Supabase Auth,
PostgreSQL, and public RLS; hosted migrations and real project publication are
not part of CI.

## Architecture and plans

- [Architecture](ARCHITECTURE.md) describes the current app and intended system boundaries.
- [Administrator authentication](ADMIN_AUTH.md) documents OTP setup, session
  handling, authorization, and safe administrator provisioning.
- [Data pipeline](DATA_PIPELINE.md) distinguishes candidates, enriched repositories, and published projects.
- [Roadmap](ROADMAP.md) lists the milestone sequence.

Public catalog routes require configured Supabase credentials and use the
published catalog with RLS. Hosted Supabase configuration, production catalog
contents, and SMTP delivery remain unverified. CI validates local migrations,
search and editorial integration, database grants and RLS, generated type
parity, and isolated Chromium flows without hosted credentials.

## Environment variables

`.env.example` contains placeholders only. `GITHUB_TOKEN` is optional and is
read only by the server-side/Bun source adapter when a client is created:

- `NEXT_PUBLIC_SUPABASE_URL` — Supabase project URL
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — publishable client key
- `SUPABASE_SECRET_KEY` — privileged server-only key
- `GITHUB_TOKEN` — optional GitHub token for authenticated REST API reads and
  the authenticated repository-search rate limit; never expose it to browser code

The browser and cookie-aware server clients use only public credentials. The
privileged client is marked server-only and disables session persistence. Do
not set the GitHub token in a `NEXT_PUBLIC_` variable. The GitHub adapter uses
`Authorization: Bearer`, `Accept: application/vnd.github+json`, and REST API
version `2022-11-28`; its optional smoke command is network dependent and is
excluded from the ordinary test suite. Discovery dry-run and unit tests need
no credentials. Database integration tests use disposable local Supabase keys
generated by CI; ordinary CI never needs a live GitHub token or external
GitHub API access.
