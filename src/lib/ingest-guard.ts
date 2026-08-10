/** Origin, body-size, and redirect guards for public form/log ingest. */

export const MAX_INGEST_JSON_BYTES = 256 * 1024;
export const MAX_INGEST_MULTIPART_BYTES = 12 * 1024 * 1024;

export function parseAllowedOrigins(raw: string): string[] {
  return String(raw || '')
    .split(/[,\n]+/)
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

export function contentLengthOk(request: Request, maxBytes: number): boolean {
  const cl = request.headers.get('Content-Length');
  if (!cl) return true;
  const n = Number(cl);
  return !Number.isFinite(n) || n <= maxBytes;
}

export function maxIngestBytes(request: Request): number {
  const ct = (request.headers.get('Content-Type') || '').toLowerCase();
  if (ct.includes('multipart/form-data')) return MAX_INGEST_MULTIPART_BYTES;
  return MAX_INGEST_JSON_BYTES;
}

export function assertIngestBodySize(
  request: Request
): { ok: true } | { ok: false; error: string; status: number } {
  const max = maxIngestBytes(request);
  if (!contentLengthOk(request, max)) {
    return { ok: false, error: 'Payload too large', status: 413 };
  }
  return { ok: true };
}

function originMatches(allowed: string[], candidate: string): boolean {
  if (!candidate) return false;
  const normalized = candidate.replace(/\/+$/, '');
  return allowed.some((a) => a === '*' || a === normalized);
}

/**
 * When the project has an allowlist:
 * - Browser Origin must match
 * - Missing Origin falls back to Referer origin (some clients)
 * - Neither present → allowed (server-side / curl posts)
 * Empty allowlist → open (documented; set origins in production)
 */
export function originDenied(
  allowedOriginsRaw: string,
  request: Request
): { denied: true; error: string } | { denied: false } {
  const allowed = parseAllowedOrigins(allowedOriginsRaw);
  if (!allowed.length) return { denied: false };

  const origin = (request.headers.get('Origin') || '').trim();
  if (origin) {
    if (!originMatches(allowed, origin)) {
      return { denied: true, error: 'Origin not allowed' };
    }
    return { denied: false };
  }

  const referer = (request.headers.get('Referer') || '').trim();
  if (referer) {
    try {
      const refOrigin = new URL(referer).origin;
      if (!originMatches(allowed, refOrigin)) {
        return { denied: true, error: 'Origin not allowed' };
      }
    } catch {
      return { denied: true, error: 'Origin not allowed' };
    }
  }

  return { denied: false };
}

/**
 * Allow redirects only to allowlisted origins (or APP/request origin when
 * allowlist is empty). Relative paths are resolved against a trusted base.
 */
export function safeRedirectUrl(
  nextRaw: string,
  opts: {
    allowedOriginsRaw: string;
    requestOrigin: string;
    appOrigin: string;
  }
): string | null {
  const next = String(nextRaw || '').trim();
  if (!next) return null;

  const allowed = parseAllowedOrigins(opts.allowedOriginsRaw);
  const fallbackBases = [opts.requestOrigin, opts.appOrigin]
    .map((s) => String(s || '').trim().replace(/\/+$/, ''))
    .filter(Boolean);

  let absolute: URL;
  if (next.startsWith('/') && !next.startsWith('//')) {
    let base: string | null = null;
    if (opts.requestOrigin) {
      const reqOk = allowed.length ? originMatches(allowed, opts.requestOrigin) : true;
      if (reqOk) base = opts.requestOrigin;
    }
    if (!base && allowed[0] && allowed[0] !== '*') base = allowed[0];
    if (!base) base = fallbackBases[0] || null;
    if (!base) return null;
    try {
      absolute = new URL(next, base.endsWith('/') ? base : base + '/');
    } catch {
      return null;
    }
  } else if (/^https?:\/\//i.test(next)) {
    try {
      absolute = new URL(next);
    } catch {
      return null;
    }
  } else {
    return null;
  }

  if (absolute.username || absolute.password) return null;
  if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return null;

  const targetOrigin = absolute.origin;
  if (allowed.length) {
    if (!originMatches(allowed, targetOrigin)) return null;
  } else if (!fallbackBases.some((b) => {
    try {
      return new URL(b).origin === targetOrigin;
    } catch {
      return b === targetOrigin;
    }
  })) {
    return null;
  }

  return absolute.toString();
}
