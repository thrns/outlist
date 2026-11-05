# Data pipeline

## Current behavior

The current catalog is the checked-in `src/data/projects.json` sample set. It
contains 33 illustrative project records and is validated by
`bun run validate:data` and Vitest. The UI searches and sorts this data in the
browser. Submission, moderation, and sync actions are local demo behavior.

There is no repository scraper, scheduled job, external API integration,
database write, or operational ingestion pipeline in M0-01.

## Planned ingestion

The target ingestion process is a scheduled Bun worker with explicit source
adapters. Each run should:

1. Fetch repository metadata from approved source APIs with rate-limit handling.
2. Normalize source records into the catalog model and validate them with Zod.
3. Store source snapshots or retained assets in Supabase Storage where needed.
4. Upsert normalized project data and run metadata into Supabase PostgreSQL.
5. Record provenance, timestamps, and validation outcomes for review.

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

`db reset` is a destructive reset of the local database. M0-01 does not add a
schema or run migrations. After the schema is established, generated TypeScript
database types will be committed from the local schema and refreshed when
migrations change.

Scheduled execution, source credentials, hosted storage, and remote migration
deployment are outside this milestone.
