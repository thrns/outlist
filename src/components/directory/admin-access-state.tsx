export function AdminAccessState({
  status,
}: {
  status: "denied" | "configuration" | "service";
}) {
  const content = {
    denied: {
      title: "Administrator access denied",
      description:
        "This account is not approved for administrator access. Contact the site administrator if you need access.",
    },
    configuration: {
      title: "Administrator sign-in is not configured",
      description:
        "The server is missing the Supabase authentication configuration required for administrator access. Ask the site administrator to check the server settings.",
    },
    service: {
      title: "Administrator access could not be verified",
      description:
        "Supabase is unavailable or could not verify this request. Try again later or contact the site administrator.",
    },
  }[status];

  return (
    <main className="container page">
      <section className="form-card" style={{ maxWidth: 620, margin: "8vh auto" }}>
        <div className="eyebrow muted">Restricted workspace</div>
        <h1 className="page-title" style={{ marginTop: 8 }}>
          {content.title}
        </h1>
        <p className="muted" style={{ lineHeight: 1.7, marginBottom: 0 }}>
          {content.description}
        </p>
      </section>
    </main>
  );
}
