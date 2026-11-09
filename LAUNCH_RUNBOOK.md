# Outlist production ingestion and launch runbook

## Current production state

The production Supabase project `hvunezhzpnpdkfiqgaaa` is initialized with the
repository schema and the administrator can sign in with a password. No live
GitHub ingestion, project publication, or Vercel deployment has been performed.
This milestone adds a read-only ingestion readiness check; it does not run the
pilot.

## 1. Confirm the hosted Supabase setup

Use the production project and its existing migration history. The preflight
checks the hosted project reference, explicit environment label, migration
history, required pipeline operations and grants, public RLS behavior, all 11
categories, logo Storage configuration, public catalog search, administrator
authorization, current jobs and leases, and integrity findings. It does not
apply migrations or change database or Storage data. If migration history or
schema readiness is incomplete, stop and use the separately reviewed database
change process; do not repair production during a preflight.

| Variable | Where to configure it | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Operator environment and Vercel | Supabase API URL; its hostname identifies the project. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Operator environment and Vercel | Public catalog reads and Auth. RLS is the security boundary. |
| `SUPABASE_SECRET_KEY` | Trusted operator environment and Vercel server runtime only | Server-only allowlist checks and restricted database operations. Never expose it to the browser. |
| `OUTLIST_SUPABASE_ENVIRONMENT` | Operator environment and Vercel | Explicit target label; set to `production` for the production project. |
| `GITHUB_TOKEN` | Trusted operator environment only | Authenticated read access for GitHub inspection and bounded ingestion. No write scope is required. |
| `OUTLIST_PUBLIC_ORIGIN` | Operator environment for website launch checks | Actual deployed HTTPS origin; not needed for ingestion readiness. |

Keep separate project credentials, Auth settings, and deployment environments
for development, staging, and production. Never reuse production credentials
in local development or CI. GitHub Actions uses disposable local Supabase and
deterministic GitHub fixtures.

## 2. Confirm administrator authorization

Production password sign-in is already working. The read-only preflight
rechecks that an allowlisted administrator exists, the Supabase Email provider
is enabled, and public signup is disabled before ingestion readiness can pass.
Keep email confirmation enabled. Provision or change administrator access only
through the trusted procedure in [ADMIN_AUTH.md](ADMIN_AUTH.md); never use
public signup or add administrator identities in a migration.

The application has no OTP, Magic Link, registration, or public password-reset
flow. Administrator authorization is tied to the allowlisted Auth UUID, not an
email address or browser state.

## 3. Verify ingestion readiness without Vercel

Configure the production Supabase URL, publishable key, server secret, and a
server-only GitHub token in the trusted operator environment. Set the explicit
production label, then run:

```bash
export PROJECT_REF="hvunezhzpnpdkfiqgaaa"
export OUTLIST_SUPABASE_ENVIRONMENT=production
bun run launch:preflight -- --purpose ingestion --confirm-project-ref "$PROJECT_REF"
```

This command is read-only. It checks the production project reference and
environment, the migration chain and pipeline schema/grants, public catalog
RPC and anonymous RLS reads, category and Storage readiness, Auth settings and
administrator allowlist, GitHub API authentication and the budget for the
bounded pilot, running jobs, active worker leases, and critical integrity
findings. It does not require `OUTLIST_PUBLIC_ORIGIN`, a deployed website, or
Vercel environment variables. A successful ingestion check can report
`ingestion_ready: true` and `launch_ready: false`; `hosted_verification` remains
partial until website deployment verification occurs.

Review the report. It must show the approved production project reference,
`ingestion_ready: true`, no ingestion blockers, all expected migrations
verified, a ready public catalog and pipeline schema, the configured
administrator authorization, enough GitHub budget, no running ingestion jobs
or leases, and no critical integrity findings. The command's exit status is
zero only when ingestion-specific checks pass. A pass does not authorize or
start ingestion.

For additional read-only context, inspect the worker status and integrity
report:

```bash
bun run pipeline -- --status
bun run pipeline -- --audit
```

These checks do not claim that hosted workers ran or that any project was
ingested.

## 4. Run a separately authorized bounded GitHub pilot

The first production write requires a separate operator authorization after
reviewing the successful preflight and confirming the target. The approved
discovery plan fetches 100 results per search page, so keep the first pilot's
candidate budget page-aligned. It can discover up to 100 candidates, while
enrichment and assessment each remain capped at five:

```bash
bun run pipeline -- --live-smoke --execute \
  --max-queries 1 --max-pages 1 --max-candidates 100 \
  --max-enrichments 5 --max-assessments 5 --max-logo-projects 5 \
  --allow-hosted-writes --confirm-project-ref hvunezhzpnpdkfiqgaaa
```

