import { jsonResponse, ingestCorsHeaders } from '../lib/cors.ts';
import type { Env } from '../lib/env.ts';
import { requireSession } from '../lib/auth.ts';
import type { StoredFileMeta } from '../lib/media.ts';

export async function handleFileRoutes(
  request: Request,
  env: Env,
  path: string
): Promise<Response | null> {
  const match = path.match(/^\/v1\/files\/([A-Za-z0-9_]+)$/);
  if (!match) return null;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: ingestCorsHeaders(request) });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonResponse({ error: 'Method not allowed' }, 405, request, env);
  }

  const id = match[1];
  const meta = (await env.FLAREFORM.get('filemeta:' + id, 'json')) as StoredFileMeta | null;
  if (!meta) return jsonResponse({ error: 'Not found' }, 404, request, env);

  const url = new URL(request.url);
  const token = (url.searchParams.get('t') || url.searchParams.get('token') || '').trim();
  let allowed = false;

  if (meta.token && token && token === meta.token) {
    allowed = true;
  } else {
    const session = await requireSession(request, env);
    if (session.ok && session.email === String(meta.ownerEmail || '').toLowerCase()) {
      allowed = true;
    }
  }

  if (!allowed) {
    // 404 to avoid confirming file existence to strangers
    return jsonResponse({ error: 'Not found' }, 404, request, env);
  }

  const bytes = await env.FLAREFORM.get('file:' + id, 'arrayBuffer');
  if (!bytes) return jsonResponse({ error: 'Not found' }, 404, request, env);

  const headers = new Headers(ingestCorsHeaders(request));
  headers.set('Content-Type', meta.contentType || 'application/octet-stream');
  // Token URLs are capability-based (emails); never publicly cache — tokens can leak via caches/Referer.
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  if (meta.name) {
    const safe = String(meta.name).replace(/["\r\n\\]/g, '');
    headers.set('Content-Disposition', 'inline; filename="' + safe + '"');
  }
  if (request.method === 'HEAD') {
    headers.set('Content-Length', String(meta.size || bytes.byteLength));
    return new Response(null, { status: 200, headers });
  }
  return new Response(bytes, { status: 200, headers });
}
