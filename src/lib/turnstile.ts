export type TurnstileResult = { ok: boolean; reason?: string };

/**
 * Verify Cloudflare Turnstile.
 * When `required` is true (project has Turnstile enabled), missing secret
 * and siteverify outages fail closed.
 */
export async function verifyTurnstile(
  token: string | undefined,
  secret: string | undefined,
  ip?: string | null,
  opts?: { required?: boolean }
): Promise<TurnstileResult> {
  const required = !!opts?.required;

  if (!secret) {
    if (required) return { ok: false, reason: 'turnstile_not_configured' };
    return { ok: true };
  }
  if (!token) return { ok: false, reason: 'missing_turnstile' };

  try {
    const body = new URLSearchParams();
    body.set('secret', secret);
    body.set('response', token);
    if (ip) body.set('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body
    });
    const data = (await res.json()) as { success?: boolean };
    if (!data.success) return { ok: false, reason: 'turnstile_failed' };
    return { ok: true };
  } catch {
    if (required) return { ok: false, reason: 'turnstile_unavailable' };
    return { ok: true, reason: 'turnstile_unavailable' };
  }
}
