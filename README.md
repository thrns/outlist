# Outlist

Outlist is an open-source discovery directory built as a Next.js 16 modular
monolith. The current app is a local demo with a curated sample catalog. Bun is
the package manager and runtime; Supabase clients and the local CLI workflow
provide the foundation for later milestones.

## Requirements

- Bun **1.3.14** (pinned by `.bun-version` and `package.json`)
- A supported operating system for Next.js
- Docker-compatible container runtime only when starting the local Supabase stack

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
- `/admin` — Browser-local review queue and mock sync controls

The existing component-based UI, design, CSS, and all 33 sample projects remain
in place. Demo repository metrics are illustrative. Directory edits are stored
in browser `localStorage`; they are not shared across users or devices. The
admin and ingestion controls are demonstrations and are not connected to a
database or external repository service.

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
authenticated users. Those roles cannot write projects, submissions, or logo
objects. Admin authentication and submission endpoints come later.

The `project-logos` bucket is public for approved assets, limited to 2 MiB and
PNG/JPEG/WebP. Public bucket downloads bypass Storage object read policies, so
only approved and validated files should ever be uploaded. SVG handling is
excluded. Logo URLs, verification, and safe attribution live in
`project_logos`; the current UI letter fallback remains unchanged.

When configuring the app to use local Supabase, copy `.env.example` to
`.env.local` and fill it with values printed by `bun run supabase status`.
Never put a secret key in a `NEXT_PUBLIC_` variable.

## Architecture and plans

- [Architecture](ARCHITECTURE.md) describes the current app and intended system boundaries.
- [Data pipeline](DATA_PIPELINE.md) distinguishes the current static data from planned ingestion.
- [Roadmap](ROADMAP.md) lists the milestone sequence.

The demo's existing routes and localStorage behavior remain unchanged and do
not query the database. The schema, RLS, taxonomy, logo bucket, and generated
types are implemented; the search RPC, server-side catalog integration,
submission endpoint, project publication tools, ingestion worker, and
administrator authentication are later milestones. GitHub Actions runs a
clean local Supabase stack, migration reset, pgTAP tests, database lint, and
type drift check without hosted credentials.

## Environment variables

`.env.example` contains placeholders only:

- `NEXT_PUBLIC_SUPABASE_URL` — Supabase project URL
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — publishable client key
- `SUPABASE_SECRET_KEY` — privileged server-only key

The browser and cookie-aware server clients use only public credentials. The
privileged client is marked server-only and disables session persistence. No
Supabase credentials are required by CI.
