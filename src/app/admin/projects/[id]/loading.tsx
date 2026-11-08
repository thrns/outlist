export default function LoadingProjectReview() {
  return <main className="container page" aria-busy="true" role="status">
    <p className="muted">Loading project evidence and review history…</p>
    <div className="animate-pulse" aria-hidden="true">
      <div className="h-8 w-80 max-w-full rounded bg-secondary" />
      <div className="mt-3 h-4 w-96 max-w-full rounded bg-secondary" />
      <div className="mt-8 h-52 rounded-xl bg-secondary/50" />
      <div className="mt-5 h-40 rounded-xl bg-secondary/50" />
      <div className="mt-5 h-60 rounded-xl bg-secondary/50" />
    </div>
  </main>;
}