Hosted writes require both `--execute` and `--allow-hosted-writes`, together
with a matching `--confirm-project-ref`. Do not automate a run after preflight.
The live-smoke ceiling is one GitHub search query and page, 100 discovered
candidates, five enrichments, five assessments, and five logo candidates.
Hosted live-smoke preflight rejects a candidate budget below the approved
100-result page before creating an ingestion job. It does not upload logos,
mark a license or quality as human-verified, approve a logo, or publish a
project. Discovered candidates are private queue records, not published
projects.

The earlier run `0fb02e01-1f76-4d5f-a0d6-14b1398e9552` authenticated to GitHub
and reported no HTTP failures, but its 10-candidate budget could not hold the
100-result search page. The worker released its one claimed partition without
committing the page or advancing its cursor. The job is correctly recorded as
partial, with zero candidates or downstream records; all ten registered
partitions remain pending, with no active leases or integrity findings. No
automatic publication occurred. Leave that historical job report unchanged.
The next run reuses the original plan version, partition fingerprints, and
checkpoints. A budget-limited outcome reports that the page was not committed,
preserves its checkpoint, and exits nonzero; it is not a rate-limit failure.

Do not treat exit code zero or GitHub authentication alone as successful
ingestion. Require `data_ingestion_success: true`, backed by persisted source
provenance and a validated candidate-to-draft lineage in the report.

Keep the structured report and distinguish these counts: discovered GitHub
candidates, successfully enriched public repositories, completed assessments,
pending-review drafts, and published projects. Require a coherent lineage for
any draft: stable GitHub repository ID, discovery candidate, validated source
observations, canonical repository, assessment, project draft, and review
queue. Inspect partial failures, retry times, active leases, and the last
durable checkpoint. Only public, available, non-private, non-disabled sources
may progress. Do not copy private source data into logs or reports.

If a stage fails or is rate-limited, retain its report and checkpoint. Wait for
the reported reset, inspect `--status` and `--audit`, and confirm the previous
worker stopped and its lease expired before any separately authorized resume:

```bash
bun run pipeline -- --status
bun run pipeline -- --audit
bun run pipeline -- --resume --execute --live-smoke \
  --max-queries 1 --max-pages 1 --max-candidates 100 \
  --max-enrichments 5 --max-assessments 5 --max-logo-projects 5 \
  --allow-hosted-writes --confirm-project-ref hvunezhzpnpdkfiqgaaa
```

## 5. Review drafts and publish individually

Sign in at `/admin/login` with the provisioned allowlisted administrator. For
each pending draft, inspect the current repository and source evidence, correct
details and categories, record license evidence, complete the separate human
quality review, resolve blocking items, and publish only that individually
approved project. Leave uncertain, restricted, stale, or incomplete drafts in
review. Verify logo source and attribution before approving a logo. GitHub
metadata alone does not establish human license or quality verification.

After publication, use anonymous requests to verify that the project appears
in search and its category, that its detail page shows correct metadata,
source links, license, and approved logo or deterministic fallback, and that
it is absent from unpublished or restricted states. Confirm the published
visibility is available without an administrator session. Never report
candidate, enriched, assessment, or pending-review totals as the published
catalog count.

## 6. Expand ingestion gradually

After the pilot, review rate use, classification results, failure recovery,
editorial queue size, manual review capacity, and provider costs. Increase
manual batch limits gradually and review every report before repeating. The
pipeline hard ceilings are 100 candidates, 25 enrichments, 25 assessments, and
25 logo-candidate checks per run. For example:

```bash
bun run pipeline -- --execute --max-queries 2 --max-pages 1 \
  --max-candidates 100 --max-enrichments 25 --max-assessments 25 \
  --max-logo-projects 25 --allow-hosted-writes \
  --confirm-project-ref "$PROJECT_REF"
```

Use GitHub Search and Core API budgets, queue backlog, retries, classification
success, and review capacity to set each next batch. Do not automate recurring
ingestion in this milestone. Discovery is a bounded search sample, not a
complete crawl. A target of 1,000 published projects is unsupported until
1,000 projects pass independent editorial review and publication.

## 7. Deploy the website to Vercel

Deploy the Next.js application to the production Vercel project only after the
ingestion and editorial workflow is ready for public use. Configure
`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` for the
production build. Provide `SUPABASE_SECRET_KEY` only to the server runtime;
never expose it to client bundles. Set `OUTLIST_SUPABASE_ENVIRONMENT=production`
for the production deployment. Keep `GITHUB_TOKEN` in the trusted operator
environment rather than the website deployment unless the operator explicitly
chooses to run workers there.

