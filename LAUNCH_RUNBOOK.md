# Outlist production launch and first pilot

M1-10 prepares the deployment and operator procedure. The production Supabase
project, hosted migrations, website deployment, and live GitHub ingestion have
not been executed. The local tests prove only the local schema, Auth, Storage,
public search, editorial controls, and bounded worker behavior described in
CI.

## 1. Environment values

| Variable | Required where | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | App build and runtime; operator preflight | Supabase API URL. The hostname determines the project reference. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | App build and runtime; operator preflight | Public key used by anonymous catalog reads and Auth. This key is intended to be public; RLS is the security boundary. |
| `SUPABASE_SECRET_KEY` | App runtime for admin actions; trusted operator preflight and pipeline | Server-only key used for fresh admin allowlist checks and restricted database operations. Never prefix it with `NEXT_PUBLIC_`. |
| `OUTLIST_SUPABASE_ENVIRONMENT` | Operator preflight and pipeline | Explicit target label: `local`, `development`, `staging`, or `production`. |
| `GITHUB_TOKEN` | Operator process only, optional | Server-only read access for GitHub inspection, discovery, and enrichment. No GitHub write scope is required. |

`bun run launch:preflight` prints only whether variables are configured. It
does not print values. Hosted preflight also checks an HTTPS public origin and
checks Supabase Auth provider state, disabled public signup, and a nonempty
administrator allowlist. Set `OUTLIST_PUBLIC_ORIGIN` to the deployed HTTPS
origin. Password sign-in does not use an email callback or depend on Auth email
delivery.

Use separate Supabase projects, key sets, GitHub secrets, app deployment
environments, domains, and Auth settings for development, staging, and
production. Do not reuse production credentials in local development or CI.
GitHub Actions uses disposable local Supabase and deterministic GitHub fixtures;
it does not need hosted credentials or a live GitHub token.

## 2. Minimum website deployment

Use a managed Linux app service or container that supports Bun and runs a
long-lived Next.js server process. The repository already supplies the build
and start commands:

```bash
bun install --frozen-lockfile
bun run build
bun run start
```

Use the repository-pinned Bun version (`.bun-version`, currently 1.3.14).
Provide `PORT` from the host. Run with `NODE_ENV=production`. Configure the two
`NEXT_PUBLIC_SUPABASE_*` values at build and runtime because public variables
can be embedded in client bundles. Set `SUPABASE_SECRET_KEY` only in the
server-side runtime secret store; it is not needed for the static build unless
the hosting process specifically requires runtime variables during build.
Keep `GITHUB_TOKEN` out of the website service unless the operator intentionally
runs ingestion from that environment; the normal process is manual operator
execution from a controlled workstation or job environment.

Terminate HTTPS at the hosting edge, attach the chosen domain, and confirm the
application is only served over HTTPS. The app sets secure session cookies in
production. In Supabase **Authentication → Sign In / Providers**, keep the
Email provider enabled for password authentication, keep **Allow new users to
sign up** disabled, and keep email confirmation enabled. Confirm that each
administrator controls their intended email before marking it confirmed.
There is no OTP, Magic Link, registration, email callback, or public
password-reset flow in the application. Create or configure the Auth user and
add its returned UUID to `public.admin_users` using the trusted steps in
[ADMIN_AUTH.md](ADMIN_AUTH.md); never add an administrator in a migration or
through public signup.

The `project-logos` Storage bucket is intentionally public so approved logo
URLs can load on public project cards and details. The application uses only
approved logo records and falls back to deterministic initials when no approved
logo exists. Candidate discovery does not upload logo files. Keep pending or
unreviewed logos out of public Storage; verify the bucket's 2 MiB limit and PNG,
JPEG, and WebP input MIME restrictions after migration.

Keep production build output, deployment artifacts, GitHub Actions logs, and
platform logs free of secret keys, access tokens, Auth codes, and request
headers. Publishable keys are expected in the browser; secret keys and GitHub
tokens are not. Use the hosting provider's server request logs and Supabase
logs to diagnose connectivity. Public pages show explicit catalog errors and
do not fall back to the JSON sample data. Inspect sanitized server logs and
provider request IDs rather than logging environment values.

## 3. Verify and apply migrations

Complete these steps in order. A preflight is read-only and does not authorize
any migration or data write.

1. In Supabase Dashboard, open the intended project and copy its reference from
   Project Settings. Compare it with the subdomain in
   `NEXT_PUBLIC_SUPABASE_URL`. Set `OUTLIST_SUPABASE_ENVIRONMENT` to the exact
   intended environment. Do not proceed if they disagree.
2. Review the local migration files and current remote migration history:

   ```bash
   export PROJECT_REF="<reviewed-project-ref>"
   bun run supabase migration list --remote="$PROJECT_REF"
   ```

   Compare every version with the sorted files in `supabase/migrations/`.
   Investigate unexpected or partially applied versions before continuing.
3. Preview the pending chain. This is a dry run and must show only migrations
   reviewed for this release:

   ```bash
   bun run supabase db push --remote="$PROJECT_REF" --skip-vault --dry-run
   ```

