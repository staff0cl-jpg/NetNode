/** Central API fetch: credentials + CSRF header for mutating requests. */
let csrfToken: string | null = null;

export function setNetnodeCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getNetnodeCsrfToken(): string | null {
  return csrfToken;
}

function mergeHeaders(init: RequestInit | undefined, extra: Record<string, string>): Headers {
  const h = new Headers(init?.headers as HeadersInit | undefined);
  for (const [k, v] of Object.entries(extra)) {
    if (!h.has(k)) h.set(k, v);
  }
  return h;
}

export async function netnodeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const method = (init.method || "GET").toUpperCase();
  const headers = mergeHeaders(init, {});
  if (csrfToken && !["GET", "HEAD", "OPTIONS"].includes(method) && !headers.has("X-CSRF-Token")) {
    headers.set("X-CSRF-Token", csrfToken);
  }
  return fetch(input, { credentials: "include", ...init, headers });
}
