# Data pipeline

## Current behavior

The current catalog is the checked-in `src/data/projects.json` sample set. It
contains 33 illustrative project records and is validated by
`bun run validate:data` and Vitest. The UI searches and sorts this data in the
browser. Submission, moderation, and sync actions are local demo behavior.

The M0-02 production schema is present, but it starts with no project listings.
The only seeded rows are the 11 category taxonomy records. There is still no
repository scraper, scheduled job, external API integration, project catalog
write, or operational ingestion pipeline.

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
valid catalog data. This workflow will be designed and implemented in later
milestones; none of its steps currently runs against Supabase.

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
are disabled pending a validated server endpoint. M0-03 will add administrator
authentication and authorization; the ingestion worker and database-backed UI
belong to later milestones.

Logo files use a public `project-logos` bucket with a 2 MiB limit and PNG,
JPEG, and WebP MIME restrictions. Public bucket downloads bypass object RLS,
therefore future ingestion must decode and validate the image, strip metadata,
reject active content and SVG, assign an opaque project-owned path, and upload
only after editorial approval. Record safe attribution on the approved logo
metadata. Revocation must remove the object through the Storage API; deleting
only its Postgres metadata does not delete the stored object.

Scheduled execution, source credentials, logo downloading, remote migration
deployment, publication workflows, search RPC, and public UI integration are
outside M0-02.
