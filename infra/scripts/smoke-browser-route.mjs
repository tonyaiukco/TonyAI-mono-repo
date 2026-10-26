/** Sweden browser transport: no redirect may forward a login body or token. */
export async function routeSweden(route, origins) {
  if (!origins.has(new URL(route.request().url()).origin)) return route.abort();
  try {
    // Playwright continue() need not route a redirect again. Fetch once, refuse
    // every redirect and fulfill the original response without following it.
    const response = await route.fetch({ maxRedirects: 0, timeout: 60_000 });
    if (response.status() >= 300 && response.status() < 400) return route.abort();
    return route.fulfill({ response });
  } catch {
    return route.abort();
  }
}
