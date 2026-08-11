import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readJsonBody, contentLengthOk } from '../src/lib/validate.ts';
import {
  assertIngestBodySize,
  originDenied,
  parseAllowedOrigins,
  safeRedirectUrl
} from '../src/lib/ingest-guard.ts';
import { verifyTurnstile } from '../src/lib/turnstile.ts';
import { sanitizeFileName, sniffImageType } from '../src/lib/media.ts';

describe('validate', () => {
  it('parses json body', async () => {
    const req = new Request('https://x.test', {
      method: 'POST',
      body: JSON.stringify({ text: 'hi' }),
      headers: { 'Content-Type': 'application/json' }
    });
    const r = await readJsonBody(req);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.body.text, 'hi');
  });

  it('rejects oversized content-length', () => {
    const req = new Request('https://x.test', {
      method: 'POST',
      headers: { 'Content-Length': String(1024 * 1024) }
    });
    assert.equal(contentLengthOk(req, 100), false);
  });
});

describe('ingest-guard', () => {
  it('parses allowed origins', () => {
    assert.deepEqual(parseAllowedOrigins('https://a.com, https://b.com/'), [
      'https://a.com',
      'https://b.com'
    ]);
  });

  it('allows when allowlist empty', () => {
    const req = new Request('https://api.test/f/x', {
      headers: { Origin: 'https://evil.com' }
    });
    assert.equal(originDenied('', req).denied, false);
  });

  it('denies mismatched Origin when allowlisted', () => {
    const req = new Request('https://api.test/f/x', {
      headers: { Origin: 'https://evil.com' }
    });
    const r = originDenied('https://good.com', req);
    assert.equal(r.denied, true);
  });

  it('allows matching Origin', () => {
    const req = new Request('https://api.test/f/x', {
      headers: { Origin: 'https://good.com' }
    });
    assert.equal(originDenied('https://good.com', req).denied, false);
  });

  it('checks Referer when Origin missing', () => {
    const bad = new Request('https://api.test/f/x', {
      headers: { Referer: 'https://evil.com/page' }
    });
    assert.equal(originDenied('https://good.com', bad).denied, true);
    const good = new Request('https://api.test/f/x', {
      headers: { Referer: 'https://good.com/form' }
    });
    assert.equal(originDenied('https://good.com', good).denied, false);
  });

  it('rejects oversized ingest content-length', () => {
    const req = new Request('https://api.test/f/x', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(512 * 1024)
      }
    });
    const r = assertIngestBodySize(req);
    assert.equal(r.ok, false);
  });

  it('allowlists redirects', () => {
    assert.equal(
      safeRedirectUrl('https://evil.com/phish', {
        allowedOriginsRaw: 'https://good.com',
        requestOrigin: 'https://good.com',
        appOrigin: 'https://flareform.pages.dev'
      }),
      null
    );
    assert.equal(
      safeRedirectUrl('https://good.com/thanks', {
        allowedOriginsRaw: 'https://good.com',
        requestOrigin: 'https://good.com',
        appOrigin: 'https://flareform.pages.dev'
      }),
      'https://good.com/thanks'
    );
    assert.equal(
      safeRedirectUrl('/thanks', {
        allowedOriginsRaw: 'https://good.com',
        requestOrigin: 'https://good.com',
        appOrigin: 'https://flareform.pages.dev'
      }),
      'https://good.com/thanks'
    );
  });

  it('blocks open redirects when allowlist empty', () => {
    assert.equal(
      safeRedirectUrl('https://evil.com/', {
        allowedOriginsRaw: '',
        requestOrigin: 'https://flareform.pages.dev',
        appOrigin: 'https://flareform.pages.dev'
      }),
      null
    );
    assert.equal(
      safeRedirectUrl('https://flareform.pages.dev/ok', {
        allowedOriginsRaw: '',
        requestOrigin: '',
        appOrigin: 'https://flareform.pages.dev'
      }),
      'https://flareform.pages.dev/ok'
    );
  });
});

describe('turnstile', () => {
  it('fails closed when required and secret missing', async () => {
    const r = await verifyTurnstile('tok', undefined, null, { required: true });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'turnstile_not_configured');
  });

  it('allows optional when secret missing', async () => {
    const r = await verifyTurnstile(undefined, undefined, null, { required: false });
    assert.equal(r.ok, true);
  });

  it('rejects missing token when secret present', async () => {
    const r = await verifyTurnstile('', 'sec', null, { required: true });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'missing_turnstile');
  });
});

describe('media', () => {
  it('sniffs jpeg/png magic bytes', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]).buffer;
    assert.equal(sniffImageType(jpeg), 'image/jpeg');
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer;
    assert.equal(sniffImageType(png), 'image/png');
    assert.equal(sniffImageType(new Uint8Array([1, 2, 3]).buffer), null);
  });

  it('sanitizes file names', () => {
    assert.equal(sanitizeFileName('../../etc/passwd'), 'etc_passwd');
    assert.equal(sanitizeFileName('photo.png'), 'photo.png');
  });
});
