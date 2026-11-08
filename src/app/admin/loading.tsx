export default function LoadingAdmin() {
  return <main className="container page" aria-busy="true" role="status">
    <p className="muted">Loading administrator workspace…</p>
    <div className="animate-pulse" aria-hidden="true">
      <div className="h-8 w-64 rounded bg-secondary" />
      <div className="mt-5 h-4 w-96 max-w-full rounded bg-secondary" />
      <div className="mt-8 h-10 w-full rounded bg-secondary" />
      <div className="table-scroll mt-5">
        {Array.from({ length: 6 }, (_, index) => <div key={index} className="h-14 border-b border-border bg-secondary/40" />)}
      </div>
    </div>
  </main>;
}
