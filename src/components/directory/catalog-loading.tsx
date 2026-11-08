export function CatalogLoading({ label = "Loading directory" }: { label?: string }) {
  return <main className="container page" aria-busy="true" aria-label={label}>
    <div className="eyebrow muted">{label}</div>
    <div className="mt-4 h-9 w-56 animate-pulse rounded-md bg-secondary" />
    <div className="cards-grid mt-10">{Array.from({ length: 6 }, (_, index) =>
      <div key={index} className="project-card animate-pulse">
        <div className="h-10 w-10 rounded-lg bg-secondary" />
        <div className="mt-5 h-4 w-3/4 rounded bg-secondary" />
        <div className="mt-3 h-4 w-1/2 rounded bg-secondary" />
      </div>,
    )}</div>
  </main>;
}
