/** Shared request validation for Flareform API routes */

export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_EVENT_ID_LEN = 128;
export const MAX_BLOCKLIST_ITEMS = 500;
export const MAX_BLOCKLIST_ITEM_LEN = 200;

export function contentLengthOk(request: Request, max = MAX_BODY_BYTES): boolean {
  const cl = request.headers.get('Content-Length');
  if (!cl) return true;
  const n = Number(cl);
  return !Number.isFinite(n) || n <= max;
}

export async function readJsonBody(
  request: Request,
  maxBytes = MAX_BODY_BYTES
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string; status: number }> {
  if (!contentLengthOk(request, maxBytes)) {
    return { ok: false, error: 'Payload too large', status: 413 };
  }

  const raw = await request.text();
  if (raw.length > maxBytes) {
    return { ok: false, error: 'Payload too large', status: 413 };
  }
  if (!raw.trim()) {
    return { ok: false, error: 'Empty body', status: 400 };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Invalid JSON', status: 400 };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Body must be a JSON object', status: 400 };
  }

  return { ok: true, body: parsed as Record<string, unknown> };
}

export function sanitizeEventId(raw: unknown): { ok: true; eventId: string } | { ok: false; error: string } {
  if (raw == null || raw === '') return { ok: true, eventId: '' };
  const eventId = String(raw).trim();
  if (eventId.length > MAX_EVENT_ID_LEN) {
    return { ok: false, error: 'eventId too long (max ' + MAX_EVENT_ID_LEN + ')' };
  }
  if (!/^[A-Za-z0-9._:@+=\/-]{1,128}$/.test(eventId)) {
    return { ok: false, error: 'eventId has invalid characters' };
  }
  return { ok: true, eventId };
}

export function sanitizeBlocklist(raw: unknown): { ok: true; blocklist: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'blocklist must be an array of strings' };
  }
  if (raw.length > MAX_BLOCKLIST_ITEMS) {
    return { ok: false, error: 'blocklist too large (max ' + MAX_BLOCKLIST_ITEMS + ' items)' };
  }
  const blocklist: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = String(raw[i] || '').trim();
    if (!s) continue;
    if (s.length > MAX_BLOCKLIST_ITEM_LEN) {
      return { ok: false, error: 'blocklist item too long (max ' + MAX_BLOCKLIST_ITEM_LEN + ')' };
    }
    blocklist.push(s);
  }
  return { ok: true, blocklist };
}

export function hasSpamInput(body: Record<string, unknown>): boolean {
  if (typeof body.text === 'string' && body.text.length) return true;
  if (typeof body.payload === 'string' && body.payload.length) return true;
  if (body.fields && typeof body.fields === 'object') return true;
  if (body.eventId != null && String(body.eventId).trim()) return true;
  return false;
}
