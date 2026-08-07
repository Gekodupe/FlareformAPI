import { sha256Hex, randomToken } from '../lib/crypto-util.ts';
import { ingestCorsHeaders, jsonResponse } from '../lib/cors.ts';
import type { Env } from '../lib/env.ts';
import { verifyTurnstile } from '../lib/turnstile.ts';
import { planLimits, getUser } from '../lib/users.ts';
import { sendBrevoEmail } from '../lib/brevo.ts';
import { scoreWithGeckodupe, dedupeWithGeckodupe } from '../lib/geckodupe.ts';
import {
  countImagesThisMonth,
  incrementImageQuota,
  isAllowedImageType,
  MAX_IMAGES_PER_SUBMISSION,
  storeImageFile
} from '../lib/media.ts';

function parseAllowedOrigins(raw: string): string[] {
  return String(raw || '')
    .split(/[,\n]+/)
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function notifyOwner(
  env: Env,
  project: any,
  submissionId: string,
  fields: Record<string, unknown>,
  spam: { score: number; isSpam: boolean }
): Promise<void> {
  if (Number(project.notify_enabled) === 0) return;
  if (spam.isSpam) return;
  const to = String(project.notify_email || project.owner_email || '').trim();
  if (!to || !env.BREVO_API_KEY) return;

  const rows = Object.keys(fields)
    .map((k) => {
      return (
        '<tr><td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;color:#484848">' +
        escapeHtml(k) +
        '</td><td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">' +
        escapeHtml(String(fields[k])) +
        '</td></tr>'
      );
    })
    .join('');

  const subject = 'New Flareform submission - ' + String(project.name || project.id);
  const html =
    '<div style="font-family:Poppins,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">' +
    '<p style="color:#f7831e;text-transform:uppercase;letter-spacing:0.08em;font-size:13px">Flareform</p>' +
    '<h1 style="font-weight:400;font-size:22px;margin:8px 0 12px">New submission</h1>' +
    '<p style="color:#484848">Project: <strong>' +
    escapeHtml(String(project.name || '')) +
    '</strong> (' +
    escapeHtml(String(project.id)) +
    ')</p>' +
    '<p style="font-size:13px;color:#6b7280">ID ' +
    escapeHtml(submissionId) +
    ' · score ' +
    spam.score.toFixed(2) +
    '</p>' +
    '<table style="width:100%;border-collapse:collapse;margin-top:16px">' +
    rows +
    '</table>' +
    '<p style="margin-top:24px;font-size:12px;color:#6b7280">Blacnova Development &lt;nic@blacnova.net&gt;</p>' +
    '</div>';

  const textLines = Object.keys(fields)
    .map((k) => k + ': ' + String(fields[k]))
    .join('\n');

  await sendBrevoEmail(env, {
    to,
    subject,
    html,
    text: subject + '\n\n' + textLines
  });
}

async function parseBody(
  request: Request
): Promise<{ fields: Record<string, unknown>; files: Array<{ name: string; field: string; contentType: string; bytes: ArrayBuffer }> }> {
  const ct = (request.headers.get('Content-Type') || '').toLowerCase();
  if (ct.includes('application/json')) {
    const text = await request.text();
    if (!text.trim()) return { fields: {}, files: [] };
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { fields: parsed as Record<string, unknown>, files: [] };
    }
    return { fields: { payload: parsed }, files: [] };
  }
  if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
    const form = await request.formData();
    const fields: Record<string, unknown> = {};
    const files: Array<{ name: string; field: string; contentType: string; bytes: ArrayBuffer }> = [];
    for (const [key, value] of form.entries()) {
      if (typeof value === 'string') {
        fields[key] = value;
      } else {
        const file = value as File;
        const bytes = await file.arrayBuffer();
        files.push({
          name: file.name || 'upload',
          field: key,
          contentType: file.type || 'application/octet-stream',
          bytes
        });
      }
    }
    return { fields, files };
  }
  const text = await request.text();
  if (!text.trim()) return { fields: {}, files: [] };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { fields: parsed as Record<string, unknown>, files: [] };
    }
  } catch {
    /* fall through */
  }
  return { fields: { body: text }, files: [] };
}

