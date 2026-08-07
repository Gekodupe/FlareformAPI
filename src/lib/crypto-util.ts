export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 24): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomCode(length = 6): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[arr[i] % alphabet.length];
  return out;
}

export function mintApiKey(): string {
  return 'ff_live_' + randomToken(16);
}

export function keyPrefix(apiKey: string): string {
  return apiKey.slice(0, 12) + '...';
}