4. Take and verify a restorable Supabase backup/PITR restore point according to
   the project's recovery policy. Keep database dumps outside the repository
   with restrictive file permissions.
5. Applying the migrations is a separate human-controlled production step.
   Only after explicit approval for the target and migration set, run:

   ```bash
   bun run supabase db push --remote="$PROJECT_REF" --skip-vault
   ```

   The command changes the hosted database schema. Do not run it as part of
   preflight, deployment, or an unreviewed CI job. It does not import projects
   or publish catalog entries.
6. Confirm completion, database security, and public catalog state:

   ```bash
   bun run supabase migration list --remote="$PROJECT_REF"
   bun run supabase db lint --remote="$PROJECT_REF" --schema public,private --fail-on error
   bun run supabase db query --remote="$PROJECT_REF" --read-only \
     --file supabase/ci/assert_launch_security.sql
   bun run launch:preflight -- --confirm-project-ref "$PROJECT_REF"
   ```

   The migration list must match the repository. The SQL security check only
   reads catalog metadata and verifies RLS, anonymous write denial, the public
   invoker-search function, administrator allowlist privacy, and service-only
   publication. Preflight checks the public API through an anonymous key,
   counts published/unpublished/pending-review records, checks the logo bucket,
   and runs the service-only integrity report. A fresh database is expected to
   have zero published projects and zero unpublished projects before ingestion.

## 4. Controlled first hosted pilot

Do not run this procedure until migration application, app configuration, and
live ingestion have each received their own authorization. Start with the
following environment and checks:

```bash
export PROJECT_REF="<reviewed-project-ref>"
export OUTLIST_SUPABASE_ENVIRONMENT=production
export OUTLIST_PUBLIC_ORIGIN="https://<deployed-domain>"
# Verify this is the deployed HTTPS origin before running the preflight.

bun run launch:preflight -- --confirm-project-ref "$PROJECT_REF"
bun run pipeline -- --status
bun run pipeline -- --audit
```

Stop if preflight has blockers, the project reference is unexpected, any
critical integrity finding exists, an ingestion job or lease is active, or
the GitHub budget is insufficient. Fix environment, Auth, migration, bucket,
or integrity issues before requesting authorization for a live pilot.

After separate approval for hosted writes and real GitHub reads, run the
existing bounded live-smoke mode:

```bash
bun run pipeline -- --live-smoke --execute \
  --allow-hosted-writes --confirm-project-ref "$PROJECT_REF"
```

This run is capped at one GitHub search query and page, ten discovered
candidates, five enrichments, five assessments, and five logo candidates. It
does not upload logos, verify licenses, mark quality as human-verified, or
publish projects. Preserve the structured report and record these stages
separately:

- discovered GitHub candidates;
- successfully enriched public repositories;
- completed repository assessments;
- pending-review project drafts with a complete source-to-draft lineage;
- logo candidates awaiting separate review.

Candidate totals, enriched repository totals, assessed repositories, drafts,
and published projects are different measures. Ten candidates do not mean ten
enriched repositories, and one pending draft does not mean one published
project. Require one coherent lineage joining the same stable GitHub
repository ID across discovery, source observations, canonical repository,
assessment, project draft, and review queue. Inspect partial/failure counts,
the retry schedule, current leases, and last durable discovery checkpoint.
Confirm every candidate and repository being considered is public, available,
non-private, and non-disabled. Do not expose or copy private source data into
public logs or reports.

If a stage fails or rate-limits, preserve its report and durable checkpoint.
Wait until the reported reset, inspect `--status` and `--audit`, confirm the
previous worker stopped and its lease expired, then resume only when the stored
checkpoint and retry schedule make that safe:

```bash
bun run pipeline -- --status
bun run pipeline -- --audit
bun run pipeline -- --resume --execute --live-smoke \
  --allow-hosted-writes --confirm-project-ref "$PROJECT_REF"
```

The system does not infer human license or quality verification from GitHub
metadata. Sign in at `/admin/login` using the provisioned allowlisted account.
For each draft, independently inspect the current repository and source
evidence, correct project details and categories, record license evidence,
complete the separate human quality review, resolve blocking review items,
and publish only that individually approved project. Leave uncertain,
restricted, stale, or incomplete drafts pending review. Do not approve a logo
unless its source and attribution have also been reviewed.

After one deliberate publication, use anonymous requests to verify that the
project appears in Explore/search and its category, that the detail page has
the correct name, summary, description, source links, license, logo or fallback,
and category assignment, and that the project is absent from any unpublished
or restricted state. Confirm published visibility changes are visible without
an admin session. Use the deployed-site smoke checks below. Never report the
candidate, enriched, assessment, or pending-review totals as the published
catalog count.

## 5. Expand carefully

The first live-smoke limits are ceilings for the pilot. After reviewing its
rate use, classification success, failure recovery, editorial queue, and
operating cost, expand in bounded manual batches. The pipeline limits each
invocation to 50 candidates, 25 enrichments, 25 assessments, and 25 logo
candidate checks. A later batch can use, for example:

