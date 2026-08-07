import type { Env } from './env.ts';

export type SpamScore = { score: number; isSpam: boolean; error?: string; fingerprint?: string };

/** Lightweight local heuristic when the edge spam API is unavailable or unauthorized. */
export function localSpamScore(fields: Record<string, unknown>): SpamScore {
  const text = Object.values(fields)
    .map((v) => String(v || ''))
    .join(' ')
    .toLowerCase();
  let score = 0;
  if (/viagra|cialis|crypto\s*winner|click\s*here|buy\s*cheap|free\s*money|nigerian\s*prince/.test(text)) {
    score += 0.55;
  }
  const urls = text.match(/https?:\/\/\S+/g) || [];
  if (urls.length >= 2) score += 0.25;
  if (urls.length >= 4) score += 0.2;
  if (/(.)\1{6,}/.test(text)) score += 0.15;
  if (text.length > 4000) score += 0.1;
  score = Math.min(1, score);
  return { score, isSpam: score >= 0.7 };
}

/** Unwrap nested /v1/spam/check response into a flat score. */
export function parseSpamCheckResponse(data: any): SpamScore {
  const nested =
    data && typeof data.score === 'object' && data.score !== null ? data.score : null;
  const score =
    typeof data?.score === 'number'
      ? data.score
      : typeof nested?.score === 'number'
        ? nested.score
        : 0;
  const decision = String(nested?.decision || data?.decision || '').toLowerCase();
  const isSpam = !!(
    data?.spam ||
    data?.isSpam ||
    decision === 'reject' ||
    decision === 'block' ||
    decision === 'soft_reject' ||
    score >= 0.7
  );
  const fingerprint = String(nested?.fingerprint || data?.fingerprint || '') || undefined;
  return { score, isSpam, fingerprint };
}

export async function scoreWithGeckodupe(
  env: Env,
  fields: Record<string, unknown>
): Promise<SpamScore> {
  const base = (env.GECKODUPE_SPAM_URL || '').replace(/\/+$/, '');
  if (!base) return localSpamScore(fields);
  const failClosed = String(env.SPAM_FAIL_MODE || 'fail-open').toLowerCase() === 'fail-closed';
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };
    if (env.GECKODUPE_API_KEY) headers.Authorization = 'Bearer ' + env.GECKODUPE_API_KEY;
    const res = await fetch(base + '/v1/spam/check', {
      method: 'POST',
      headers,
      body: JSON.stringify({ fields })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = (data as any)?.error || 'spam_api_error';
      if (failClosed) return { score: 1, isSpam: true, error: err };
      const local = localSpamScore(fields);
      local.error = err;
      return local;
    }
    return parseSpamCheckResponse(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'spam_unreachable';
    if (failClosed) return { score: 1, isSpam: true, error: msg };
    const local = localSpamScore(fields);
    local.error = msg;
    return local;
  }
}

export type DedupeResult = {
  duplicate: boolean;
  fingerprint: string;
  error?: string;
};

/** Deduplicate via edge events API when keyed; else fingerprint for local D1. */
export async function dedupeWithGeckodupe(
  env: Env,
  opts: {
    eventId: string;
    fields: Record<string, unknown>;
    text: string;
  }
): Promise<DedupeResult> {
  const fingerprintFallback = opts.eventId;
  const base = (env.GECKODUPE_SPAM_URL || '').replace(/\/+$/, '');
  if (!base || !env.GECKODUPE_API_KEY) {
    return { duplicate: false, fingerprint: fingerprintFallback };
  }
  try {
    const res = await fetch(base + '/v1/events/check', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: 'Bearer ' + env.GECKODUPE_API_KEY
      },
      body: JSON.stringify({
        eventId: opts.eventId,
        fields: opts.fields,
        text: opts.text,
        remember: true
      })
    });
    const data = (await res.json().catch(() => ({}))) as {
      duplicate?: boolean;
      fingerprint?: string;
      error?: string;
    };
    if (!res.ok) {
      return { duplicate: false, fingerprint: fingerprintFallback, error: data.error };
    }
    return {
      duplicate: !!data.duplicate,
      fingerprint: String(data.fingerprint || fingerprintFallback)
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'dedupe_unreachable';
    return { duplicate: false, fingerprint: fingerprintFallback, error: msg };
  }
}
