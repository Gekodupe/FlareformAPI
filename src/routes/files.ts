import { jsonResponse, ingestCorsHeaders } from '../lib/cors.ts';
import type { Env } from '../lib/env.ts';

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
  const meta = (await env.FLAREFORM.get('filemeta:' + id, 'json')) as {
    contentType?: string;
    name?: string;
    size?: number;
  } | null;
  if (!meta) return jsonResponse({ error: 'Not found' }, 404, request, env);

  const bytes = await env.FLAREFORM.get('file:' + id, 'arrayBuffer');
  if (!bytes) return jsonResponse({ error: 'Not found' }, 404, request, env);

  const headers = new Headers(ingestCorsHeaders(request));
  headers.set('Content-Type', meta.contentType || 'application/octet-stream');
  headers.set('Cache-Control', 'public, max-age=86400');
  if (meta.name) {
    headers.set('Content-Disposition', 'inline; filename="' + meta.name.replace(/"/g, '') + '"');
  }
  if (request.method === 'HEAD') {
    headers.set('Content-Length', String(meta.size || bytes.byteLength));
    return new Response(null, { status: 200, headers });
  }
  return new Response(bytes, { status: 200, headers });
}
