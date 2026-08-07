import { jsonResponse } from '../lib/cors.ts';
import { sendBrevoEmail } from '../lib/brevo.ts';
import type { Env } from '../lib/env.ts';
import { normalizeEmail } from '../lib/auth.ts';
import { readJsonBody } from '../lib/validate.ts';

const TOPICS: Record<string, string> = {
  billing: 'Billing and plans',
  inbox: 'Inbox and submissions',
  projects: 'Projects and ingest',
  analytics: 'Analytics',
  account: 'Account and sign-in',
  selfhost: 'Self-hosting',
  bug: 'Bug report',
  other: 'Something else'
};

export async function handleSupportRoutes(
  request: Request,
  env: Env,
  path: string
): Promise<Response | null> {
  if (path !== '/v1/support' || request.method !== 'POST') return null;

  const parsed = await readJsonBody(request, 16 * 1024);
  if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status, request, env);

  const name = String(parsed.body.name || '')
    .trim()
    .slice(0, 120);
  const email = normalizeEmail(String(parsed.body.email || ''));
  const topic = String(parsed.body.topic || '').trim();
  const message = String(parsed.body.message || '')
    .trim()
    .slice(0, 4000);

  if (!name) return jsonResponse({ error: 'Name required' }, 400, request, env);
  if (!email) return jsonResponse({ error: 'Valid email required' }, 400, request, env);
  if (!TOPICS[topic]) return jsonResponse({ error: 'Select a topic' }, 400, request, env);
  if (message.length < 10) {
    return jsonResponse({ error: 'Message too short' }, 400, request, env);
  }

  const inbox = env.SUPPORT_INBOX || env.BREVO_SENDER_EMAIL || 'nic@blacnova.net';
  const topicLabel = TOPICS[topic];
  const html =
    '<div style="font-family:Poppins,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">' +
    '<p style="color:#f7831e;text-transform:uppercase;letter-spacing:0.08em;font-size:13px">Flareform Support</p>' +
    '<h1 style="font-weight:400;font-size:22px">New support message</h1>' +
    '<p><strong>From:</strong> ' +
    escapeHtml(name) +
    ' &lt;' +
    escapeHtml(email) +
    '&gt;</p>' +
    '<p><strong>Topic:</strong> ' +
    escapeHtml(topicLabel) +
    '</p>' +
    '<pre style="white-space:pre-wrap;background:#f3f4f6;padding:12px;border:1px solid #e5e7eb">' +
    escapeHtml(message) +
    '</pre></div>';

  const mailed = await sendBrevoEmail(env, {
    to: inbox,
    subject: '[Flareform] ' + topicLabel + ' - ' + name,
    html,
    text:
      'From: ' +
      name +
      ' <' +
      email +
      '>\nTopic: ' +
      topicLabel +
      '\n\n' +
      message
  });

  if (!mailed.ok) {
    // Still accept locally when email is not configured so UI can be tested
    if (!env.BREVO_API_KEY) {
      return jsonResponse(
        {
          ok: true,
          queued: false,
          message: 'Support request recorded. Email delivery is not configured on this deployment.'
        },
        200,
        request,
        env
      );
    }
    return jsonResponse({ error: mailed.error || 'Could not send message' }, 502, request, env);
  }

  return jsonResponse(
    { ok: true, queued: true, message: 'Message sent. We will get back to you.' },
    200,
    request,
    env
  );
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
