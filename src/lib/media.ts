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
};

export function isAllowedImageType(ct: string): boolean {
  return ALLOWED_IMAGE_TYPES.has(String(ct || '').toLowerCase());
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
): Promise<{ id: string; urlPath: string; size: number; name: string; contentType: string }> {
  const id = 'img_' + randomToken(12);
  const meta: StoredFileMeta = {
    id,
    projectId: opts.projectId,
    ownerEmail: opts.ownerEmail,
    contentType: opts.contentType,
    size: opts.bytes.byteLength,
    name: opts.name.slice(0, 180),
    createdAt: Date.now()
  };
  await env.FLAREFORM.put('filemeta:' + id, JSON.stringify(meta), {
    expirationTtl: 60 * 60 * 24 * 365
  });
  await env.FLAREFORM.put('file:' + id, opts.bytes, {
    expirationTtl: 60 * 60 * 24 * 365
  });
  return {
    id,
    urlPath: '/v1/files/' + id,
    size: meta.size,
    name: meta.name,
    contentType: meta.contentType
  };
}

export async function countImagesThisMonth(env: Env, ownerEmail: string): Promise<number> {
  const key = 'imgquota:' + ownerEmail.toLowerCase() + ':' + new Date().toISOString().slice(0, 7);
  return Number((await env.FLAREFORM.get(key)) || '0') || 0;
}

export async function incrementImageQuota(env: Env, ownerEmail: string, n: number): Promise<number> {
  const key = 'imgquota:' + ownerEmail.toLowerCase() + ':' + new Date().toISOString().slice(0, 7);
  const cur = Number((await env.FLAREFORM.get(key)) || '0') || 0;
  const next = cur + n;
  await env.FLAREFORM.put(key, String(next), { expirationTtl: 60 * 60 * 24 * 45 });
  return next;
}
