# Bulk catalog import

`catalog:import` validates the curated ZIP and produces an offline review report. Its execution mode only adds source observations, candidate queue rows, and a dedicated ingestion job. The existing enrichment and assessment workers remain responsible for current-source checks and any later draft creation.

## Operator commands

```sh
# Verify ZIP CRCs, the manifest, all batch hashes, JSONL records, and global identity uniqueness.
bun run catalog:import -- --validate

# Build a complete offline preview with per-candidate evidence and reasons.
bun run catalog:import -- --dry-run --report .catalog-input/catalog-import-dry-run.json

# Read the latest import checkpoint (read-only).
bun run catalog:import -- --status

# Execute one bounded batch against an explicitly configured local Supabase instance.
bun run catalog:import -- --execute --environment local --max-batches 1 --report .catalog-input/catalog-import-run.json

# Continue an interrupted local import after resolving the interruption.
bun run catalog:import -- --resume --execute --environment local --max-batches 1 --report .catalog-input/catalog-import-run.json
```

Hosted writes are blocked unless the operator supplies all three of `--environment staging|production`, `--allow-hosted-writes`, and `--confirm-project-ref <exact-ref>`, and the confirmed ref matches `NEXT_PUBLIC_SUPABASE_URL`. If `OUTLIST_SUPABASE_ENVIRONMENT` is set, it must match too. Unknown remote hosts are blocked. This importer has not been run against a hosted environment.

## Archive and review behavior

Validation reads ZIP entries in memory and rejects unsupported compression, unsafe or duplicate paths, encrypted/symlink entries, CRC/hash/count mismatches, malformed JSONL, malformed or unsafe URLs, non-public visibility claims, duplicate repository IDs/full names/slugs, and unsupported category or status values. The aggregate candidate file must match the ordered batch concatenation.

The review report gives each record one of three outcomes: eligible for automated editorial recommendation, requires manual review, or rejected/excluded. Offline mode cannot confirm current GitHub identity, current visibility, database conflicts, activity, or the live assessment; those checks stay explicit in each record's reasons and follow-up list. Execution re-fetches each repository by its stable numeric GitHub ID. The GitHub adapter keeps normalized data in `parsedResponseData` and exposes its schema-validated provider-shaped response separately as `originalResponseData` for the by-ID endpoint. Public source records retain that actual REST shape and fetch time. Private or restricted responses are excluded and their report/ledger entries retain only the numeric identity, classification, actual observation time, and sanitized reason codes; repository descriptions, license data, and other response fields are discarded. Retryable GitHub failures stop before that batch is committed.

GitHub's license field and the archive's SPDX identifier are evidence only. Catalog input licenses remain unverified or require review. Nothing in the import process approves licenses or logos, resolves review items, or publishes a project.

## Database mutations

Each committed batch uses one transaction. For a new repository identity, it writes:

1. A `source_records` row containing the real GitHub repository response, source API URL, HTTP status, API version, and actual fetch time.
2. A queued `repository_candidates` row keyed by GitHub's stable repository ID.
3. An `ingestion_items` ledger row holding the original curation record, archive SHA-256, source batch/line, safely mapped active category, deterministic slug proposal, review evidence, and current GitHub provenance.
4. Progress in one `ingestion_jobs` row, including sequential archive and JSONB payload hashes and the worker lease.

Existing candidate or repository identities are recorded as skipped import ledger rows; their existing rows are not updated. Excluded identities receive candidate-less `catalog_import_exclusion` ledger rows containing only the safe repository ID, exclusion classification, observed timestamp, and allowlisted reason codes. Neither the GitHub response nor the archive candidate record is retained for excluded identities, and they never enter the candidate queue. On resume, a service-only RPC reconstructs identity-only report entries from those sanitized ledger rows, including for exclusions written by an earlier invocation. Category slugs are resolved against active `categories` rows and persisted in the import ledger. The assessment pipeline remains responsible for project classification. Slug collisions for imported records use the proposed slug followed by the numeric GitHub repository ID and, if needed, a stable attempt suffix. The pre-existing slug behavior for non-catalog assessment jobs is preserved.

The batch transaction creates zero project, project-category, project-tag, logo, assessment, review-decision, or publication rows. Later, the standard assessment RPC can create a new project only when its current source quality and classification rules allow it. Such a project stays `pending_review`, license status stays unverified/unknown/needs-review, and existing project/editorial fields remain authoritative.

`--max-batches` bounds work per invocation. Database checkpoints advance only after the whole batch commits. A worker lease blocks concurrent catalog import workers; it does not claim or modify discovery, enrichment, or assessment jobs. Resume requires the same archive hash, batch/candidate counts, project reference, and environment. `--status` reports durable progress and reconciliation counts.

## Local verification

Unit tests run with:

```sh
bun --bun vitest run src/lib/catalog-import scripts/catalog-import.test.ts
```

Database integration tests run through the repository's local Supabase stack:

```sh
SUPABASE_TELEMETRY_DISABLED=1 bun run supabase:db-test
SUPABASE_TELEMETRY_DISABLED=1 bun run supabase:db-lint

# End-to-end importer + real GitHubClient HTTP fixtures + local Supabase RPCs.
eval "$(./node_modules/.bin/supabase status -o env)"
NEXT_PUBLIC_SUPABASE_URL="$API_URL" \
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$ANON_KEY" \
SUPABASE_SECRET_KEY="$SERVICE_ROLE_KEY" \
OUTLIST_SUPABASE_ENVIRONMENT=local \
bun run test:catalog-import-db
```

Those commands require Docker and use the local stack. Do not add `--linked` or run `supabase db push` for importer verification.
