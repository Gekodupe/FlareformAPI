import type { Env } from './env.ts';

export function extractBearerToken(request: Request): string {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

export type SessionOk = { ok: true; sessionId: string; email: string };
export type SessionFail = { ok: false; error: string };

export async function requireSession(request: Request, env: Env): Promise<SessionOk | SessionFail> {
  const token = extractBearerToken(request);
  if (!token || token.indexOf('sess_') !== 0) {
    return { ok: false, error: 'Sign in required' };
  }
  try {
    const session = (await env.FLAREFORM.get('session:' + token, 'json')) as
      | { email?: string; exp?: number }
      | null;
    if (!session || !session.email) return { ok: false, error: 'Sign in required' };
    if (session.exp && session.exp < Date.now()) {
      await env.FLAREFORM.delete('session:' + token);
      return { ok: false, error: 'Session expired' };
    }
    return { ok: true, sessionId: token, email: String(session.email).toLowerCase() };
  } catch {
    return { ok: false, error: 'Sign in required' };
  }
}

export function normalizeEmail(email: string): string | null {
  const e = String(email || '')
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 254) return null;
  return e;
}
