import type { Env } from './env.ts';

export async function sendBrevoEmail(
  env: Env,
  opts: { to: string; subject: string; html: string; text: string }
): Promise<{ ok: true; messageId?: string } | { ok: false; error: string }> {
  if (!env.BREVO_API_KEY) {
    return { ok: false, error: 'Email service not configured' };
  }

  const senderEmail = (env.BREVO_SENDER_EMAIL || '').trim();
  if (!senderEmail) {
    return { ok: false, error: 'Email sender not configured' };
  }
  const senderName = (env.BREVO_SENDER_NAME || 'Flareform').trim() || 'Flareform';

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': env.BREVO_API_KEY
      },
      body: JSON.stringify({
        sender: { name: senderName, email: senderEmail },
        to: [{ email: opts.to }],
        subject: opts.subject,
        htmlContent: opts.html,
        textContent: opts.text
      })
    });

    const body = (await res.json().catch(() => ({}))) as { messageId?: string; message?: string };
    if (!res.ok) {
      console.error('Brevo send failed', res.status, body.message);
      return { ok: false, error: 'Email send failed' };
    }
    return { ok: true, messageId: body.messageId };
  } catch (err) {
    console.error('Brevo send error', err);
    return { ok: false, error: 'Email send failed' };
  }
}
