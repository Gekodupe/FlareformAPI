import { requireSession, requireVerifiedEmail } from '../lib/auth.ts';
import { jsonResponse } from '../lib/cors.ts';
import { randomToken } from '../lib/crypto-util.ts';
import type { Env } from '../lib/env.ts';
import { planLimits, getUser, userPlan } from '../lib/users.ts';
import { PLANS } from '../lib/plans.ts';
import { deleteImagesForPayloads } from '../lib/media.ts';
import { readJsonBody } from '../lib/validate.ts';

function projectId(): string {
  return 'prj_' + randomToken(10);
}

function notifyFromBody(body: Record<string, unknown>, fallbackEmail: string) {
  const notifyEnabled =
    body.notifyEnabled === false || body.notify_enabled === false || body.notifyEnabled === 0
      ? 0
      : 1;
  // Notifications only go to the account owner (prevents abuse as an open relay)
  return { notifyEnabled, notifyEmail: fallbackEmail };
}

export async function handleProjectRoutes(
  request: Request,
  env: Env,
  path: string
): Promise<Response | null> {
  if (!path.startsWith('/v1/projects')) return null;

  const session = await requireSession(request, env);
  if (!session.ok) return jsonResponse({ error: session.error }, 401, request, env);
  const email = session.email;
  const browserOnly =
    request.method !== 'GET' &&
    (path === '/v1/projects' || /^\/v1\/projects\/[A-Za-z0-9_]+$/.test(path));
  if (browserOnly && session.via === 'api_key') {
    return jsonResponse(
      { error: 'Project changes require a browser session, not an API key' },
      403,
      request,
      env
    );
  }

  if (path === '/v1/projects' && request.method === 'GET') {
    const url = new URL(request.url);
    const sort = (url.searchParams.get('sort') || 'newest').toLowerCase();
    let orderBy = 'created_at DESC';
    if (sort === 'name' || sort === 'project') orderBy = 'lower(name) ASC';
    else if (sort === 'oldest') orderBy = 'created_at ASC';
    else if (sort === 'submissions' || sort === 'volume') {
      orderBy = 'submission_count DESC, created_at DESC';
    }

    const { results } = await env.DB.prepare(
      `SELECT id, name, allowed_origins, turnstile_enabled, notify_email, notify_enabled, logs_enabled,
              created_at, updated_at,
        (SELECT COUNT(*) FROM submissions s WHERE s.project_id = projects.id AND coalesce(s.kind,'form') = 'form') AS submission_count,
        (SELECT COUNT(*) FROM submissions s WHERE s.project_id = projects.id AND coalesce(s.kind,'form') = 'form' AND s.is_spam = 1) AS spam_count,
        (SELECT COUNT(*) FROM submissions s WHERE s.project_id = projects.id AND s.kind = 'log') AS log_count
       FROM projects WHERE owner_email = ? ORDER BY ${orderBy}`
    )
      .bind(email)
      .all();
    return jsonResponse({ projects: results || [], sort }, 200, request, env);
  }

  if (path === '/v1/projects' && request.method === 'POST') {
    const verified = await requireVerifiedEmail(env, email);
    if (!verified.ok) {
      return jsonResponse(
        { error: verified.error, code: verified.code },
        verified.status,
        request,
        env
      );
    }

    const parsed = await readJsonBody(request, 8 * 1024);
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status, request, env);
    const name = String(parsed.body.name || '').trim().slice(0, 120);
    if (!name) return jsonResponse({ error: 'Project name required' }, 400, request, env);

    const user = verified.user;
    const limits = planLimits(user);
    const countRow = await env.DB.prepare(
      'SELECT COUNT(*) AS c FROM projects WHERE owner_email = ?'
    )
      .bind(email)
      .first<{ c: number }>();
    if (Number(countRow?.c || 0) >= limits.maxProjects) {
      return jsonResponse(
        {
          error:
            'Project limit reached for ' +
            PLANS[userPlan(user)].name +
            ' (' +
            limits.maxProjects +
            '). Upgrade on Pricing.',
          code: 'project_limit'
        },
        403,
        request,
        env
      );
    }

    const id = projectId();
    const origins = String(parsed.body.allowedOrigins || parsed.body.allowed_origins || '')
      .trim()
      .slice(0, 2000);
    const turnstile = parsed.body.turnstileEnabled || parsed.body.turnstile_enabled ? 1 : 0;
    const logsEnabled = parsed.body.logsEnabled || parsed.body.logs_enabled ? 1 : 0;
    const notify = notifyFromBody(parsed.body, email);

    await env.DB.prepare(
      `INSERT INTO projects (id, owner_email, name, allowed_origins, turnstile_enabled, notify_email, notify_enabled, logs_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(id, email, name, origins, turnstile, notify.notifyEmail, notify.notifyEnabled, logsEnabled)
      .run();

    return jsonResponse(
      {
        ok: true,
        project: {
          id,
          name,
          allowed_origins: origins,
          turnstile_enabled: turnstile,
          notify_email: notify.notifyEmail,
          notify_enabled: notify.notifyEnabled,
          logs_enabled: logsEnabled,
          ingestPath: '/f/' + id,
          ingestUrl: '/f/' + id,
          logPath: '/l/' + id,
          logUrl: '/l/' + id
        }
      },
      201,
      request,
      env
    );
  }

  const match = path.match(/^\/v1\/projects\/([A-Za-z0-9_]+)$/);
  if (match) {
    const id = match[1];
    const row = await env.DB.prepare(
      'SELECT * FROM projects WHERE id = ? AND owner_email = ?'
    )
      .bind(id, email)
      .first();
    if (!row) return jsonResponse({ error: 'Project not found' }, 404, request, env);

    if (request.method === 'GET') {
      return jsonResponse({ project: row }, 200, request, env);
    }

    if (request.method === 'PATCH' || request.method === 'PUT') {
      const verified = await requireVerifiedEmail(env, email);
      if (!verified.ok) {
        return jsonResponse(
          { error: verified.error, code: verified.code },
          verified.status,
          request,
          env
        );
      }
      const parsed = await readJsonBody(request, 8 * 1024);
      if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status, request, env);
      const name =
        parsed.body.name != null
          ? String(parsed.body.name).trim().slice(0, 120)
          : String((row as any).name);
      if (!name) return jsonResponse({ error: 'Project name required' }, 400, request, env);
      const origins =
        parsed.body.allowedOrigins != null || parsed.body.allowed_origins != null
          ? String(parsed.body.allowedOrigins ?? parsed.body.allowed_origins)
              .trim()
              .slice(0, 2000)
          : String((row as any).allowed_origins || '');
      const turnstile =
        parsed.body.turnstileEnabled != null || parsed.body.turnstile_enabled != null
          ? parsed.body.turnstileEnabled || parsed.body.turnstile_enabled
            ? 1
            : 0
          : Number((row as any).turnstile_enabled || 0);
      const logsEnabled =
        parsed.body.logsEnabled != null || parsed.body.logs_enabled != null
          ? parsed.body.logsEnabled || parsed.body.logs_enabled
            ? 1
            : 0
          : Number((row as any).logs_enabled || 0);
      const notify =
        parsed.body.notifyEmail != null ||
        parsed.body.notify_email != null ||
        parsed.body.notifyEnabled != null ||
        parsed.body.notify_enabled != null
          ? notifyFromBody(parsed.body, email)
          : {
              notifyEmail: String((row as any).notify_email || email),
              notifyEnabled: Number((row as any).notify_enabled ?? 1)
            };

      await env.DB.prepare(
        `UPDATE projects SET name = ?, allowed_origins = ?, turnstile_enabled = ?,
         notify_email = ?, notify_enabled = ?, logs_enabled = ?, updated_at = datetime('now')
         WHERE id = ? AND owner_email = ?`
      )
        .bind(
          name,
          origins,
          turnstile,
          notify.notifyEmail,
          notify.notifyEnabled,
          logsEnabled,
          id,
          email
        )
        .run();

      return jsonResponse(
        {
          ok: true,
          project: {
            id,
            name,
            allowed_origins: origins,
            turnstile_enabled: turnstile,
            notify_email: notify.notifyEmail,
            notify_enabled: notify.notifyEnabled,
            logs_enabled: logsEnabled,
            ingestPath: '/f/' + id,
            logPath: '/l/' + id
          }
        },
        200,
        request,
        env
      );
    }

    if (request.method === 'DELETE') {
      const verified = await requireVerifiedEmail(env, email);
      if (!verified.ok) {
        return jsonResponse(
          { error: verified.error, code: verified.code },
          verified.status,
          request,
          env
        );
      }
      const { results: subs } = await env.DB.prepare(
        'SELECT payload_json FROM submissions WHERE project_id = ?'
      )
        .bind(id)
        .all<{ payload_json: string }>();
      await deleteImagesForPayloads(
        env,
        (subs || []).map((r) => r.payload_json)
      );
      await env.DB.prepare('DELETE FROM submissions WHERE project_id = ?').bind(id).run();
      await env.DB.prepare('DELETE FROM projects WHERE id = ? AND owner_email = ?')
        .bind(id, email)
        .run();
      return jsonResponse({ ok: true }, 200, request, env);
    }
  }

  return jsonResponse({ error: 'Not found' }, 404, request, env);
}
