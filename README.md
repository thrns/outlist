# Outlist

Outlist is an open-source discovery directory built as a Next.js 16 modular
monolith. The current app is a local demo with a curated sample catalog. Bun is
the package manager and runtime; Supabase clients and the local CLI workflow
provide the foundation for later milestones.

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

Open [http://localhost:3000](http://localhost:3000). The demo runs without
Supabase credentials. Supabase clients validate their required configuration
only when called, so an unconfigured project can still build and render the
existing routes.

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

## Existing demo

- `/` — Home, hero search, featured projects, trending/recent, categories
- `/explore` — Search, category/license/language filters, sorting, pagination
- `/categories` and `/category/[id]` — Category directory and filtered listings
- `/project/[id]` — Project details and related projects
- `/alternatives` — Browse proprietary-software alternatives
- `/submit` — Browser-local submission queue
- `/admin/login` — Invite-only administrator email OTP sign-in
- `/admin` — Protected browser-local review queue and mock sync controls

The existing component-based UI, design, CSS, and all 33 sample projects remain
in place. Demo repository metrics are illustrative. Directory edits are stored
in browser `localStorage`; they are not shared across users or devices. The
admin controls remain demonstrations and are not connected to a database. A
separate GitHub adapter can inspect repositories and search approved query
partitions. Its bounded discovery CLI persists private, unreviewed candidates
and checkpoints to Supabase. The separate enrichment CLI fetches by stable
GitHub repository ID and writes canonical repositories, source provenance,
languages, topics, releases, and daily snapshots. Candidates, enriched
repositories, assessed project drafts, and published projects remain distinct
states. Assessment creates only pending-review drafts and never verifies
licenses or quality. `/admin` requires Supabase Auth and a
matching UUID in the private `public.admin_users` allowlist. See
[ADMIN_AUTH.md](ADMIN_AUTH.md) for setup and administrator provisioning.

The pipeline stages are distinct: **discovered candidate ≠ enriched
repository ≠ assessed project draft ≠ published project**.

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
for recovery and exposure details. The demo UI keeps its existing letter
fallback; no public UI redesign is part of M1-05.

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

## Architecture and plans

- [Architecture](ARCHITECTURE.md) describes the current app and intended system boundaries.
- [Administrator authentication](ADMIN_AUTH.md) documents OTP setup, session
  handling, authorization, and safe administrator provisioning.
- [Data pipeline](DATA_PIPELINE.md) distinguishes candidates, enriched repositories, and published projects.
- [Roadmap](ROADMAP.md) lists the milestone sequence.

Public demo routes and their localStorage behavior do not query the database.
M0-03 adds invite-only administrator OTP authentication, SSR session refresh,
per-request UUID allowlist authorization, and real local browser verification
for the demo admin route; it does not connect moderation or ingestion controls
to production tables. Hosted Supabase configuration and hosted SMTP delivery
remain unverified. The search RPC, server-side catalog integration, submission
endpoint, project publication tools, and recurring discovery remain later
milestones. GitHub Actions validates the app, rebuilds the local database,
tests discovery, enrichment, and assessment queue transactions with
deterministic GitHub fixtures, and runs isolated Chromium authentication checks
without hosted credentials.

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
