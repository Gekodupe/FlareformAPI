import { requireSession } from '../lib/auth.ts';
import { jsonResponse } from '../lib/cors.ts';
import type { Env } from '../lib/env.ts';

export async function handleAnalyticsRoutes(
  request: Request,
  env: Env,
  path: string
): Promise<Response | null> {
  if (path !== '/v1/analytics' && path !== '/v1/overview') return null;
  if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405, request, env);

  const session = await requireSession(request, env);
  if (!session.ok) return jsonResponse({ error: session.error }, 401, request, env);
  const email = session.email;

  const url = new URL(request.url);
  const projectId = (url.searchParams.get('projectId') || '').trim();
  const days = Math.min(90, Math.max(7, Number(url.searchParams.get('days') || 30) || 30));

  let projectFilter = '';
  const binds: (string | number)[] = [email];
  if (projectId) {
    projectFilter = ' AND s.project_id = ?';
    binds.push(projectId);
  }

  const totals = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN coalesce(s.kind,'form') = 'form' THEN 1 ELSE 0 END) AS forms,
       SUM(CASE WHEN s.kind = 'log' THEN 1 ELSE 0 END) AS logs,
       SUM(CASE WHEN coalesce(s.kind,'form') = 'form' AND s.is_spam = 1 THEN 1 ELSE 0 END) AS spam,
       SUM(CASE WHEN s.read_at IS NULL THEN 1 ELSE 0 END) AS unread
     FROM submissions s
     JOIN projects p ON p.id = s.project_id
     WHERE p.owner_email = ?` + projectFilter
  )
    .bind(...binds)
    .first<{ total: number; forms: number; logs: number; spam: number; unread: number }>();

  const dayBinds: (string | number)[] = [email, days];
  let dayFilter = '';
  if (projectId) {
    dayFilter = ' AND s.project_id = ?';
    dayBinds.push(projectId);
  }

  const { results: byDay } = await env.DB.prepare(
    `SELECT date(s.created_at) AS day,
            COUNT(*) AS total,
            SUM(CASE WHEN coalesce(s.kind,'form') = 'form' AND s.is_spam = 1 THEN 1 ELSE 0 END) AS spam,
            SUM(CASE WHEN s.kind = 'log' THEN 1 ELSE 0 END) AS logs
     FROM submissions s
     JOIN projects p ON p.id = s.project_id
     WHERE p.owner_email = ?
       AND s.created_at >= datetime('now', ?)
       ${dayFilter}
     GROUP BY date(s.created_at)
     ORDER BY day ASC`
  )
    .bind(email, '-' + days + ' days', ...(projectId ? [projectId] : []))
    .all();

  const { results: recent } = await env.DB.prepare(
    `SELECT s.id, s.project_id, s.spam_score, s.is_spam, s.created_at, s.origin, s.kind, p.name AS project_name,
            substr(s.payload_json, 1, 200) AS payload_preview
     FROM submissions s
     JOIN projects p ON p.id = s.project_id
     WHERE p.owner_email = ?` +
      projectFilter +
      `
     ORDER BY s.created_at DESC LIMIT 8`
  )
    .bind(...binds)
    .all();

  const projectCount = await env.DB.prepare(
    'SELECT COUNT(*) AS c FROM projects WHERE owner_email = ?'
  )
    .bind(email)
    .first<{ c: number }>();

  return jsonResponse(
    {
      totals: {
        submissions: Number(totals?.forms || 0),
        forms: Number(totals?.forms || 0),
        logs: Number(totals?.logs || 0),
        spam: Number(totals?.spam || 0),
        unread: Number(totals?.unread || 0),
        projects: Number(projectCount?.c || 0)
      },
      byDay: byDay || [],
      recent: recent || [],
      days
    },
    200,
    request,
    env
  );
}
