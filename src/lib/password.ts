import { randomToken } from './crypto-util.ts';

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashPassword(password: string, salt?: string): Promise<{ salt: string; hash: string }> {
  const useSalt = salt || randomToken(16);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  // Cloudflare Workers cap PBKDF2 iterations at 100000
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(useSalt), iterations: 100000, hash: 'SHA-256' },
    key,
    256
  );
  return { salt: useSalt, hash: toHex(bits) };
}

export async function verifyPassword(password: string, salt: string, expectedHash: string): Promise<boolean> {
  const { hash } = await hashPassword(password, salt);
  if (hash.length !== expectedHash.length) return false;
  let ok = 0;
  for (let i = 0; i < hash.length; i++) ok |= hash.charCodeAt(i) ^ expectedHash.charCodeAt(i);
  return ok === 0;
}

export function passwordStrengthOk(password: string): string | null {
  if (!password || password.length < 10) return 'Password must be at least 10 characters';
  if (password.length > 128) return 'Password is too long';
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password needs letters and a number';
  }
  return null;
}
