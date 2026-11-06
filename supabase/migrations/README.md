# Database migrations

Versioned SQL migrations in this directory are the single source of truth for
the PostgreSQL schema, RLS policies, Storage bucket, and category taxonomy.
Keep each migration focused and ordered by its UTC timestamp. Do not edit a
hosted database directly or add an ORM schema.

After editing migrations, use the project-pinned CLI to rebuild the disposable
local database and verify it:

```bash
bun run supabase db reset
bun run supabase:db-test
bun run supabase:db-lint
bun run supabase:types
```

Database tests live in `supabase/tests/` and run through pgTAP. The CI database
job also runs `bun run test:discovery-db` against local Supabase to exercise
concurrent claims and transactional checkpoints through the service-role API,
then runs `bun run test:enrichment-db` and `bun run test:assessment-db` against
real local PostgREST and PostgreSQL using deterministic GitHub HTTP fixtures.
GitHub Actions rebuilds the database from scratch, reapplies the category seed
twice to check idempotency, runs tests and lint, and checks generated types for
drift.