Use the repository's pinned Bun version (`.bun-version`, currently 1.3.14),
build with `bun run build`, and serve with the Vercel Next.js runtime. Configure
the real production domain and HTTPS at Vercel. Do not put an example, preview,
or fabricated HTTPS origin into `OUTLIST_PUBLIC_ORIGIN`.

## 8. Complete HTTPS and public launch verification

Once the Vercel deployment and production domain are live, configure
`OUTLIST_PUBLIC_ORIGIN` in the trusted operator environment with that exact
HTTPS origin, without a path or trailing slash. Run the default launch
preflight, which retains website-origin requirements:

```bash
bun run launch:preflight -- --confirm-project-ref "$PROJECT_REF"
```

Then verify the deployed site and public catalog. Use an already published
project slug and active category slug for the final requests. Set those two
shell variables to actual values before running the commands:

```bash
export CATEGORY_SLUG="<active-category-slug>"
export PROJECT_SLUG="<published-project-slug>"
curl -fsS "$OUTLIST_PUBLIC_ORIGIN/" >/dev/null
curl -fsS "$OUTLIST_PUBLIC_ORIGIN/explore" >/dev/null
curl -fsS "$OUTLIST_PUBLIC_ORIGIN/categories" >/dev/null
curl -fsS "$OUTLIST_PUBLIC_ORIGIN/category/$CATEGORY_SLUG" >/dev/null
curl -fsS "$OUTLIST_PUBLIC_ORIGIN/project/$PROJECT_SLUG" >/dev/null
curl -fsS "$OUTLIST_PUBLIC_ORIGIN/admin/login" >/dev/null
curl -fsS "$OUTLIST_PUBLIC_ORIGIN/api/catalog/search?q=<three-or-more-characters>"
```

In a private browser session, confirm an unpublished slug is not found and the
deliberately published project appears in anonymous search and details. Verify
category, license, and language filters, logo or fallback, and source links.
A database failure must produce the explicit public error state or an API
`503`, without sample-project fallback or secret details. Short or empty API
queries return the documented empty response; malformed input returns `400`.
Do not create a test restricted repository or expose private repository data.

## Recovery and rollback

**Website deployment failure:** route traffic back to the last known-good
Vercel artifact. Keep the database at its current migration level; a website
rollback does not undo database changes.

**Wrong app environment values:** remove traffic, compare the configured host
and project reference, replace only affected values from the correct secret
store, redeploy, and repeat preflight and smoke checks. Never print secrets.

**Supabase connectivity failure:** keep public routes in their explicit error
state; do not restore JSON demo data as fallback. Check Supabase service
health, project URL, network allowlists, publishable key, server secret key,
Auth, and PostgREST logs. Restore traffic only after anonymous search and
administrator authentication work again.

**GitHub rate limit:** stop issuing requests, retain the report and durable
checkpoints, wait for the relevant Core or Search reset, then recheck budget.
Do not reset queues or start another overlapping run.

**Interrupted ingestion:** inspect `pipeline -- --status` and
`pipeline -- --audit`, checkpoints, and retry time. Confirm no worker remains
active. Resume only after verifying that the checkpoint is safe; reports must
distinguish reused records from new commits.

**Failed future migration:** stop and preserve the exact output. Compare
migration history and schema to the reviewed chain before retrying. Never edit
an applied historical migration or mark it applied by hand. Correct forward
with a separately reviewed migration, or follow the authorized recovery/PITR
procedure after a database owner evaluates the impact.

**Incorrectly published project:** stop further publication and preserve the
editorial decision and source evidence. The application has no general
unpublish control; do not issue an ad-hoc table update. Escalate for an
authorized corrective change. If a validated primary source becomes
restricted, retain the system-origin safety demotion and audit event. A human
must review current evidence and deliberately republish after source recovery.

## Acceptance targets

The production pilot is accepted only after a bounded live ingestion succeeds,
at least one real candidate has a complete source-to-draft lineage, no
critical integrity finding remains, an allowlisted administrator completes
review, one project is deliberately published, and anonymous deployed-site
search and details verify its metadata, filters, logo or fallback, and source
links. Local security and integration checks cover RLS, unpublished exclusion,
publication guards, and source-safety demotion. Hosted database and website
checks must pass independently before declaring launch complete.

At M2-02 completion, the production schema and password administrator access
are initialized. No live GitHub ingestion, project publication, or Vercel
deployment has been performed.