```bash
bun run pipeline -- --execute --max-queries 2 --max-pages 1 \
  --max-candidates 50 --max-enrichments 25 --max-assessments 25 \
  --max-logo-projects 25 --allow-hosted-writes \
  --confirm-project-ref "$PROJECT_REF"
```

Review the report before every repeat. Use GitHub Search's remaining budget and
reset, Core API budget, queue backlog, retry schedule, classification success,
manual review capacity, and actual provider/hosting cost to set the next batch.
For 100+ and later 1,000+ discovered and enriched repositories, repeat these
batches as checkpoints and review each measured stage count. Do not automate
recurring ingestion in this milestone. Discovery is a bounded search sample,
not a complete crawl. A target of 1,000 published projects is not supported
until 1,000 projects have actually passed independent editorial review and
publication.

## 6. Deployed-site smoke checks

Run after each website release and after the first publication. Set `ORIGIN` to
the deployed HTTPS origin. Use an already approved project slug and a known
category slug for the final two requests.

```bash
curl -fsS "$ORIGIN/" >/dev/null
curl -fsS "$ORIGIN/explore" >/dev/null
curl -fsS "$ORIGIN/categories" >/dev/null
curl -fsS "$ORIGIN/category/<active-category-slug>" >/dev/null
curl -fsS "$ORIGIN/project/<published-project-slug>" >/dev/null
curl -fsS "$ORIGIN/admin/login" >/dev/null
curl -fsS "$ORIGIN/api/catalog/search?q=<three-or-more-characters>"
```

Also verify in a private browser session that an unpublished slug returns the
not-found state, while the deliberately published project appears in anonymous
search and detail pages. Verify filters by category, license, and language;
verify the project logo or deterministic fallback and its source links; verify
the admin review page requires password authentication and an allowlisted Auth UUID. A catalog
database failure should produce the public error state or an API `503` with no
sample-project fallback or secret details. A short or empty API query has its
documented empty response; malformed input returns `400`.

Do not create a test restricted repository or expose private repository
details to exercise safety. The disposable-local pgTAP and integration suites
exercise anonymous RLS, publication guards, restricted-repository exclusion,
and the system-origin demotion. For the hosted pilot, observe that a
restricted-source result never appears in anonymous search. If a real published
primary source becomes restricted, the existing system-origin transition
moves the project to `pending_review` and public RLS hides it. Recovery restores
source availability only; current evidence, renewed human review, and a new
explicit publication decision are required.

## 7. Recovery and rollback

**Website deployment failure:** route traffic back to the last known-good app
artifact. Keep the database at its current migration level. A website rollback
does not undo database migrations.

**Wrong app environment values:** remove traffic, compare the configured host
and project reference, replace only the affected environment values from the
correct environment's secret store, restart/redeploy the app, then repeat
preflight and smoke checks. Never print secrets while diagnosing.

**Supabase connectivity failure:** keep public routes in their explicit error
state; do not restore JSON demo data as a fallback. Check Supabase service
health, project URL, network allowlists, publishable key, server secret key,
Auth and PostgREST logs. Restore app traffic only after anonymous search and
admin authentication work again.

**GitHub rate limit:** stop issuing requests, retain the structured report and
database checkpoints, wait for the relevant `core` or `search` reset, then
recheck the budget. Do not reset queues or start another overlapping run.

**Interrupted ingestion:** run `pipeline -- --status` and `pipeline -- --audit`,
inspect the durable checkpoint and retry time, and confirm no worker remains
active. Resume with the same project reference only after confirming the
checkpoint is safe. Earlier committed stage data remains; rerun counts must
distinguish reused records from newly committed records.

**Failed migration:** stop the migration command and preserve its exact output.
Compare the migration history and schema to the reviewed chain before retrying.
Do not edit an applied historical migration, mark a migration applied by hand,
or assume the whole chain rolled back. Correct forward with a reviewed new
migration. Use the authorized restore/PITR procedure only after a database
owner evaluates the data impact. Database recovery is separate from website
rollback.

**Incorrectly published project:** stop further publication and preserve the
editorial decision and source evidence. The current application deliberately
has no general unpublish control. Do not issue an ad-hoc table update. Escalate
for an authorized, reviewed corrective migration or application change. For
the specific case of a validated primary-source access restriction, retain the
existing system-origin safety demotion; do not rewrite or remove its audit
event. An explicit editor must re-review and deliberately republish after safe
source recovery.

## Acceptance targets

The first live pilot is accepted only when hosted migrations complete, one
bounded live GitHub ingestion succeeds, at least one real candidate has a
complete source-to-draft lineage, no critical integrity finding remains, an
allowlisted administrator completes authenticated review, one real project is
deliberately published, and anonymous deployed-site search/details verify its
correct metadata, filters, logo/fallback, and source links. Public RLS,
unpublished exclusion, publication guards, and source-safety demotion must be
covered by the local security/integration suite and checked without revealing
private source data. The checks must pass independently for the hosted app and
database before declaring the pilot complete.

These are future operator acceptance targets. M1-10 has not run the hosted
migrations, deployed the website, ingested a real GitHub candidate, performed
a hosted administrator sign-in, or published a real project.
