export async function verifyTurnstile(
  token: string | undefined,
  secret: string | undefined,
  ip?: string | null
): Promise<{ ok: boolean; reason?: string }> {
  if (!secret) return { ok: true }; // optional
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
    // Fail open on Turnstile outage
    return { ok: true, reason: 'turnstile_unavailable' };
  }
}

