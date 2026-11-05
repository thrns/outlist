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

The local stack configuration is in `supabase/config.toml`. Versioned SQL
migrations belong in `supabase/migrations/`; M0-01 intentionally adds no schema.
Use `bun run supabase migration new <name>` to create a migration in a later
schema milestone. Do not link a hosted project or use a remote migration
command as part of local setup.

When configuring the app to use local Supabase, copy `.env.example` to
`.env.local` and fill it with values printed by `bun run supabase status`.
Never put a secret key in a `NEXT_PUBLIC_` variable.

## Architecture and plans

- [Architecture](ARCHITECTURE.md) describes the current app and intended system boundaries.
- [Data pipeline](DATA_PIPELINE.md) distinguishes the current static data from planned ingestion.
- [Roadmap](ROADMAP.md) lists the milestone sequence.

The planned system uses Supabase SQL migrations as the database schema source
of truth. Generated TypeScript database types will be added after the schema is
created. PostgreSQL search, Storage, server-side access controls, and scheduled
ingestion are planned; none is claimed to be operational yet.

## Environment variables

`.env.example` contains placeholders only:

- `NEXT_PUBLIC_SUPABASE_URL` — Supabase project URL
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — publishable client key
- `SUPABASE_SECRET_KEY` — privileged server-only key

The browser and cookie-aware server clients use only public credentials. The
privileged client is marked server-only and disables session persistence. No
Supabase credentials are required by CI.
