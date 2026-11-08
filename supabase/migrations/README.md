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

M1-10's forward migration also updates the service-only pipeline readiness
report's expected migration list. `bun run launch:preflight` compares that
read-only report with the versions in this directory and checks anonymous
search/RLS, Storage, categories, Auth configuration, pipeline state, counts,
and integrity findings. It does not apply migrations or write records. Review
the target and follow [LAUNCH_RUNBOOK.md](../../LAUNCH_RUNBOOK.md) before any
hosted migration operation.

Database tests live in `supabase/tests/` and run through pgTAP. The CI database
job also runs `bun run test:discovery-db` against local Supabase to exercise
concurrent claims and transactional checkpoints through the service-role API,
then runs `bun run test:enrichment-db`, `bun run test:assessment-db`, and
`bun run test:logos-db` against real local PostgREST, PostgreSQL, and Storage
using deterministic GitHub HTTP and image fixtures. The logo integration uses
the actual public Storage service to verify the operator approval path and
failed-commit cleanup; no hosted credentials are required.
GitHub Actions rebuilds the database from scratch, reapplies the category seed
twice to check idempotency, runs tests and lint, and checks generated types for
drift.
