import type { Env } from './env.ts';
import { randomToken } from './crypto-util.ts';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB
export const MAX_IMAGES_PER_SUBMISSION = 5;
export const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp'
]);

export type StoredFileMeta = {
  id: string;
  projectId: string;
  ownerEmail: string;
  contentType: string;
  size: number;
  name: string;
  createdAt: number;
  /** Unguessable read token required for unauthenticated GET */
  token: string;
};

/** Detect real image type from magic bytes (ignore client Content-Type alone). */
export function sniffImageType(bytes: ArrayBuffer): string | null {
  const u = new Uint8Array(bytes);
  if (u.length >= 3 && u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff) return 'image/jpeg';
  if (
    u.length >= 8 &&
    u[0] === 0x89 &&
    u[1] === 0x50 &&
    u[2] === 0x4e &&
    u[3] === 0x47 &&
    u[4] === 0x0d &&
    u[5] === 0x0a &&
    u[6] === 0x1a &&
    u[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (u.length >= 6 && u[0] === 0x47 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x38) {
    return 'image/gif';
  }
  if (
    u.length >= 12 &&
    u[0] === 0x52 &&
    u[1] === 0x49 &&
    u[2] === 0x46 &&
    u[3] === 0x46 &&
    u[8] === 0x57 &&
    u[9] === 0x45 &&
    u[10] === 0x42 &&
    u[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

export function isAllowedImageType(ct: string): boolean {
  const t = String(ct || '').toLowerCase();
  if (t === 'image/jpg') return true;
  return ALLOWED_IMAGE_TYPES.has(t);
}

export function sanitizeFileName(name: string): string {
  return (
    String(name || 'upload')
      .replace(/[\\/\r\n\0]+/g, '_')
      .replace(/\.\.+/g, '')
      .replace(/^[_\s]+|[_\s]+$/g, '')
      .replace(/[^\w.\-()+ ]+/g, '')
      .trim()
      .slice(0, 180) || 'upload'
  );
}

export async function storeImageFile(
  env: Env,
  opts: {
    projectId: string;
    ownerEmail: string;
    name: string;
    contentType: string;
    bytes: ArrayBuffer;
  }
): Promise<{
  id: string;
  urlPath: string;
  size: number;
  name: string;
  contentType: string;
  token: string;
}> {
  const sniffed = sniffImageType(opts.bytes);
  if (!sniffed || !isAllowedImageType(sniffed)) {
    throw Object.assign(new Error('Invalid image data'), { status: 400, code: 'invalid_image' });
  }
  const id = 'img_' + randomToken(12);
  const token = randomToken(24);
  const meta: StoredFileMeta = {
    id,
    projectId: opts.projectId,
    ownerEmail: opts.ownerEmail,
    contentType: sniffed,
    size: opts.bytes.byteLength,
    name: sanitizeFileName(opts.name),
    createdAt: Date.now(),
    token
  };
  await env.FLAREFORM.put('filemeta:' + id, JSON.stringify(meta), {
    expirationTtl: 60 * 60 * 24 * 365
  });
  await env.FLAREFORM.put('file:' + id, opts.bytes, {
    expirationTtl: 60 * 60 * 24 * 365
  });
  return {
    id,
    urlPath: '/v1/files/' + id + '?t=' + encodeURIComponent(token),
    size: meta.size,
    name: meta.name,
    contentType: meta.contentType,
    token
  };
}

export async function countImagesThisMonth(env: Env, ownerEmail: string): Promise<number> {
  const key = 'imgquota:' + ownerEmail.toLowerCase() + ':' + new Date().toISOString().slice(0, 7);
  return Number((await env.FLAREFORM.get(key)) || '0') || 0;
}

/** Best-effort atomic-ish increment with retry to reduce overshoot under concurrency. */
export async function incrementImageQuota(env: Env, ownerEmail: string, n: number): Promise<number> {
  const key = 'imgquota:' + ownerEmail.toLowerCase() + ':' + new Date().toISOString().slice(0, 7);
  let next = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = Number((await env.FLAREFORM.get(key)) || '0') || 0;
    next = cur + n;
    await env.FLAREFORM.put(key, String(next), { expirationTtl: 60 * 60 * 24 * 45 });
    const verify = Number((await env.FLAREFORM.get(key)) || '0') || 0;
    if (verify >= next) return verify;
  }
  return next;
}

export async function deleteStoredFile(env: Env, id: string): Promise<void> {
  if (!id) return;
  await env.FLAREFORM.delete('file:' + id);
  await env.FLAREFORM.delete('filemeta:' + id);
}

/** Collect image ids from submission payload JSON. */
export function imageIdsFromPayload(payloadJson: string | null | undefined): string[] {
  try {
    const payload = JSON.parse(payloadJson || '{}') as { _images?: Array<{ id?: string }> };
    const imgs = payload && Array.isArray(payload._images) ? payload._images : [];
    return imgs.map((i) => String(i && i.id ? i.id : '')).filter(Boolean);
  } catch {
    return [];
  }
}

export async function deleteImagesForPayloads(
  env: Env,
  payloads: Array<string | null | undefined>
): Promise<void> {
  const ids = new Set<string>();
  for (const p of payloads) {
    imageIdsFromPayload(p).forEach((id) => ids.add(id));
  }
  for (const id of ids) {
    await deleteStoredFile(env, id);
  }
}
