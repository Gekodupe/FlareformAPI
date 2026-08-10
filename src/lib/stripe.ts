import type { Env } from './env.ts';
import { parsePriceIds } from './plans.ts';

function formEncode(data: Record<string, string | undefined>): string {
  const parts: string[] = [];
  Object.keys(data).forEach((k) => {
    const v = data[k];
    if (v == null || v === '') return;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  });
  return parts.join('&');
}

export async function stripeRequest(
  env: Env,
  method: string,
  path: string,
  body?: Record<string, string | undefined>
): Promise<{ ok: true; data: any } | { ok: false; error: string; status: number }> {
  if (!env.STRIPE_SECRET_KEY) return { ok: false, error: 'Stripe not configured', status: 503 };
  const res = await fetch('https://api.stripe.com/v1' + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body ? formEncode(body) : undefined
  });
  const data = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
    [key: string]: unknown;
  };
  if (!res.ok) {
    return {
      ok: false,
      error: (data && data.error && data.error.message) || 'Stripe error',
      status: res.status
    };
  }
  return { ok: true, data };
}

export function getPriceIds(env: Env): Record<string, string> {
  return parsePriceIds(env.STRIPE_PRICE_IDS);
}

/** Verify Stripe-Signature (v1) using webhook secret. */
export async function verifyStripeSignature(
  payload: string,
  signatureHeader: string | null,
  secret: string,
  toleranceSec = 300
): Promise<boolean> {
  if (!signatureHeader || !secret) return false;
  const parts = signatureHeader.split(',').map((p) => p.trim());
  let timestamp = '';
  const sigs: string[] = [];
  parts.forEach((p) => {
    const [k, v] = p.split('=');
    if (k === 't') timestamp = v;
    if (k === 'v1') sigs.push(v);
  });
  if (!timestamp || !sigs.length) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(timestamp + '.' + payload));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return sigs.some((s) => {
    if (s.length !== expected.length) return false;
    let ok = 0;
    for (let i = 0; i < s.length; i++) ok |= s.charCodeAt(i) ^ expected.charCodeAt(i);
    return ok === 0;
  });
}