function cleanFields(fields: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  Object.keys(fields).forEach((k) => {
    if (k.startsWith('_') || k === 'cf-turnstile-response') return;
    const v = fields[k];
    if (typeof v === 'string') clean[k] = v.slice(0, 10000);
    else if (typeof v === 'number' || typeof v === 'boolean') clean[k] = v;
    else if (v && typeof v === 'object') clean[k] = JSON.stringify(v).slice(0, 10000);
    else clean[k] = String(v).slice(0, 10000);
  });
  return clean;
}

async function checkOrigin(
  project: any,
  request: Request,
  env: Env
): Promise<Response | null> {
  const origin = request.headers.get('Origin') || '';
  const allowed = parseAllowedOrigins(project.allowed_origins || '');
  if (allowed.length && origin) {
    const ok = allowed.some((a) => a === origin || a === '*');
    if (!ok) {
      return jsonResponse(
        { error: 'Origin not allowed' },
        403,
        request,
        env,
        ingestCorsHeaders(request)
      );
    }
  }
  return null;
}

async function checkQuota(env: Env, owner: string, request: Request): Promise<Response | null> {
  const user = await getUser(env, owner);
  const limits = planLimits(user);
  const monthCount = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM submissions s
     JOIN projects p ON p.id = s.project_id
     WHERE p.owner_email = ? AND s.created_at >= datetime('now', '-30 days')`
  )
    .bind(owner)
    .first<{ c: number }>();
  if (Number(monthCount?.c || 0) >= limits.submissionsPerMonth) {
    return jsonResponse(
      { error: 'Submission quota reached for this account' },
      429,
      request,
      env,
      ingestCorsHeaders(request)
    );
  }
  return null;
}

const WORRYFUL = new Set(['error', 'fatal', 'critical', 'warn', 'warning', 'exception']);

function normalizeLogLevel(raw: unknown): string {
  const level = String(raw || 'error').trim().toLowerCase();
  if (level === 'warning') return 'warn';
  return level || 'error';
}

async function handleFormIngest(
  request: Request,
  env: Env,
  project: any,
  projectId: string
): Promise<Response> {
  const originDenied = await checkOrigin(project, request, env);
  if (originDenied) return originDenied;

  let parsedBody: {
    fields: Record<string, unknown>;
    files: Array<{ name: string; field: string; contentType: string; bytes: ArrayBuffer }>;
  };
  try {
    parsedBody = await parseBody(request);
  } catch {
    return jsonResponse(
      { error: 'Invalid body' },
      400,
      request,
      env,
      ingestCorsHeaders(request)
    );
  }
  const fields = parsedBody.fields;

  const honey = fields._gotcha || fields._honey || fields._honeypot;
  if (honey != null && String(honey).trim() !== '') {
    return jsonResponse({ ok: true }, 200, request, env, ingestCorsHeaders(request));
  }

  if (Number(project.turnstile_enabled) === 1) {
    const token = String(
      fields['cf-turnstile-response'] || fields.turnstileToken || fields._turnstile || ''
    );
    const ip = request.headers.get('CF-Connecting-IP');
    const ts = await verifyTurnstile(token, env.TURNSTILE_SECRET, ip);
    if (!ts.ok) {
      return jsonResponse(
        { error: 'Turnstile verification failed', reason: ts.reason },
        403,
        request,
        env,
        ingestCorsHeaders(request)
      );
    }
  }

  const owner = String(project.owner_email || '');
  const quota = await checkQuota(env, owner, request);
  if (quota) return quota;

  const user = await getUser(env, owner);
  const limits = planLimits(user);
  const imageFiles = parsedBody.files.filter((f) => isAllowedImageType(f.contentType));
  if (imageFiles.length > MAX_IMAGES_PER_SUBMISSION) {
    return jsonResponse(
      { error: 'Too many images (max ' + MAX_IMAGES_PER_SUBMISSION + ' per submission)' },
      400,
      request,
      env,
      ingestCorsHeaders(request)
    );
  }
  for (const f of imageFiles) {
    if (f.bytes.byteLength > limits.maxImageBytes) {
      return jsonResponse(
        { error: 'Image too large (max ' + limits.maxImageBytes + ' bytes)', name: f.name },
        413,
        request,
        env,
        ingestCorsHeaders(request)
      );
    }
  }
  if (imageFiles.length) {
    const used = await countImagesThisMonth(env, owner);
    if (used + imageFiles.length > limits.imagesPerMonth) {
      return jsonResponse(
        {
          error: 'Image quota reached for this account',
          used,
          limit: limits.imagesPerMonth
        },
        429,
        request,
        env,
        ingestCorsHeaders(request)
      );
    }
  }

  const clean = cleanFields(fields);
  const storedImages: Array<{
    id: string;
    url: string;
    name: string;
    size: number;
    contentType: string;
    field: string;
  }> = [];
  const originHost = new URL(request.url).origin;
  for (const f of imageFiles) {
    const stored = await storeImageFile(env, {
      projectId,
      ownerEmail: owner,
      name: f.name,
      contentType: f.contentType,
      bytes: f.bytes
    });
    storedImages.push({
      id: stored.id,
      url: originHost + stored.urlPath,
      name: stored.name,
      size: stored.size,
      contentType: stored.contentType,
      field: f.field
    });
  }
  if (storedImages.length) {
    clean._images = storedImages;
    await incrementImageQuota(env, owner, storedImages.length);
  }

  if (!Object.keys(clean).length) {
    return jsonResponse(
      { error: 'Empty submission' },
      400,
      request,
      env,
      ingestCorsHeaders(request)
    );
  }

  const spam = await scoreWithGeckodupe(env, clean);
  const origin = request.headers.get('Origin') || '';
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ipHash = ip ? await sha256Hex(ip + ':' + projectId) : null;
  const id = 'sub_' + randomToken(12);

  await env.DB.prepare(
    `INSERT INTO submissions (id, project_id, payload_json, spam_score, is_spam, kind, fingerprint, occurrence_count, level, ip_hash, origin)
     VALUES (?, ?, ?, ?, ?, 'form', ?, 1, NULL, ?, ?)`
  )
    .bind(
      id,
      projectId,
      JSON.stringify(clean),
      spam.score,
      spam.isSpam ? 1 : 0,
      spam.fingerprint || null,
      ipHash,
      origin || null
    )
    .run();

  try {
    await notifyOwner(env, project, id, clean, spam);
  } catch (err) {
    console.error('Flareform notify failed', err);
  }

  const next = String(fields._next || fields._redirect || '').trim();
  const wantsHtml =
    (request.headers.get('Accept') || '').includes('text/html') ||
    (request.headers.get('Content-Type') || '').includes('application/x-www-form-urlencoded');
  if (next && /^https?:\/\//i.test(next) && wantsHtml) {
    const headers = new Headers(ingestCorsHeaders(request));
    headers.set('Location', next);
    return new Response(null, { status: 303, headers });
  }

  return jsonResponse(
    {
      ok: true,
      id,
      spam: spam.isSpam,
      score: spam.score,
      images: storedImages
    },
    200,
    request,
    env,
    ingestCorsHeaders(request)
  );
}

async function handleLogIngest(
  request: Request,
  env: Env,
  project: any,
  projectId: string
): Promise<Response> {
  if (Number(project.logs_enabled) !== 1) {
    return jsonResponse(
      { error: 'Logs are disabled for this project' },
      403,
      request,
      env,
      ingestCorsHeaders(request)
    );
  }

  const originDenied = await checkOrigin(project, request, env);
  if (originDenied) return originDenied;

  let fields: Record<string, unknown>;
  try {
    fields = (await parseBody(request)).fields;
  } catch {
    return jsonResponse(
      { error: 'Invalid body' },
      400,
      request,
      env,
      ingestCorsHeaders(request)
    );
  }

  const clean = cleanFields(fields);
  const level = normalizeLogLevel(clean.level || clean.severity || clean.type);
  if (!WORRYFUL.has(level)) {
    return jsonResponse(
      { error: 'Only worryful levels accepted (error, fatal, critical, warn)', level },
      400,
      request,
      env,
      ingestCorsHeaders(request)
    );
  }
  clean.level = level;

  const message = String(clean.message || clean.error || clean.msg || '').trim();
  if (!message && !clean.stack) {
    return jsonResponse(
      { error: 'Log requires message or stack' },
      400,
      request,
      env,
      ingestCorsHeaders(request)
    );
  }

  const fpSeed =
    level +
    '|' +
    message.slice(0, 500) +
    '|' +
    String(clean.stack || '').slice(0, 400) +
    '|' +
    String(clean.url || clean.href || '');
  const localFp = await sha256Hex(fpSeed + '|' + projectId);

  const remote = await dedupeWithGeckodupe(env, {
    eventId: 'log_' + localFp.slice(0, 40),
    fields: clean,
    text: message || String(clean.stack || '')
  });
  const fingerprint = remote.fingerprint || localFp;

  const existing = await env.DB.prepare(
    `SELECT id, occurrence_count FROM submissions
     WHERE project_id = ? AND kind = 'log' AND fingerprint = ?
     ORDER BY created_at DESC LIMIT 1`
  )
    .bind(projectId, fingerprint)
    .first<{ id: string; occurrence_count: number }>();

  if (existing) {
    // Bump duplicate by fingerprint - does not consume extra quota
    const nextCount = Number(existing.occurrence_count || 1) + 1;
    await env.DB.prepare(
      `UPDATE submissions SET occurrence_count = ?, created_at = datetime('now'),
       payload_json = ?, read_at = NULL WHERE id = ?`
    )
      .bind(nextCount, JSON.stringify(clean), existing.id)
      .run();

    return jsonResponse(
      {
        ok: true,
        id: existing.id,
        duplicate: true,
        occurrenceCount: nextCount
      },
      200,
      request,
      env,
      ingestCorsHeaders(request)
    );
  }

  const quota = await checkQuota(env, String(project.owner_email || ''), request);
  if (quota) return quota;

  const spam = await scoreWithGeckodupe(env, clean);
  const origin = request.headers.get('Origin') || '';
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ipHash = ip ? await sha256Hex(ip + ':log:' + projectId) : null;
  const id = 'log_' + randomToken(12);

  await env.DB.prepare(
    `INSERT INTO submissions (id, project_id, payload_json, spam_score, is_spam, kind, fingerprint, occurrence_count, level, ip_hash, origin)
     VALUES (?, ?, ?, ?, ?, 'log', ?, 1, ?, ?, ?)`
  )
    .bind(
      id,
      projectId,
      JSON.stringify(clean),
      spam.score,
      spam.isSpam ? 1 : 0,
      fingerprint,
      level,
      ipHash,
      origin || null
    )
    .run();

  return jsonResponse(
    { ok: true, id, duplicate: false, occurrenceCount: 1 },
    200,
    request,
    env,
    ingestCorsHeaders(request)
  );
}

export async function handleIngestRoutes(
  request: Request,
  env: Env,
  path: string
): Promise<Response | null> {
  const formMatch = path.match(/^\/f\/([A-Za-z0-9_]+)$/);
  const logMatch =
    path.match(/^\/f\/([A-Za-z0-9_]+)\/log$/) || path.match(/^\/l\/([A-Za-z0-9_]+)$/);

  if (!formMatch && !logMatch) return null;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: ingestCorsHeaders(request) });
  }

  if (request.method !== 'POST') {
    return jsonResponse(
      { error: 'Method not allowed' },
      405,
      request,
      env,
      ingestCorsHeaders(request)
    );
  }

  const projectId = (logMatch || formMatch)![1];
  const project = await env.DB.prepare('SELECT * FROM projects WHERE id = ?')
    .bind(projectId)
    .first<any>();

  if (!project) {
    return jsonResponse({ error: 'Unknown project' }, 404, request, env, ingestCorsHeaders(request));
  }

  if (logMatch) return handleLogIngest(request, env, project, projectId);
  return handleFormIngest(request, env, project, projectId);
}
