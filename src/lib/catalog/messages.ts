export function publicCatalogErrorDescription(error: unknown): string {
  if (error instanceof Error && error.message.includes("Supabase public configuration")) {
    return "The public catalog is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env.local, then restart the app.";
  }
  if (error instanceof Error && error.name === "PublicCatalogInputError") {
    return "This search request could not be applied. Use up to 120 characters and no more than eight search terms, then try again.";
  }
  return "Supabase could not return the current published catalog. Try again shortly. No sample projects are being shown.";
}

export function publicCatalogErrorTitle(error: unknown): string {
  return error instanceof Error && error.name === "PublicCatalogInputError"
    ? "Search request unavailable"
    : "Published catalog temporarily unavailable";
}
