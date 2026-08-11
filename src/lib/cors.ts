const DEFAULT_ORIGINS = [
  'http://127.0.0.1:4173',
  'http://localhost:4173',
  'http://127.0.0.1:8787',
  'http://localhost:8787',
  'https://flareform.com',
  'https://www.flareform.com'
];

function originsFromEnv(env?: { APP_ORIGIN?: string; CORS_ORIGINS?: string }): string[] {
  const extra: string[] = [];
  if (env?.APP_ORIGIN) {
    try {
      extra.push(new URL(env.APP_ORIGIN).origin);
    } catch {
      /* ignore */
    }
  }
  if (env?.CORS_ORIGINS) {
    env.CORS_ORIGINS.split(/[,\s]+/).forEach((o) => {
      const v = String(o || '').trim().replace(/\/+$/, '');
      if (v) extra.push(v);
    });
  }
  return extra;
}

function isAllowedOrigin(origin: string, extraOrigins?: string[]): boolean {
  if (!origin) return false;
  const allow = new Set([...(extraOrigins || []), ...DEFAULT_ORIGINS]);
  if (allow.has(origin)) return true;
  if (/^https:\/\/([a-z0-9-]+\.)?flareform\.com$/i.test(origin)) return true;
  // Only this product's Pages host (and its preview subdomains), not any *.pages.dev
  if (/^https:\/\/([a-z0-9-]+\.)?flareform\.pages\.dev$/i.test(origin)) return true;
  return false;
}

export function corsHeaders(
  request: Request,
  env?: { APP_ORIGIN?: string; CORS_ORIGINS?: string }
): HeadersInit {
  const origin = request.headers.get('Origin') || '';
  const allowed = isAllowedOrigin(origin, originsFromEnv(env));

  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
  if (allowed) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  // Public ingest from arbitrary sites: echo Origin when present for /f/* handled separately
  return headers;
}

/** Permissive CORS for public form ingest endpoints. */
export function ingestCorsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin === 'null' ? '*' : origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

export function jsonResponse(
  data: unknown,
  status = 200,
  request?: Request,
  env?: { APP_ORIGIN?: string; CORS_ORIGINS?: string },
  extraHeaders?: HeadersInit
): Response {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  if (request) {
    const cors = corsHeaders(request, env);
    Object.entries(cors).forEach(([k, v]) => headers.set(k, v));
  }
  if (extraHeaders) {
    Object.entries(extraHeaders).forEach(([k, v]) => headers.set(k, String(v)));
  }
  return new Response(JSON.stringify(data), { status, headers });
}
