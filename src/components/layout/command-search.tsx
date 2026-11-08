"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/project/glyph";
import { ProjectLogo } from "@/components/project/project-logo";
import type { PublicCatalogCategory, PublicCatalogProjectView } from "@/lib/catalog/public";

interface CommandResults {
  projects: PublicCatalogProjectView[];
  categories: PublicCatalogCategory[];
  requiresLongerQuery: boolean;
  error?: string;
}

const emptyResults: CommandResults = { projects: [], categories: [], requiresLongerQuery: false };

export function CommandSearch({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CommandResults>(emptyResults);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const value = query.trim();
    if (!value) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch("/api/catalog/search?q=" + encodeURIComponent(value), {
          cache: "no-store",
          signal: controller.signal,
        });
        const data = await response.json() as CommandResults;
        if (!response.ok) throw new Error(data.error || "The published catalog could not be searched.");
        setResults(data);
      } catch (error) {
        if (controller.signal.aborted) return;
        setResults({ ...emptyResults, error: error instanceof Error ? error.message : "The published catalog could not be searched." });
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, query]);

  function go(path: string) {
    onOpenChange(false);
    router.push(path);
  }

  function openFirstResult() {
    const target = results.projects[0]
      ? "/project/" + results.projects[0].slug
      : results.categories[0]
        ? "/category/" + results.categories[0].slug
        : null;
    if (target) go(target);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} onOpenAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus(); }}>
        <DialogTitle className="sr-only">Search Outlist</DialogTitle>
        <DialogDescription className="sr-only">Search published projects and active categories. Press Enter to open the first result.</DialogDescription>
        <div className="command-input-row">
          <Glyph name="search" size="lg" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              const value = event.target.value;
              setQuery(value);
              setResults(emptyResults);
              setLoading(value.trim().length > 0);
            }}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); openFirstResult(); } }}
            aria-label="Search projects and categories"
            placeholder="Search published projects and categories..."
            autoComplete="off"
            type="search"
          />
          <Button variant="ghost" size="icon" onClick={() => onOpenChange(false)} aria-label="Close search"><Glyph name="close" /></Button>
        </div>
        <div className="command-results" aria-live="polite" aria-busy={loading}>
          {results.error && <div className="alert-inline" role="alert">{results.error}</div>}
          {results.projects.length > 0 && <>
            <div className="eyebrow muted" style={{ padding: "8px 10px" }}>Projects</div>
            {results.projects.map((project) => <button className="command-result" key={project.id} onClick={() => go("/project/" + project.slug)}>
              <ProjectLogo project={project} size="sm" />
              <span className="grow"><strong>{project.name}</strong><small>{project.summary} · {project.primaryCategory.name}</small></span>
              <Glyph name="chevron" size="sm" />
            </button>)}
          </>}
          {results.categories.length > 0 && <>
            <div className="eyebrow muted" style={{ padding: "10px 10px 6px" }}>Categories</div>
            {results.categories.map((category) => <button className="command-result" key={category.id} onClick={() => go("/category/" + category.slug)}>
              <span className="category-icon" style={{ height: 34, width: 34 }}><Glyph name={category.icon} size="sm" /></span>
              <span className="grow"><strong>{category.name}</strong><small>Explore published projects</small></span>
              <Glyph name="chevron" size="sm" />
            </button>)}
          </>}
          {results.requiresLongerQuery && <div className="empty-state" role="status" style={{ border: 0, padding: 24 }}>
            Search projects with at least 3 characters. Active categories can still match shorter text.
          </div>}
          {!results.error && query.trim().length > 0 && !loading && !results.requiresLongerQuery && results.projects.length === 0 && results.categories.length === 0
            && <div className="empty-state" style={{ border: 0, padding: 24 }}>No matching published projects or active categories.</div>}
          {!query.trim() && <div className="small muted" style={{ padding: "10px" }}>Start typing to search the published catalog.</div>}
        </div>
        <div className="command-footer">Enter to open first result · Esc to close · <span className="kbd">⌘ K</span> to search</div>
      </DialogContent>
    </Dialog>
  );
}
