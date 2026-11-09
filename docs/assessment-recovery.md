# Assessment recovery operations

M2-04 recovery is limited to one existing GitHub assessment job and at most four assessments. It does not call discovery, enrichment, or logo workers. The recovery RPCs refuse an unexpired assessment lease, validate the exact job type and ID, and claim only assessments already attached to that job. Existing attempt counts and lease fencing remain authoritative.

The deployment must include migration `20261109100000_m2_04_assessment_recovery.sql`. The operator must have the production Supabase URL and service secret configured in the shell, plus `OUTLIST_SUPABASE_ENVIRONMENT=production`. Review the operator status and confirm the job ID before running:

```sh
OUTLIST_SUPABASE_ENVIRONMENT=production \
bun run recover:assessment -- \
  --execute \
  --resume \
  --allow-hosted-writes \
  --confirm-project-ref hvunezhzpnpdkfiqgaaa \
  --job-id 88704b50-ed03-4d46-b7f3-90ac7c477864 \
  --max-assessments 4
```

The command prints a sanitized JSON report with the reused job, final job status, assessment status counts, active leases, and whether the job inventory changed. Exit code zero requires the worker and persisted report to confirm successful completion. A partial or interrupted outcome remains visible as a nonzero exit.

## Migration and rollback

The migration adds three service-role-only RPCs, a short-lived ownership fence on assessment row updates, and an operator-report preflight entry for the new migration and RPCs. It does not modify existing assessments, projects, review decisions, or lease fields. The existing completion RPC remains responsible for creating one pending-review draft and reusing its open review item atomically.

For an emergency rollback, first wait until no assessment recovery is running and no assessment lease is active. Apply a forward rollback migration that drops `repository_assessments_95_recovery_ownership`, drops the private trigger function and the three public recovery RPCs, then replaces the M2-04 `pipeline_operator_report()` wrapper with the renamed `pipeline_operator_report_m2_04_previous()` implementation. Restore `service_role` execute permission on that report function. Keep the migration history intact; a permanent rollback should be recorded as a later migration so clean database builds remain reproducible.

The rollback migration's SQL can use this transaction:

```sql
begin;
drop trigger if exists repository_assessments_95_recovery_ownership on public.repository_assessments;
drop function if exists private.guard_assessment_recovery_ownership();
drop function if exists public.finish_github_repository_assessment_recovery(uuid, text);
drop function if exists public.claim_github_repository_assessments_for_recovery(uuid, text, integer, integer);
drop function if exists public.begin_github_repository_assessment_recovery(uuid, text, integer);
alter function public.pipeline_operator_report() rename to pipeline_operator_report_m2_04_rollback;
alter function public.pipeline_operator_report_m2_04_previous() rename to pipeline_operator_report();
revoke all on function public.pipeline_operator_report_m2_04_rollback() from public, anon, authenticated, service_role;
grant execute on function public.pipeline_operator_report() to service_role;
commit;
```

Do not clear `lease_token`, `lease_expires_at`, or lock-owner fields by hand. The normal claim RPC reclaims only after expiry and issues a new fencing token.
