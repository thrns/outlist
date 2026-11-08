import Link from "next/link";
import { Breadcrumb } from "@/components/layout/breadcrumb";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AdminActionSubmit } from "@/components/directory/admin-action-submit";
import {
  publishProject,
  resolveProjectReviewItem,
  saveProjectEditorial,
  setProjectReviewState,
  verifyProjectLicense,
  verifyProjectQuality,
} from "@/app/admin/actions";
import type { AdminProjectReview } from "@/lib/admin/review";
import type { Json } from "@/lib/supabase/database.types";

function object(value: Json | undefined): { [key: string]: Json | undefined } {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function json(value: Json | undefined) {
  return JSON.stringify(value ?? null, null, 2);
}

function errorText(code: string | undefined) {
  return ({
    invalid: "Some submitted fields are invalid or missing. Review the form values and try again.",
    permission: "Administrator access was revoked or could not be confirmed. Reload and sign in again.",
    stale: "Another administrator changed this project after this page loaded. Reload before trying again.",
    requirements: "The database rejected this decision because one or more publication requirements are not met.",
    validation: "The submitted values failed validation. Check the field limits and evidence requirements.",
    transition: "This project is no longer in a state that allows this action.",
    missing: "This project or review item no longer exists.",
    service: "The database action could not be completed. Authoritative project data was not changed.",
  } as Record<string, string>)[code ?? ""];
}

function resultText(code: string | undefined) {
  return ({
    saved: "Editorial changes saved to Supabase and recorded as overrides.",
    "license-verified": "Human license verification saved with independent evidence.",
    "quality-verified": "Quality review saved for the current source observation.",
    "review-updated": "Review decision saved.",
    "review-item-resolved": "Review item resolved and recorded in the audit trail.",
    published: "Project published. The public catalog can now read it under the existing RLS policy.",
  } as Record<string, string>)[code ?? ""];
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><div className="fine muted">{label}</div><div style={{ overflowWrap: "anywhere" }}>{children}</div></div>;
}

function Section({ title, children, note }: { title: string; children: React.ReactNode; note?: string }) {
  return <section className="surface" style={{ padding: 22, marginTop: 18 }}>
    <div className="section-head" style={{ marginBottom: 14 }}><div><h2 className="section-title" style={{ fontSize: 18 }}>{title}</h2>{note && <p className="section-subtitle">{note}</p>}</div></div>
    {children}
  </section>;
}

export function AdminProjectReview({ review, result, error }: { review: AdminProjectReview; result?: string; error?: string }) {
  const { project, repository, assessment } = review;
  const assessmentRoot = object(assessment?.result ?? undefined);
  const licenseAssessment = object(assessmentRoot.license);
  const qualityAssessment = object(assessmentRoot.quality);
  const classification = object(assessmentRoot.classification);
  const flags = Array.isArray(qualityAssessment.flags) ? qualityAssessment.flags : [];
  const suggestions = Array.isArray(classification.suggestions) ? classification.suggestions : [];
  const revision = project.editorial_revision;
  const canReview = project.publication_status === "draft" || project.publication_status === "pending_review";
  const letter = project.name.trim().slice(0, 1).toUpperCase() || project.slug.slice(0, 1).toUpperCase() || "?";

  return <main className="container page">
    <Breadcrumb items={[{ label: "Outlist", href: "/" }, { label: "Editorial review", href: "/admin" }, { label: project.name || project.slug }]} />
    <div className="page-head" style={{ marginTop: 14 }}>
      <div><h1 className="page-title">{project.name || "Unnamed project"}</h1><p className="muted" style={{ margin: 0 }}>Canonical project record: <span className="mono">{project.id}</span> · editorial revision {revision}</p></div>
      <div className="flex gap-2 flex-wrap"><Button asChild variant="outline"><Link href="/admin">Back to queue</Link></Button><Badge variant="dot">{project.publication_status.replaceAll("_", " ")}</Badge></div>
    </div>
    {resultText(result) && <div className="alert-inline" role="status"><strong>Saved.</strong> {resultText(result)}</div>}
    {errorText(error) && <div className="alert-inline" role="alert"><strong>Action not completed.</strong> {errorText(error)}</div>}

    <Section title="GitHub supplied evidence" note="These fields reflect provider observations. The detected license is not independent verification.">
      <div className="form-grid">
        <Meta label="Repository">{repository ? <a href={repository.canonical_url} target="_blank" rel="noreferrer">{repository.full_name} ↗</a> : "Primary repository missing"}</Meta>
        <Meta label="Stable GitHub repository ID">{repository?.provider_repository_id ?? "Not available"}</Meta>
        <Meta label="Source URL">{repository?.canonical_url ?? "Not available"}</Meta>
        <Meta label="Access / visibility">{repository ? `${repository.availability_status} · ${repository.visibility ?? "visibility unknown"} · ${repository.is_private === false ? "not private" : "private or unknown"} · ${repository.is_disabled === false ? "enabled" : "disabled or unknown"}` : "Not available"}</Meta>
        <Meta label="Description supplied by GitHub">{repository?.description ?? "Not supplied"}</Meta>
        <Meta label="Official website supplied by GitHub">{repository?.homepage_url ?? "Not supplied"}</Meta>
        <Meta label="Primary language">{repository?.primary_language ?? "Not observed"}</Meta>
        <Meta label="Stars and forks">{repository ? `${repository.stars.toLocaleString()} stars · ${repository.forks.toLocaleString()} forks` : "Not available"}</Meta>
        <Meta label="Archived / fork">{repository ? `${repository.is_archived ? "Archived" : "Not archived"} · ${repository.is_fork ? "fork" : "not a fork"}` : "Not available"}</Meta>
        <Meta label="Source observed">{repository?.source_observed_at ? new Date(repository.source_observed_at).toISOString() : "Not observed"}</Meta>
        <Meta label="Last successful sync">{repository?.last_successful_sync_at ? new Date(repository.last_successful_sync_at).toISOString() : "Not observed"}</Meta>
        <Meta label="Current GitHub license metadata">{repository?.source_license_metadata ? <pre className="fine mono" style={{ whiteSpace: "pre-wrap", margin: "4px 0" }}>{json(repository.source_license_metadata)}</pre> : "GitHub supplied no license metadata"}</Meta>
      </div>
      {repository && <>
        <div className="line" style={{ margin: "15px 0" }} />
        <div className="form-grid">
          <Meta label="Topics">{review.topics.length ? review.topics.map((topic) => <Badge key={topic.topic_key} style={{ margin: "2px 4px 2px 0" }}>{topic.source_topic}</Badge>) : "No topic observations"}</Meta>
          <Meta label="Languages by source bytes">{review.languages.length ? review.languages.map((language) => <span key={language.language_key} style={{ display: "block" }}>{language.language_name} · {language.bytes.toLocaleString()} bytes</span>) : "No language observations"}</Meta>
        </div>
        <div style={{ marginTop: 14 }}><strong className="small">Recent releases</strong>{review.releases.length ? <ul className="small">{review.releases.map((release) => <li key={release.id}><a href={release.release_url} target="_blank" rel="noreferrer">{release.release_name || release.version} ↗</a> · {release.published_at ? new Date(release.published_at).toISOString() : "date not supplied"}{release.is_draft ? " · draft" : ""}{release.is_prerelease ? " · pre-release" : ""}</li>)}</ul> : <p className="small muted">No release observations.</p>}</div>
      </>}
    </Section>

    <Section title="Source provenance and freshness" note="Only validated resource summaries are displayed here. Raw source response payloads remain private and are not rendered.">
      <p className="small muted">Assessment: {assessment?.status ?? "not available"}{assessment?.assessed_at ? ` · assessed ${new Date(assessment.assessed_at).toISOString()}` : ""}{assessment?.source_observed_at ? ` · observation ${new Date(assessment.source_observed_at).toISOString()}` : ""}</p>
      {review.sourceRecords.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Resource</th><th>Observed</th><th>HTTP</th><th>Validated</th><th>Source URL</th></tr></thead><tbody>{review.sourceRecords.map((source) => {
        const metadata = object(source.source_metadata);
        return <tr key={source.id}><td>{source.record_kind}<div className="fine muted mono">{source.source_key}</div></td><td>{new Date(source.fetched_at).toISOString()}</td><td>{source.http_status ?? "—"}</td><td>{metadata.validated === true ? "Yes" : "No"}</td><td><a href={source.source_url} target="_blank" rel="noreferrer">Open source ↗</a><div className="fine muted mono">{source.id}</div></td></tr>;
      })}</tbody></table></div> : <p className="small muted">No linked validated source records were found for the primary repository.</p>}
      <details style={{ marginTop: 14 }}><summary className="small semibold">Repository observation history</summary><ul className="fine muted">{review.snapshots.map((snapshot) => <li key={snapshot.id}>{snapshot.captured_at} · {snapshot.stars.toLocaleString()} stars · {snapshot.forks.toLocaleString()} forks</li>)}</ul></details>
    </Section>

    <Section title="Automated assessment" note="Assessment output is a review aid. It does not verify licensing or certify software quality.">
      <div className="form-grid">
        <Meta label="Assessment policy">{String(qualityAssessment.policyVersion ?? "Not available")}</Meta>
        <Meta label="Assessment result">{String(qualityAssessment.status ?? "Not available")} · priority {String(qualityAssessment.priority ?? "Not available")}</Meta>
        <Meta label="License assessment">{String(licenseAssessment.status ?? "Not available")}</Meta>
        <Meta label="Detected SPDX identifier">{String(licenseAssessment.identifier ?? "None")}</Meta>
      </div>
      {typeof licenseAssessment.explanation === "string" && <p className="small muted">{licenseAssessment.explanation}</p>}
      <h3 className="small semibold">Quality review flags ({flags.length})</h3>
      {flags.length ? <ul>{flags.map((flag, index) => {
        const item = object(flag);
        return <li key={`${String(item.code ?? "flag")}-${index}`}><strong>{String(item.severity ?? "signal")}: {String(item.code ?? "assessment flag")}</strong> — {String(item.explanation ?? "No explanation was supplied.")} {Array.isArray(item.evidence) && <span className="fine muted">[{item.evidence.map(String).join(", ")}]</span>}</li>;
      })}</ul> : <p className="small muted">No quality flags were returned with this assessment.</p>}
      <h3 className="small semibold">Suggested categories with classification evidence</h3>
      {suggestions.length ? <ul>{suggestions.map((suggestion, index) => {
        const item = object(suggestion);
        return <li key={`${String(item.categoryId ?? "category")}-${index}`}><span className="mono">{String(item.categoryId ?? "")}</span> · score {String(item.score ?? "—")} · {Array.isArray(item.evidence) ? item.evidence.map(String).join("; ") : "No evidence details"}</li>;
      })}</ul> : <p className="small muted">No category suggestions are available. Administrators may select active categories below.</p>}
    </Section>

    <Section title="Administrator verified evidence" note="These are deliberate human decisions tied to the source observation shown above.">
      <div className="form-grid">
        <Meta label="Current license status">{project.license_status}{project.license_identifier ? ` · ${project.license_identifier}` : ""}</Meta>
        <Meta label="License verified at">{project.license_verified_at ?? "Not verified"}</Meta>
        <Meta label="Quality status">{project.quality_status}</Meta>
        <Meta label="Last administrator verification">{project.last_verified_at ?? "Not verified"}</Meta>
        <Meta label="Logo status and fallback">{review.logos.length ? review.logos.map((logo) => `${logo.verification_status}${logo.is_primary ? " (primary)" : ""}`).join(" · ") : "No logo candidates"}{!review.logos.some((logo) => logo.verification_status === "approved") && ` · No approved logo; letter fallback “${letter}”.`}</Meta>
      </div>
      {review.decisions.length ? <div className="table-scroll" style={{ marginTop: 14 }}><table className="data-table"><thead><tr><th>Decision</th><th>State</th><th>Reason</th><th>Evidence</th><th>Time</th></tr></thead><tbody>{review.decisions.map((decision) => <tr key={decision.id}><td>{decision.action.replaceAll("_", " ")}<div className="fine muted">admin {decision.actor_user_id}</div></td><td>{decision.previous_state} → {decision.resulting_state}<div className="fine muted">revision {decision.resulting_revision}</div></td><td>{decision.reason}</td><td><pre className="fine mono" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{json(decision.evidence)}</pre></td><td>{new Date(decision.created_at).toISOString()}</td></tr>)}</tbody></table></div> : <p className="small muted">No administrator decisions have been recorded yet.</p>}
    </Section>

    <Section title="Safe editorial corrections" note="Project slug and repository identity stay fixed. Saved fields are stored as editorial overrides and survive source refreshes.">
      {canReview ? <form action={saveProjectEditorial}>
        <input type="hidden" name="projectId" value={project.id} /><input type="hidden" name="revision" value={revision} />
        <div className="form-grid">
          <div className="form-field"><label className="field-label" htmlFor="project-name">Project name</label><Input id="project-name" name="name" maxLength={120} required defaultValue={project.name} /></div>
          <div className="form-field"><label className="field-label" htmlFor="project-summary">Summary</label><Input id="project-summary" name="summary" minLength={10} maxLength={280} required defaultValue={project.summary} /></div>
          <div className="form-field full"><label className="field-label" htmlFor="project-description">Description</label><Textarea id="project-description" name="description" maxLength={10000} defaultValue={project.description} /></div>
          <div className="form-field full"><label className="field-label" htmlFor="project-website">Official website</label><Input id="project-website" name="officialWebsiteUrl" type="url" maxLength={2048} placeholder="https://example.org" defaultValue={project.official_website_url ?? ""} /></div>
          <div className="form-field full"><span className="field-label">Active categories</span><div className="flex gap-3 flex-wrap">{review.categories.map((category) => <label key={category.id} className="flex gap-2 items-center small"><input type="checkbox" name="categoryIds" value={category.id} defaultChecked={review.selectedCategoryIds.includes(category.id)} />{category.name}</label>)}</div><p className="form-help">Choose one or more active categories. Assessment suggestions are evidence; the administrator makes the selection.</p></div>
          <div className="form-field full"><label className="field-label" htmlFor="project-tags">Tags</label><Textarea id="project-tags" name="tags" rows={3} maxLength={900} defaultValue={review.tags.join("\n")} /><p className="form-help">One tag per line, up to 20 simple labels. Tags are editorial classifications.</p></div>
          <div className="form-field full"><label className="field-label" htmlFor="editorial-reason">Why are these corrections justified?</label><Textarea id="editorial-reason" name="reason" minLength={8} maxLength={1000} required placeholder="Describe the source or editorial basis for these changes." /></div>
        </div>
        <AdminActionSubmit pendingLabel="Saving corrections…">Save editorial corrections</AdminActionSubmit>
      </form> : <p className="small muted">Editorial fields are read-only in the current publication state. A rejected project must be explicitly returned to review first.</p>}
      {review.overrides.length > 0 && <details style={{ marginTop: 14 }}><summary className="small semibold">Existing editorial overrides</summary><ul>{review.overrides.map((override) => <li key={override.id}><code>{override.field_key}</code> = <code>{json(override.override_value)}</code> · approved {override.approved_at} by {override.approved_by}</li>)}</ul></details>}
    </Section>

    {canReview && <>
      <Section title="Human license verification" note="GitHub detection does not prove licensing. Inspect independent licensing evidence and record the basis for relying on it.">
        <form action={verifyProjectLicense}>
          <input type="hidden" name="projectId" value={project.id} /><input type="hidden" name="revision" value={revision} /><input type="hidden" name="sourceObservedAt" value={repository?.source_observed_at ?? ""} />
          <div className="form-grid">
            <div className="form-field"><label className="field-label" htmlFor="license-identifier">OSI-approved SPDX identifier</label><Input id="license-identifier" name="licenseIdentifier" required maxLength={128} placeholder="MIT" defaultValue={project.license_identifier ?? (typeof licenseAssessment.identifier === "string" ? licenseAssessment.identifier : "")} /><p className="form-help">Accepted identifiers come from the pinned SPDX list.</p></div>
            <div className="form-field"><label className="field-label" htmlFor="license-evidence">Independent evidence URL</label><Input id="license-evidence" name="evidenceReference" type="url" required maxLength={2048} placeholder="https://project.example/license" /></div>
            <div className="form-field full"><label className="field-label" htmlFor="license-reason">Reason for the decision</label><Textarea id="license-reason" name="reason" minLength={20} maxLength={1000} required placeholder="Describe the license text reviewed and why it supports this identifier." /></div>
            <label className="form-field full small flex gap-2 items-start"><input type="checkbox" name="confirmOpenSource" value="yes" required />I inspected the linked license evidence, confirm it supports this open-source identifier, and understand GitHub&apos;s detected license is not independent verification.</label>
          </div>
          <AdminActionSubmit pendingLabel="Recording license decision…">Record human license verification</AdminActionSubmit>
        </form>
      </Section>

      <Section title="Human quality review" note="This confirms minimum catalog quality after source review. It is not a security audit, code audit, or reliability guarantee.">
        <form action={verifyProjectQuality}>
          <input type="hidden" name="projectId" value={project.id} /><input type="hidden" name="revision" value={revision} /><input type="hidden" name="sourceObservedAt" value={repository?.source_observed_at ?? ""} />
          <div className="form-field"><label className="field-label" htmlFor="quality-reason">Review notes</label><Textarea id="quality-reason" name="reason" minLength={20} maxLength={1000} required placeholder="Describe the current repository availability and how relevant assessment flags were handled." /></div>
          <label className="form-field small flex gap-2 items-start"><input type="checkbox" name="confirmReview" value="yes" required />I reviewed the current repository availability, source evidence, and relevant assessment flags. This is a catalog review only.</label>
          <AdminActionSubmit pendingLabel="Recording quality review…">Record quality review</AdminActionSubmit>
        </form>
      </Section>
    </>}

    <Section title="Review queue" note="Open review items block publication until an administrator records their resolution.">
      {review.queueItems.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Reason</th><th>Target</th><th>Status</th><th>Created</th><th>Resolution</th></tr></thead><tbody>{review.queueItems.map((item) => <tr key={item.id}><td>{item.reason}</td><td>{item.project_id ? "Project" : item.repository_id ? "Repository" : "Assessment"}<div className="fine muted mono">{item.repository_id ?? item.assessment_id ?? item.id}</div></td><td>{item.status}</td><td>{new Date(item.created_at).toISOString()}</td><td>{item.status === "open" || item.status === "in_review" ? <form action={resolveProjectReviewItem}><input type="hidden" name="projectId" value={project.id} /><input type="hidden" name="queueId" value={item.id} /><input type="hidden" name="revision" value={revision} /><label className="fine" htmlFor={`resolve-${item.id}`}>Resolution reason</label><Input id={`resolve-${item.id}`} name="reason" minLength={8} maxLength={1000} required placeholder="Explain what was reviewed." /><AdminActionSubmit pendingLabel="Resolving…" size="sm" variant="outline" style={{ marginTop: 5 }}>Resolve item</AdminActionSubmit></form> : <span className="muted">Resolved {item.resolved_at ?? ""}</span>}</td></tr>)}</tbody></table></div> : <p className="small muted">No review queue items are linked to this project or primary repository.</p>}
    </Section>

    <Section title="Review outcome" note="Pending, review-required, rejected, and return-to-review decisions are recorded in the append-only audit trail.">
      <form action={setProjectReviewState}>
        <input type="hidden" name="projectId" value={project.id} /><input type="hidden" name="revision" value={revision} />
        <div className="form-field"><label className="field-label" htmlFor="review-decision">Decision</label><select className="select" id="review-decision" name="decision" defaultValue={project.publication_status === "rejected" ? "return_to_review" : "keep_pending"}>{project.publication_status === "rejected" ? <option value="return_to_review">Return rejected project to review</option> : <><option value="keep_pending">Keep pending with notes</option><option value="mark_review_required">Mark assessment or project review-required</option><option value="reject">Reject this draft</option></>}</select></div>
        <div className="form-field"><label className="field-label" htmlFor="review-reason">Reason or review notes</label><Textarea id="review-reason" name="reason" minLength={8} maxLength={1000} required placeholder="Record the editorial decision and any follow-up needed." /></div>
        <AdminActionSubmit pendingLabel="Saving review outcome…" variant={project.publication_status === "rejected" ? "default" : "outline"}>{project.publication_status === "rejected" ? "Return to review" : "Save review outcome"}</AdminActionSubmit>
      </form>
    </Section>

    {project.publication_status === "pending_review" && <Section title="Publish project" note="The service checks all eligibility rules atomically. No browser-submitted reviewer identity or verified status is trusted.">
      <form action={publishProject}>
        <input type="hidden" name="projectId" value={project.id} /><input type="hidden" name="revision" value={revision} />
        <div className="form-field"><label className="field-label" htmlFor="publish-reason">Publication decision notes</label><Textarea id="publish-reason" name="reason" minLength={8} maxLength={1000} required placeholder="Summarize why this project meets Outlist's publication policy." /></div>
        <AdminActionSubmit pendingLabel="Publishing project…">Publish project</AdminActionSubmit>
      </form>
    </Section>}
  </main>;
}
