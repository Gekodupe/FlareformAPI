import { requireSession } from '../lib/auth.ts';
import { jsonResponse } from '../lib/cors.ts';
import type { Env } from '../lib/env.ts';
import { readJsonBody } from '../lib/validate.ts';

function orderClause(sort: string): string {
  switch (sort) {
    case 'oldest':
      return ' ORDER BY s.created_at ASC';
    case 'project':
    case 'project_asc':
      return ' ORDER BY lower(p.name) ASC, s.created_at DESC';
    case 'project_desc':
      return ' ORDER BY lower(p.name) DESC, s.created_at DESC';
    case 'score':
    case 'count':
      return ' ORDER BY s.occurrence_count DESC, s.created_at DESC';
    case 'level':
      return ' ORDER BY lower(coalesce(s.level,\'\')) ASC, s.created_at DESC';
    case 'newest':
    default:
      return ' ORDER BY s.created_at DESC';
  }
}

export async function handleLogsRoutes(
  request: Request,
  env: Env,
  path: string
): Promise<Response | null> {
  if (!path.startsWith('/v1/logs')) return null;

  const session = await requireSession(request, env);
  if (!session.ok) return jsonResponse({ error: session.error }, 401, request, env);
  const email = session.email;

  if (path === '/v1/logs' && request.method === 'GET') {
    const url = new URL(request.url);
    const projectId = (url.searchParams.get('projectId') || '').trim();
    const filter = (url.searchParams.get('filter') || 'all').toLowerCase();
    const sort = (url.searchParams.get('sort') || 'newest').toLowerCase();
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 25) || 25));
    const offset = Math.max(0, Number(url.searchParams.get('offset') || 0) || 0);

    let sql =
      `SELECT s.id, s.project_id, s.payload_json, s.spam_score, s.is_spam, s.read_at,
              s.origin, s.created_at, s.fingerprint, s.occurrence_count, s.level,
              p.name AS project_name, p.logs_enabled
       FROM submissions s
       JOIN projects p ON p.id = s.project_id
       WHERE p.owner_email = ? AND s.kind = 'log'`;
    const binds: (string | number)[] = [email];

    if (projectId) {
      sql += ' AND s.project_id = ?';
      binds.push(projectId);
    }
    if (filter === 'unread') sql += ' AND s.read_at IS NULL';
    else if (filter === 'error')
      sql += ` AND lower(coalesce(s.level,'')) IN ('error','fatal','critical','exception')`;
    else if (filter === 'warn') sql += ` AND lower(coalesce(s.level,'')) IN ('warn','warning')`;

    sql += orderClause(sort) + ' LIMIT ? OFFSET ?';
    binds.push(limit, offset);

    const { results } = await env.DB.prepare(sql)
      .bind(...binds)
      .all();

    const items = (results || []).map((row: any) => {
      let payload: unknown = {};
      try {
        payload = JSON.parse(row.payload_json || '{}');
      } catch {
        payload = {};
      }
      return {
        id: row.id,
        projectId: row.project_id,
        projectName: row.project_name,
        payload,
        level: row.level || 'error',
        fingerprint: row.fingerprint,
        occurrenceCount: Number(row.occurrence_count || 1),
        spamScore: row.spam_score,
        isSpam: !!row.is_spam,
        readAt: row.read_at,
        origin: row.origin,
        createdAt: row.created_at,
        logsEnabled: !!row.logs_enabled
      };
    });

    return jsonResponse({ items, limit, offset, sort }, 200, request, env);
  }

  const match = path.match(/^\/v1\/logs\/([A-Za-z0-9_]+)$/);
  if (match && (request.method === 'PATCH' || request.method === 'PUT')) {
    const id = match[1];
    const owned = await env.DB.prepare(
      `SELECT s.id FROM submissions s
       JOIN projects p ON p.id = s.project_id
       WHERE s.id = ? AND p.owner_email = ? AND s.kind = 'log'`
    )
      .bind(id, email)
      .first();
    if (!owned) return jsonResponse({ error: 'Not found' }, 404, request, env);

    const parsed = await readJsonBody(request, 8 * 1024);
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status, request, env);

    if (parsed.body.read === true || parsed.body.markRead === true) {
      await env.DB.prepare(`UPDATE submissions SET read_at = datetime('now') WHERE id = ?`)
        .bind(id)
        .run();
    }
    if (parsed.body.read === false) {
      await env.DB.prepare(`UPDATE submissions SET read_at = NULL WHERE id = ?`).bind(id).run();
    }

    return jsonResponse({ ok: true, id }, 200, request, env);
  }

  if (match && request.method === 'DELETE') {
    const id = match[1];
    const owned = await env.DB.prepare(
      `SELECT s.id FROM submissions s
       JOIN projects p ON p.id = s.project_id
       WHERE s.id = ? AND p.owner_email = ? AND s.kind = 'log'`
    )
      .bind(id, email)
      .first();
    if (!owned) return jsonResponse({ error: 'Not found' }, 404, request, env);
    await env.DB.prepare('DELETE FROM submissions WHERE id = ?').bind(id).run();
    return jsonResponse({ ok: true }, 200, request, env);
  }

  return jsonResponse({ error: 'Not found' }, 404, request, env);
}
