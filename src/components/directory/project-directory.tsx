"use client";

import { Fragment, useState, type FormEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { PublicCatalogCategory, PublicCatalogFacets, PublicCatalogProjectView, PublicCatalogSearchResult } from "@/lib/catalog/public";
import type { DirectoryState } from "@/lib/catalog/query-state";
import { directoryUrl } from "@/lib/catalog/query-state";
import { Glyph } from "@/components/project/glyph";
import { ProjectCard } from "@/components/project/project-card";
import { Breadcrumb } from "@/components/layout/breadcrumb";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { NativeSelect } from "@/components/ui/native-select";
import { EmptyState } from "@/components/ui/empty-state";

type FilterField = "categories" | "licenses" | "languages";

export function ProjectDirectory({ state, results, categories, facets, category }: {
  state: DirectoryState;
  results: Omit<PublicCatalogSearchResult, "items"> & { items: PublicCatalogProjectView[] };
  categories: PublicCatalogCategory[];
  facets: PublicCatalogFacets;
  category?: PublicCatalogCategory;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [query, setQuery] = useState(state.query);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const selected = {
    categories: state.categories,
    licenses: state.licenses,
    languages: state.languages,
  };
  const selectionCount = selected.categories.length + selected.licenses.length + selected.languages.length;
  const totalPages = Math.min(1000, Math.max(1, Math.ceil(results.totalCount / results.pageSize)));
  const currentPage = results.page;
  const hasActiveFilters = Boolean(state.query || selectionCount || state.sort !== "relevance" || state.page > 1);

  function navigate(patch: Partial<DirectoryState>) {
    const next = { ...state, ...patch };
    if (patch.page === undefined) next.page = 1;
    router.push(directoryUrl(pathname, next), { scroll: false });
  }

  function clearFilters() {
    setQuery("");
    navigate({ query: "", categories: [], licenses: [], languages: [], sort: "relevance", page: 1 });
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate({ query: query.trim(), page: 1 });
  }

  function choose(field: FilterField, value: string, checked: boolean) {
    const values = selected[field];
    const next = checked ? [...values, value] : values.filter((item) => item !== value);
    navigate({ [field]: next } as Partial<DirectoryState>);
  }

  function renderFilters(field: FilterField, items: Array<{ id: string; name: string; count?: number }>) {
    return items.map((item) => {
      const id = "filter-" + (category?.slug ?? "all") + "-" + field + "-" + item.id;
      return <label className="check-row" htmlFor={id} key={item.id}>
        <Checkbox
          id={id}
          checked={selected[field].includes(item.id)}
          onCheckedChange={(checked) => choose(field, item.id, checked === true)}
          aria-label={"Filter " + field + " by " + item.name}
        />
        <span>{item.name}</span>
        {item.count !== undefined && <strong>{item.count}</strong>}
      </label>;
    });
  }

  const categoriesWithCounts = categories.map((item) => ({
    id: item.slug,
    name: item.name,
    count: facets.categoryCounts.find((count) => count.slug === item.slug)?.projectCount ?? 0,
  }));
  const categoryHasProjects = category
    ? (facets.categoryCounts.find((count) => count.slug === category.slug)?.projectCount ?? 0) > 0
    : false;
  const licenseOptions = [...new Set([...facets.licenses, ...state.licenses])].sort().map((value) => ({ id: value, name: value }));
  const languageOptions = [...new Set([...facets.languages, ...state.languages])].sort((a, b) => a.localeCompare(b)).map((value) => ({ id: value, name: value }));
  const pageNumbers = [...new Set([1, currentPage - 2, currentPage - 1, currentPage, currentPage + 1, currentPage + 2, totalPages]
    .filter((value) => value >= 1 && value <= totalPages))].sort((a, b) => a - b);

  return (
    <main className="container page">
      {category
        ? <>
          <Breadcrumb items={[{ label: "Home", href: "/" }, { label: "Categories", href: "/categories" }, { label: category.name }]} />
          <div className="category-hero">
            <span className="category-icon" style={{ height: 56, width: 56 }}><Glyph name={category.icon} size="lg" /></span>
            <div>
              <h1>{category.name}</h1>
              <p>{category.description}</p>
              <Badge variant="outline">{results.totalCount} matching projects</Badge>
            </div>
          </div>
        </>
        : <div className="page-head">
          <div>
            <div className="eyebrow muted">Published open-source catalog</div>
            <h1 className="page-title">Explore projects</h1>
            <p className="muted" style={{ margin: 0 }}>Search and filter projects published in the Outlist catalog.</p>
          </div>
          <Button asChild variant="outline"><Link href="/submit"><Glyph name="plus" /> Submit project</Link></Button>
        </div>}

      <div className="filter-layout">
        <aside id="directory-filters" className={"filters" + (filtersOpen ? " open" : "")} aria-label="Directory filters">
          <div className="filter-top">
            <strong>Filters {selectionCount > 0 && <Badge>{selectionCount}</Badge>}</strong>
            <Button type="button" variant="ghost" size="sm" onClick={clearFilters} disabled={!hasActiveFilters}>Clear all</Button>
          </div>
          {!category && <div className="filter-group"><h3>Categories</h3>{renderFilters("categories", categoriesWithCounts)}</div>}
          <div className="filter-group"><h3>License</h3>{renderFilters("licenses", licenseOptions)}</div>
          <div className="filter-group"><h3>Language</h3>{renderFilters("languages", languageOptions)}</div>
          <div className="fine muted">Filters use the currently published catalog.</div>
        </aside>

        <div>
          <div className="results-toolbar">
            <form className="filter-search" role="search" onSubmit={submitSearch}>
              <Glyph name="search" />
              <input
                type="search"
                aria-label="Search directory projects"
                value={query}
                maxLength={120}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search projects..."
              />
              <Button type="submit" variant="ghost" size="icon" aria-label="Search published projects"><Glyph name="arrow" /></Button>
            </form>
            <div className="results-controls">
              <Button
                type="button"
                variant="outline"
                className="filters-mobile-button"
                onClick={() => setFiltersOpen((open) => !open)}
                aria-expanded={filtersOpen}
                aria-controls="directory-filters"
              >
                <Glyph name="filter" /> Filters{selectionCount > 0 && " (" + selectionCount + ")"}
              </Button>
              <label className="muted fine" htmlFor="directory-sort">Sort by</label>
              <NativeSelect id="directory-sort" value={state.sort} onChange={(event) => navigate({ sort: event.target.value as DirectoryState["sort"] })}>
                <option value="relevance">Relevance</option>
                <option value="stars">Most stars</option>
                <option value="updated">Recently updated</option>
                <option value="newest">Newest published</option>
                <option value="name">Name A–Z</option>
              </NativeSelect>
            </div>
          </div>

          {state.query.length > 0 && state.query.length < 3
            ? <p className="alert-inline" role="status">Enter at least 3 characters to search. No unrelated projects are shown.</p>
            : <div className="small muted" style={{ margin: "0 0 17px" }} aria-live="polite">
              Showing {results.totalCount > 0 ? (currentPage - 1) * results.pageSize + 1 : 0}–{Math.min(currentPage * results.pageSize, results.totalCount)} of {results.totalCount} projects
              {state.query && " matching “" + state.query + "”"}
            </div>}

          {results.items.length > 0
            ? <>
              <div className="cards-grid">{results.items.map((project) => <ProjectCard key={project.id} project={project} />)}</div>
              {totalPages > 1 && <nav className="pagination" aria-label="Project pages">
                <button type="button" disabled={currentPage === 1} aria-label="Previous page" onClick={() => navigate({ page: currentPage - 1 })}>‹</button>
                {pageNumbers.map((pageNumber, index) => <Fragment key={pageNumber}>
                  {index > 0 && pageNumber - pageNumbers[index - 1]! > 1 && <span className="pagination-ellipsis" key={"ellipsis-" + pageNumber} aria-hidden="true">…</span>}
                  <button type="button" aria-label={"Page " + pageNumber} aria-current={currentPage === pageNumber ? "page" : undefined} onClick={() => navigate({ page: pageNumber })}>{pageNumber}</button>
                </Fragment>)}
                <button type="button" disabled={!results.hasMore || currentPage >= 1000} aria-label="Next page" onClick={() => navigate({ page: currentPage + 1 })}>›</button>
              </nav>}
            </>
            : state.query.length > 0 && state.query.length < 3
              ? null
              : <EmptyState
                title={category
                  ? categoryHasProjects ? "No projects in this category match your search" : "No published projects in this category yet"
                  : results.totalCount === 0 && !hasActiveFilters ? "No published projects yet" : "No projects match your search"}
                description={category
                  ? categoryHasProjects
                    ? "Try a different search or clear some filters to see projects in this category."
                    : "Projects will appear here after they are reviewed and published in this category."
                  : results.totalCount === 0 && !hasActiveFilters
                    ? "Projects will appear here after they are reviewed and published."
                    : "Try a different search or clear some filters to see more published projects."}
              >
                {hasActiveFilters && <Button variant="outline" onClick={clearFilters}>Clear filters</Button>}
              </EmptyState>}
        </div>
      </div>
    </main>
  );
}
