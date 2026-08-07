import { requireSession } from '../lib/auth.ts';
import { jsonResponse } from '../lib/cors.ts';
import { keyPrefix, mintApiKey, randomToken, sha256Hex } from '../lib/crypto-util.ts';
import type { Env } from '../lib/env.ts';
import { PLANS } from '../lib/plans.ts';
import { countImagesThisMonth } from '../lib/media.ts';
import { getUser, putUser, userPlan } from '../lib/users.ts';
import { readJsonBody } from '../lib/validate.ts';

function ensureUserShape(email: string, existing: any | null): any {
  const base = existing && existing.email ? existing : { email, createdAt: Date.now(), projectIds: [] };
  return {
    ...base,
    email,
    projectIds: Array.isArray(base.projectIds) ? base.projectIds : [],
    keyIds: Array.isArray(base.keyIds) ? base.keyIds : [],
    plan: base.plan || 'free',
    planStatus: base.planStatus || 'none',
    emailVerified: !!base.emailVerified
  };
}

async function listKeys(env: Env, keyIds: string[]) {
  const keys: Array<{ id: string; label: string; prefix: string; createdAt: number }> = [];
  for (const id of keyIds) {
    const meta = (await env.FLAREFORM.get('keymeta:' + id, 'json')) as {
      id?: string;
      label?: string;
      prefix?: string;
      createdAt?: number;
      revoked?: boolean;
    } | null;
    if (!meta || meta.revoked) continue;
    keys.push({
      id: meta.id || id,
      label: meta.label || 'Default',
      prefix: meta.prefix || '',
      createdAt: Number(meta.createdAt || 0)
    });
  }
  return keys;
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
    const keys = await listKeys(env, user.keyIds || []);
    const imagesUsed = await countImagesThisMonth(env, email);

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
        keys,
        usage: {
          projects: Number(countRow?.c || 0),
          maxProjects: limits.maxProjects,
          submissions30d: Number(subRow?.c || 0),
          submissionsLimit: limits.submissionsPerMonth,
          imagesMonth: imagesUsed,
          imagesLimit: limits.imagesPerMonth,
          keys: keys.length,
          maxKeys: limits.maxKeys
        }
      },
      200,
      request,
      env
    );
  }

  if (path === '/v1/account/keys' && request.method === 'GET') {
    return jsonResponse({ keys: await listKeys(env, user.keyIds || []) }, 200, request, env);
  }

  if (path === '/v1/account/keys' && request.method === 'POST') {
    const plan = userPlan(user);
    const maxKeys = PLANS[plan].limits.maxKeys;
    if (maxKeys <= 0) {
      return jsonResponse(
        { error: 'API keys require a signed-in Free plan or higher.', code: 'plan_required', plan },
        403,
        request,
        env
      );
    }
    if ((user.keyIds || []).length >= maxKeys) {
      return jsonResponse(
        {
          error: 'Key limit reached for ' + PLANS[plan].name + ' (' + maxKeys + ').',
          code: 'key_limit',
          plan
        },
        403,
        request,
        env
      );
    }
    if (!user.emailVerified) {
      return jsonResponse(
        { error: 'Verify your email before creating API keys.', code: 'email_unverified' },
        403,
        request,
        env
      );
    }

    const parsed = await readJsonBody(request, 8 * 1024);
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status, request, env);
    const label = String(parsed.body.label || 'Default').trim().slice(0, 64) || 'Default';

    const raw = mintApiKey();
    const hash = await sha256Hex(raw);
    const id = randomToken(8);
    const createdAt = Date.now();

    await env.FLAREFORM.put(
      'keyhash:' + hash,
      JSON.stringify({ email, keyId: id, id, label, createdAt, revoked: false })
    );
    await env.FLAREFORM.put(
      'keymeta:' + id,
      JSON.stringify({
        email,
        id,
        keyId: id,
        label,
        createdAt,
        prefix: keyPrefix(raw),
        hash,
        revoked: false
      })
    );

    user.keyIds = [...(user.keyIds || []), id];
    await putUser(env, user);

    return jsonResponse(
      {
        ok: true,
        apiKey: raw,
        key: { id, label, prefix: keyPrefix(raw), createdAt, secret: raw },
        warning: 'Copy this key now. It will not be shown again.'
      },
      201,
      request,
      env
    );
  }

  const delMatch = path.match(/^\/v1\/account\/keys\/([A-Za-z0-9]+)$/);
  if (delMatch && request.method === 'DELETE') {
    const id = delMatch[1];
    if (!(user.keyIds || []).includes(id)) {
      return jsonResponse({ error: 'Not found' }, 404, request, env);
    }
    const meta = (await env.FLAREFORM.get('keymeta:' + id, 'json')) as {
      hash?: string;
    } | null;
    if (meta?.hash) {
      await env.FLAREFORM.put(
        'keyhash:' + meta.hash,
        JSON.stringify({ email, keyId: id, id, revoked: true })
      );
    }
    await env.FLAREFORM.put(
      'keymeta:' + id,
      JSON.stringify({ ...(meta || {}), id, email, revoked: true })
    );
    user.keyIds = (user.keyIds || []).filter((k: string) => k !== id);
    await putUser(env, user);
    return jsonResponse({ ok: true }, 200, request, env);
  }

  return jsonResponse({ error: 'Not found' }, 404, request, env);
}
