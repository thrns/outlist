# Codex CLI catalog review

Catalog decisions use the locally installed Codex CLI, authenticated through the
operator's ChatGPT login. This workflow has no OpenAI API client and does not
support another model provider.

## Current input set

The review queue is built from the existing production audit files. It verifies
repository IDs, candidate IDs, names, batch and line provenance, then sorts by
batch and input line. It does not import or reimport the catalog.

```bash
codex login status
bun run catalog:review -- doctor
bun run catalog:review -- prepare
bun run catalog:review -- status
```

`prepare` checks the supplied baseline of 1,111 candidates: 639 drafts, 467
assessment holds, and 5 enrichment failures. It writes a deterministic queue
to `reports/catalog-codex-review/queue.json`.

## Evidence and reviews

`collect` retrieves the current repository record, README, complete license
file, up to ten additional root license files, one bounded referenced license
path, root contents, up to three recognized package manifests, one
documentation index when present, the latest commit, and up to ten releases.
It checks the stable GitHub repository ID and canonical name before saving
evidence. When an initial text bound would omit relevant material, the
collector recovers complete relevant README/documentation sections or stores a
bounded complete manifest or license as hashed parts. Each source retains its
full-file SHA-256, repository file SHA, path, retrieval strategy, selected
sections, part counts, and observation time. Each GitHub response is limited to
2 MiB, retained license text to 150 KiB, and the complete evidence package to
500 KiB. A license file that exceeds the bound remains hash-tracked but
incomplete, which blocks approval when it is needed to resolve license scope.

For a long README, complete selected sections must cover product identity,
capabilities, and usage; build or development evidence can come from a complete
manifest, documentation, or the root source/test/build inventory. The review
does not require running the software or tests. If the first README excerpt is
not enough, collection extracts the relevant sections from the full fetched
file and preserves the full-file hash. Citations for multipart README, manifest,
and license evidence must cover every retained part used by the decision.

Collection also reads the current Outlist `repositories`,
`repository_candidates`, and `projects` tables without changing them. It saves a
hash-verified snapshot in `catalog-snapshots/` and checks stable repository
IDs, canonical identities, imported candidates, project associations, and
published listings. GitHub parent/source and mirror metadata is compared with
those records. A snapshot must be no more than 24 hours old. If the live read
fails, only a verified snapshot from the last 24 hours can substitute;
otherwise duplicate identity remains a material blocker. An imported
candidate's own repository row and its own project are recorded as the current
listing, not as a duplicate public product. The snapshot keeps an envelope hash
and a stable data hash so a new timestamp does not invalidate cached evidence
when the catalog identities have not changed; a changed catalog forces fresh
evidence collection.

The evidence files retain source URLs, observation times, content hashes,
fetched text, duplicate-check results, and bounded metadata. Collection is
serial and pauses on GitHub rate limits. A `GITHUB_TOKEN` environment variable
can raise GitHub's API limit; it is not an AI credential and is optional for a
small run. Catalog reads use the existing Supabase environment as read-only
queries.

`run` executes one `codex exec` review by default, using `gpt-6-luna`, medium
reasoning effort, a read-only sandbox, ephemeral session storage, and the
checked-in JSON Schema. The JSON result is validated with Zod and every source
citation must resolve to an available source in the saved package. A separate
policy function can downgrade approve/reject recommendations to investigation.
Only the accepted review result and policy decision are marked completed.

```bash
bun run catalog:review -- collect --max-items 1
bun run catalog:review -- run --max-items 1
bun run catalog:review -- run --start-at 1 --max-items 1
```

Local checkpoints live under `reports/catalog-codex-review/`: `evidence/`,
`attempts/`, `reviews/`, and one latest `records/` row per candidate. The runner
records the review ID, source hash and timestamp, Codex CLI version, model,
policy version, status, elapsed time, and token counts when the CLI emits them.
An unchanged completed review is skipped. Failed, malformed, interrupted, or
rate-limited work remains resumable and cannot become an editorial decision.

The deterministic policy requires current public repository metadata, complete
product identity/capability/usage README evidence, the full license text and
corroborating repository or explicit project-level license metadata, an
OSI-approved identifier from the pinned SPDX list, source/build/test evidence,
a fresh Outlist identity check, and citations before recommending approval. A
license download or SPDX value by itself is insufficient. `NOASSERTION` and
legacy generic license labels can be resolved by a complete license plus an
explicit matching project-level README, package declaration, or license-scope
notice; version scope must remain exact. The single SPDX field cannot flatten
multiple non-equivalent license choices. Uncertainty is split into material blockers and
informational notes: unresolved license, repository identity, source-safety,
essential functionality, or duplicate evidence blocks approval. Omitted
unrelated documentation, a missing README development section when build
evidence exists elsewhere, and an unperformed security audit are informational
when the required evidence is otherwise strong. A partial collector label
alone does not block approval when all required evidence sources are complete.

## Runtime access boundary

The operator shell must be able to launch the authenticated child CLI. Run
`doctor` before collection or review: it checks `codex login status` and sends
one schema-constrained smoke request with `--sandbox read-only`. It does not
loosen sandbox settings or try to extract stored credentials. Review records
are local until the automated-review migration is deployed and the production
policy is explicitly enabled. The review runner can make bounded read-only
catalog queries for duplicate checking; it has no database write or
publication capability.

Production evidence and publication operations are intentionally implemented
in separate service-role procedures. They require the distinct `codex_automated`
reviewer identity, a current review record, project-specific evidence hashes,
and explicit policy authorization. The human administrator workflow remains
separate.

## Publication executor

The publication executor is a separate command from `catalog:review`. It reads
only completed local review records, revalidates their evidence hashes and
deterministic policy result, then calls narrow Supabase RPCs. It never accepts
SQL from Codex output. By default it is a local dry run:

```bash
bun run catalog:publish -- --out-dir reports/catalog-codex-review
```

Production execution requires a deployed migration, the explicitly enabled
Codex policy authorization ID, the exact production project reference, and
Supabase service and anonymous keys. It processes one project at a time by
default and confirms each publish through the anonymous catalog search API.
The executor never enables the policy itself. Do not execute it until the
policy migration and production publication have been explicitly authorized.

For an approved candidate whose audit record has no project draft, the
executor uses a separate service-role RPC to restore one. It accepts only a
successfully enriched GitHub candidate with current, complete source-backed
assessment evidence. It then applies the same Codex review under a revision
fence. Candidates with failed enrichment, restricted repositories, incomplete
evidence, or non-approval outcomes remain held and keep their review record.

```bash
bun run catalog:publish -- --execute \
  --confirm-project-ref hvunezhzpnpdkfiqgaaa \
  --authorization-id <authorization-uuid> \
  --max-items 1
```

When source data is refreshed, the database independently rechecks the stable
repository identity, current source observation, active category, current
license evidence, quality and license decisions, open review items, and the
project revision before publication. A later authoritative source change that
invalidates visibility, archive, availability, or approved-license evidence
automatically returns a published project to review and records a revocation.

## Payload recovery

The five terminal `database_payload_validation` candidates can be retried only
through an explicit candidate allowlist (up to five IDs). The SQL recovery
request is idempotent for that exact sorted set, does not reimport candidates,
and runs sequentially with five releases by default. Release names and tags are
bounded before the JSONB transaction payload is constructed, addressing the
observed 1 MiB release-payload failure.

```bash
bun run enrich -- --execute \
  --recover-candidate-id <candidate-uuid> \
  --recover-candidate-id <candidate-uuid>
```
