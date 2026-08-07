import { requireSession } from '../lib/auth.ts';
import { jsonResponse } from '../lib/cors.ts';
import type { Env } from '../lib/env.ts';
import { PLANS } from '../lib/plans.ts';
import { getUser, putUser, userPlan } from '../lib/users.ts';

function ensureUserShape(email: string, existing: any | null): any {
  const base = existing && existing.email ? existing : { email, createdAt: Date.now(), projectIds: [] };
  return {
    ...base,
    email,
    projectIds: Array.isArray(base.projectIds) ? base.projectIds : [],
    plan: base.plan || 'free',
    planStatus: base.planStatus || 'none',
    emailVerified: !!base.emailVerified
  };
}

export async function handleAccountRoutes(
  request: Request,
  env: Env,
  path: string
): Promise<Response | null> {
  if (!path.startsWith('/v1/account')) return null;

  const session = await requireSession(request, env);
  if (!session.ok) {
    return jsonResponse({ error: session.error }, 401, request, env);
  }

  const email = session.email;
  const existing = await getUser(env, email);
  const user = ensureUserShape(email, existing);
  if (!existing) await putUser(env, user);

  if (path === '/v1/account' && request.method === 'GET') {
    const plan = userPlan(user);
    const limits = PLANS[plan].limits;
    const countRow = await env.DB.prepare(
      'SELECT COUNT(*) AS c FROM projects WHERE owner_email = ?'
    )
      .bind(email)
      .first<{ c: number }>();
    const subRow = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM submissions s
       JOIN projects p ON p.id = s.project_id
       WHERE p.owner_email = ? AND s.created_at >= datetime('now', '-30 days')`
    )
      .bind(email)
      .first<{ c: number }>();

    return jsonResponse(
      {
        email,
        plan,
        planName: PLANS[plan].name,
        planStatus: user.planStatus || 'none',
        paid: plan === 'starter' || plan === 'pro',
        emailVerified: !!user.emailVerified,
        hasPassword: !!user.passwordHash,
        createdAt: user.createdAt,
        limits,
        usage: {
          projects: Number(countRow?.c || 0),
          maxProjects: limits.maxProjects,
          submissions30d: Number(subRow?.c || 0),
          submissionsLimit: limits.submissionsPerMonth
        }
      },
      200,
      request,
      env
    );
  }

  return jsonResponse({ error: 'Not found' }, 404, request, env);
}
