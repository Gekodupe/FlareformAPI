import type { Env } from './env.ts';
import { sha256Hex } from './crypto-util.ts';
import { getUser } from './users.ts';

export function extractBearerToken(request: Request): string {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

export type SessionOk = { ok: true; sessionId: string; email: string; via: 'session' | 'api_key' };
export type SessionFail = { ok: false; error: string };

/** Invalidate all tracked browser sessions for an email (e.g. after password reset). */
export async function revokeSessionsForEmail(env: Env, email: string): Promise<void> {
  const normalized = String(email || '').toLowerCase();
  if (!normalized) return;
  const listKey = 'sessions:' + normalized;
  const list = ((await env.FLAREFORM.get(listKey, 'json')) as string[] | null) || [];
  for (const id of list) {
    if (id) await env.FLAREFORM.delete('session:' + id);
  }
  await env.FLAREFORM.delete(listKey);
}

/** Revoke all API keys for a user (password reset / compromise response). */
export async function revokeApiKeysForUser(env: Env, user: { email?: string; keyIds?: string[] }): Promise<void> {
  const email = String(user.email || '').toLowerCase();
  const keyIds = Array.isArray(user.keyIds) ? user.keyIds : [];
  for (const id of keyIds) {
    const meta = (await env.FLAREFORM.get('keymeta:' + id, 'json')) as { hash?: string } | null;
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
  }
}

export async function requireSession(request: Request, env: Env): Promise<SessionOk | SessionFail> {
  const token = extractBearerToken(request);
  if (!token) return { ok: false, error: 'Sign in required' };

  if (token.indexOf('sess_') === 0) {
    try {
      const session = (await env.FLAREFORM.get('session:' + token, 'json')) as
        | { email?: string; exp?: number; v?: number }
        | null;
      if (!session || !session.email) return { ok: false, error: 'Sign in required' };
      if (session.exp && session.exp < Date.now()) {
        await env.FLAREFORM.delete('session:' + token);
        return { ok: false, error: 'Session expired' };
      }
      const email = String(session.email).toLowerCase();
      const user = await getUser(env, email);
      const currentV = Number(user?.sessionVersion || 0);
      if (Number(session.v || 0) !== currentV) {
        await env.FLAREFORM.delete('session:' + token);
        return { ok: false, error: 'Session expired' };
      }
      return { ok: true, sessionId: token, email, via: 'session' };
    } catch {
      return { ok: false, error: 'Sign in required' };
    }
  }

  if (token.indexOf('ff_live_') === 0) {
    try {
      const hash = await sha256Hex(token);
      const meta = (await env.FLAREFORM.get('keyhash:' + hash, 'json')) as
        | { email?: string; keyId?: string; revoked?: boolean }
        | null;
      if (!meta || !meta.email || meta.revoked) return { ok: false, error: 'Invalid API key' };
      return {
        ok: true,
        sessionId: 'key:' + (meta.keyId || hash.slice(0, 8)),
        email: String(meta.email).toLowerCase(),
        via: 'api_key'
      };
    } catch {
      return { ok: false, error: 'Invalid API key' };
    }
  }

  return { ok: false, error: 'Sign in required' };
}

export type VerifiedOk = { ok: true; user: any };
export type VerifiedFail = { ok: false; error: string; code: string; status: number };

/** Require verified email for mutating hosted features (projects, billing, keys). */
export async function requireVerifiedEmail(
  env: Env,
  email: string
): Promise<VerifiedOk | VerifiedFail> {
  const user = await getUser(env, email);
  if (!user || !user.emailVerified) {
    return {
      ok: false,
      error: 'Verify your email to continue.',
      code: 'email_unverified',
      status: 403
    };
  }
  return { ok: true, user };
}

export function normalizeEmail(email: string): string | null {
  const e = String(email || '')
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 254) return null;
  return e;
}
