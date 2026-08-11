import type { Env } from './env.ts';

/** Shared Workers Rate Limiting. Fail-closed when the binding is present. */
export async function rateOk(
  env: Env,
  key: string,
  kind: 'default' | 'auth' = 'default'
): Promise<boolean> {
  const limiter =
    kind === 'auth'
      ? env.AUTH_RATE_LIMITER || env.SPAM_RATE_LIMITER
      : env.SPAM_RATE_LIMITER;
  if (!limiter) return true; // unbound local/dev
  try {
    const r = await limiter.limit({ key });
    return r.success;
  } catch (err) {
    console.error('Flareform rate limit error', err);
    return false;
  }
}

export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') || 'x';
}
