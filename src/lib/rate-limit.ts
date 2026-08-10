import type { Env } from './env.ts';

/** Shared Workers Rate Limiting helper. Fail-open only when unbound (local). */
export async function rateOk(env: Env, key: string): Promise<boolean> {
  if (!env.SPAM_RATE_LIMITER) return true;
  try {
    const r = await env.SPAM_RATE_LIMITER.limit({ key });
    return r.success;
  } catch {
    return true;
  }
}

export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') || 'x';
}
