import {
  normalizeEmail,
  requireSession,
  extractBearerToken,
  revokeSessionsForEmail,
  revokeApiKeysForUser
} from '../lib/auth.ts';
import { sendBrevoEmail } from '../lib/brevo.ts';
import { randomCode, randomToken } from '../lib/crypto-util.ts';
import { jsonResponse } from '../lib/cors.ts';
import type { Env } from '../lib/env.ts';
import { hashPassword, passwordStrengthOk, verifyPassword } from '../lib/password.ts';
import { getUser, putUser, userPlan } from '../lib/users.ts';
import { PLANS } from '../lib/plans.ts';
import { readJsonBody } from '../lib/validate.ts';
import { clientIp, rateOk } from '../lib/rate-limit.ts';

const MAGIC_TTL_SEC = 15 * 60;
const VERIFY_TTL_SEC = 24 * 60 * 60;
const RESET_TTL_SEC = 60 * 60;
const SESSION_SHORT_SEC = 7 * 24 * 60 * 60;
const SESSION_LONG_SEC = 30 * 24 * 60 * 60;

function appOrigin(env: Env): string {
  return (env.APP_ORIGIN || 'https://flareform.com').replace(/\/+$/, '');
}

async function createSession(
  env: Env,
  email: string,
  rememberMe: boolean
): Promise<{ sessionId: string; expiresIn: number }> {
  const expiresIn = rememberMe ? SESSION_LONG_SEC : SESSION_SHORT_SEC;
  const sessionId = 'sess_' + randomToken(24);
  const user = await getUser(env, email);
  const sessionVersion = Number(user?.sessionVersion || 0);
  await env.FLAREFORM.put(
    'session:' + sessionId,
    JSON.stringify({
      email,
      exp: Date.now() + expiresIn * 1000,
      rememberMe: !!rememberMe,
      v: sessionVersion
    }),
    { expirationTtl: expiresIn }
  );
  const listKey = 'sessions:' + email;
  const prev = ((await env.FLAREFORM.get(listKey, 'json')) as string[] | null) || [];
  const next = [...prev.filter((id) => id && id !== sessionId), sessionId].slice(-40);
  await env.FLAREFORM.put(listKey, JSON.stringify(next), { expirationTtl: SESSION_LONG_SEC });
  return { sessionId, expiresIn };
}

async function invalidateCredentialsAfterPasswordChange(env: Env, email: string, user: any): Promise<void> {
  user.sessionVersion = Number(user.sessionVersion || 0) + 1;
  await revokeApiKeysForUser(env, user);
  user.keyIds = [];
  await putUser(env, user);
  await revokeSessionsForEmail(env, email);
}

function ensureUserShape(email: string, existing: any | null): any {
  const base = existing && existing.email ? existing : { email, createdAt: Date.now(), projectIds: [] };
  return {
    ...base,
    email,
    projectIds: Array.isArray(base.projectIds) ? base.projectIds : [],
    plan: base.plan && base.plan !== 'guest' ? base.plan : 'free',
    planStatus: base.planStatus || 'none',
    emailVerified: !!base.emailVerified
  };
}

export async function handleAuthRoutes(request: Request, env: Env, path: string): Promise<Response | null> {
  if (!path.startsWith('/v1/auth/')) return null;

  if (path === '/v1/auth/register' && request.method === 'POST') {
    if (!(await rateOk(env, 'auth-reg:' + clientIp(request), 'auth'))) {
      return jsonResponse({ error: 'Rate limit exceeded' }, 429, request);
    }
    const parsed = await readJsonBody(request, 8 * 1024);
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status, request);
    const email = normalizeEmail(String(parsed.body.email || ''));
    const password = String(parsed.body.password || '');
    const rememberMe = !!parsed.body.rememberMe;
    if (!email) return jsonResponse({ error: 'Enter a valid email' }, 400, request);
    const strength = passwordStrengthOk(password);
    if (strength) return jsonResponse({ error: strength }, 400, request);

    const existing = await getUser(env, email);
    if (existing && existing.passwordHash) {
      // Avoid account enumeration: same shape as a soft success, no session issued
      await sendBrevoEmail(env, {
        to: email,
        subject: 'Flareform sign-in reminder',
        html:
          '<div style="font-family:Poppins,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">' +
          '<p style="color:#f7831e;text-transform:uppercase;letter-spacing:0.08em;font-size:13px">Flareform</p>' +
          '<h1 style="font-weight:400">You already have an account</h1>' +
          '<p style="color:#484848">Someone tried to register with this email. If that was you, sign in instead (or reset your password).</p>' +
          '<p><a href="' +
          appOrigin(env) +
          '/#account" style="color:#f7831e">Sign in to Flareform</a></p></div>',
        text: 'You already have a Flareform account. Sign in at ' + appOrigin(env) + '/#account'
      }).catch(() => ({ ok: false as const, error: 'send_failed' }));
      return jsonResponse(
        {
          ok: true,
          message: 'Check your email to continue.',
          emailSent: true
        },
        200,
        request
      );
    }

    const { salt, hash } = await hashPassword(password);
    const user = ensureUserShape(email, existing);
    user.passwordSalt = salt;
    user.passwordHash = hash;
    // Preserve verification if this email already signed in via magic link
    user.emailVerified = !!(existing && existing.emailVerified);
    user.plan = user.plan && user.plan !== 'guest' ? user.plan : 'free';
    user.planStatus = user.planStatus || 'none';
    await putUser(env, user);

    const verifyToken = 'ver_' + randomToken(18);
    await env.FLAREFORM.put(
      'verify:' + verifyToken,
      JSON.stringify({ email, exp: Date.now() + VERIFY_TTL_SEC * 1000 }),
      { expirationTtl: VERIFY_TTL_SEC }
    );
    const link = appOrigin(env) + '/#account?verify=' + encodeURIComponent(verifyToken);
    const mailed = await sendBrevoEmail(env, {
      to: email,
      subject: 'Verify your Flareform email',
      html:
        '<div style="font-family:Poppins,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">' +
        '<p style="color:#f7831e;text-transform:uppercase;letter-spacing:0.08em;font-size:13px">Flareform</p>' +
        '<h1 style="font-weight:400">Verify your email</h1>' +
        '<p style="color:#484848">Confirm this address to unlock API keys and billing.</p>' +
        '<p><a href="' +
        link +
        '" style="color:#f7831e">Verify email</a></p>' +
        '<p style="font-size:12px;color:#6b7280">Blacnova Development &lt;nic@blacnova.net&gt;</p></div>',
      text: 'Verify your Flareform email: ' + link
    });

    const session = await createSession(env, email, rememberMe);
    return jsonResponse(
      {
        ok: true,
        session: session.sessionId,
        email,
        expiresIn: session.expiresIn,
        emailVerified: !!user.emailVerified,
        plan: userPlan(user),
        emailSent: mailed.ok,
        message: mailed.ok
          ? 'Account created. Check your email to verify.'
          : 'Account created, but verification email could not be sent. Use Resend verification after sign-in.'
      },
      201,
      request
    );
  }

  if (path === '/v1/auth/login' && request.method === 'POST') {
    if (!(await rateOk(env, 'auth-login:' + clientIp(request), 'auth'))) {
      return jsonResponse({ error: 'Rate limit exceeded' }, 429, request);
    }
    const parsed = await readJsonBody(request, 8 * 1024);
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status, request);
    const email = normalizeEmail(String(parsed.body.email || ''));
    const password = String(parsed.body.password || '');
    const rememberMe = !!parsed.body.rememberMe;
    if (!email || !password) return jsonResponse({ error: 'Email and password required' }, 400, request);

    const user = await getUser(env, email);
    if (!user || !user.passwordHash || !user.passwordSalt) {
      return jsonResponse({ error: 'Invalid email or password' }, 401, request);
    }
    const ok = await verifyPassword(password, user.passwordSalt, user.passwordHash);
    if (!ok) return jsonResponse({ error: 'Invalid email or password' }, 401, request);

    const session = await createSession(env, email, rememberMe);
    return jsonResponse(
      {
        ok: true,
        session: session.sessionId,
        email,
        expiresIn: session.expiresIn,
        emailVerified: !!user.emailVerified,
        plan: userPlan(user)
      },
      200,
      request
    );
  }

  if (path === '/v1/auth/forgot' && request.method === 'POST') {
    if (!(await rateOk(env, 'auth-forgot:' + clientIp(request), 'auth'))) {
      return jsonResponse({ error: 'Rate limit exceeded' }, 429, request);
    }
    const parsed = await readJsonBody(request, 8 * 1024);
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status, request);
    const email = normalizeEmail(String(parsed.body.email || ''));
    // Always return ok to avoid account enumeration
    if (email) {
      const user = await getUser(env, email);
      if (user && user.passwordHash) {
        const token = 'rst_' + randomToken(18);
        await env.FLAREFORM.put(
          'reset:' + token,
          JSON.stringify({ email, exp: Date.now() + RESET_TTL_SEC * 1000 }),
          { expirationTtl: RESET_TTL_SEC }
        );
        const link = appOrigin(env) + '/#account?reset=' + encodeURIComponent(token);
        await sendBrevoEmail(env, {
          to: email,
          subject: 'Reset your Flareform password',
          html:
            '<div style="font-family:Poppins,Arial,sans-serif;max-width:520px;margin:0 auto">' +
            '<h1 style="font-weight:400">Reset password</h1>' +
            '<p>This link expires in 1 hour.</p>' +
            '<p><a href="' +
            link +
            '" style="color:#f7831e">Choose a new password</a></p></div>',
          text: 'Reset your Flareform password: ' + link
        });
      }
    }
    return jsonResponse({ ok: true, message: 'If that email exists, a reset link is on the way.' }, 200, request);
  }

  if (path === '/v1/auth/reset' && request.method === 'POST') {
    if (!(await rateOk(env, 'auth-reset:' + clientIp(request), 'auth'))) {
      return jsonResponse({ error: 'Rate limit exceeded' }, 429, request);
    }
    const parsed = await readJsonBody(request, 8 * 1024);
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status, request);
    const token = String(parsed.body.token || '').trim();
    const password = String(parsed.body.password || '');
    const strength = passwordStrengthOk(password);
    if (strength) return jsonResponse({ error: strength }, 400, request);
    if (!token || token.indexOf('rst_') !== 0) return jsonResponse({ error: 'Invalid reset link' }, 400, request);

    const reset = (await env.FLAREFORM.get('reset:' + token, 'json')) as { email?: string; exp?: number } | null;
    if (!reset || !reset.email || (reset.exp && reset.exp < Date.now())) {
      return jsonResponse({ error: 'Reset link expired' }, 400, request);
    }
    const email = String(reset.email).toLowerCase();
    const user = ensureUserShape(email, await getUser(env, email));
    const { salt, hash } = await hashPassword(password);
    user.passwordSalt = salt;
    user.passwordHash = hash;
    await env.FLAREFORM.delete('reset:' + token);
    await invalidateCredentialsAfterPasswordChange(env, email, user);
    return jsonResponse({ ok: true, message: 'Password updated. You can sign in now.' }, 200, request);
  }

  if (path === '/v1/auth/verify-email' && request.method === 'POST') {
    if (!(await rateOk(env, 'auth-verify-email:' + clientIp(request), 'auth'))) {
      return jsonResponse({ error: 'Rate limit exceeded' }, 429, request);
    }
    const parsed = await readJsonBody(request, 8 * 1024);
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status, request);
    const token = String(parsed.body.token || parsed.body.verify || '').trim();
    if (!token || token.indexOf('ver_') !== 0) return jsonResponse({ error: 'Invalid verification link' }, 400, request);
    const row = (await env.FLAREFORM.get('verify:' + token, 'json')) as { email?: string; exp?: number } | null;
    if (!row || !row.email || (row.exp && row.exp < Date.now())) {
      return jsonResponse({ error: 'Verification link expired' }, 400, request);
    }
    const email = String(row.email).toLowerCase();
    const user = ensureUserShape(email, await getUser(env, email));
    user.emailVerified = true;
    await putUser(env, user);
    await env.FLAREFORM.delete('verify:' + token);
    return jsonResponse({ ok: true, email, emailVerified: true }, 200, request);
  }

  if (path === '/v1/auth/start' && request.method === 'POST') {
    if (!(await rateOk(env, 'auth-start:' + clientIp(request), 'auth'))) {
      return jsonResponse({ error: 'Rate limit exceeded' }, 429, request);
    }

    const parsed = await readJsonBody(request, 8 * 1024);
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status, request);
    const email = normalizeEmail(String(parsed.body.email || ''));
    if (!email) return jsonResponse({ error: 'Enter a valid email' }, 400, request);

    if (!(await rateOk(env, 'auth-email:' + email, 'auth'))) {
      return jsonResponse({ error: 'Too many sign-in attempts for this email' }, 429, request);
    }

    const token = 'mag_' + randomToken(18);
    const code = randomCode(6);
    const payload = { email, code, exp: Date.now() + MAGIC_TTL_SEC * 1000 };
    await env.FLAREFORM.put('magic:' + token, JSON.stringify(payload), {
      expirationTtl: MAGIC_TTL_SEC
    });
    await env.FLAREFORM.put('magiccode:' + email + ':' + code, token, {
      expirationTtl: MAGIC_TTL_SEC
    });

    const link = appOrigin(env) + '/#account?auth=' + encodeURIComponent(token);
    const html =
      '<div style="font-family:Poppins,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">' +
      '<p style="font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#f7831e">Flareform</p>' +
      '<h1 style="font-weight:400;font-size:28px;margin:8px 0 12px">Your sign-in code</h1>' +
      '<p style="color:#484848;font-size:15px">Use this code in the Account tab, or open the secure link below. It expires in 15 minutes.</p>' +
      '<p style="font-size:32px;letter-spacing:0.2em;margin:24px 0">' +
      code +
      '</p>' +
      '<p><a href="' +
      link +
      '" style="color:#f7831e">Sign in to Flareform</a></p>' +
      '<p style="font-size:12px;color:#6b7280;margin-top:32px">Blacnova Development &lt;nic@blacnova.net&gt;</p>' +
      '</div>';
    const text =
      'Your Flareform sign-in code is ' + code + '\n\nOr open: ' + link + '\n\nExpires in 15 minutes.';

    const sent = await sendBrevoEmail(env, {
      to: email,
      subject: 'Your Flareform sign-in code',
      html,
      text
    });

    if (!sent.ok) {
      console.error('Flareform magic-link email failed', sent.error);
      return jsonResponse({ error: 'Could not send sign-in email. Try again shortly.' }, 502, request);
    }

    return jsonResponse(
      {
        ok: true,
        email,
        message: 'Check your email for a sign-in code and link.'
      },
      200,
      request
    );
  }

  if (path === '/v1/auth/verify' && request.method === 'POST') {
    if (!(await rateOk(env, 'auth-verify:' + clientIp(request), 'auth'))) {
      return jsonResponse({ error: 'Rate limit exceeded' }, 429, request);
    }

    const parsed = await readJsonBody(request, 8 * 1024);
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status, request);

    let token = String(parsed.body.token || parsed.body.auth || '').trim();
    const code = String(parsed.body.code || '')
      .trim()
      .toUpperCase();
    const emailHint = normalizeEmail(String(parsed.body.email || ''));
    const rememberMe = parsed.body.rememberMe === true;

    if (!token && code && emailHint) {
      token = (await env.FLAREFORM.get('magiccode:' + emailHint + ':' + code)) || '';
    }

    if (!token || token.indexOf('mag_') !== 0) {
      return jsonResponse({ error: 'Invalid or expired sign-in code' }, 400, request);
    }

    const magic = (await env.FLAREFORM.get('magic:' + token, 'json')) as
      | { email?: string; code?: string; exp?: number }
      | null;
    if (!magic || !magic.email) {
      return jsonResponse({ error: 'Invalid or expired sign-in code' }, 400, request);
    }
    if (magic.exp && magic.exp < Date.now()) {
      await env.FLAREFORM.delete('magic:' + token);
      return jsonResponse({ error: 'Sign-in code expired' }, 400, request);
    }
    if (code && magic.code && code !== String(magic.code).toUpperCase()) {
      return jsonResponse({ error: 'Invalid or expired sign-in code' }, 400, request);
    }

    const email = String(magic.email).toLowerCase();
    await env.FLAREFORM.delete('magic:' + token);
    if (magic.code) await env.FLAREFORM.delete('magiccode:' + email + ':' + magic.code);

    const user = ensureUserShape(email, await getUser(env, email));
    user.emailVerified = true;
    await putUser(env, user);

    const session = await createSession(env, email, rememberMe);
    return jsonResponse(
      {
        ok: true,
        session: session.sessionId,
        email,
        expiresIn: session.expiresIn,
        emailVerified: true,
        plan: userPlan(user)
      },
      200,
      request
    );
  }

  if (path === '/v1/auth/logout' && request.method === 'POST') {
    const token = extractBearerToken(request);
    if (token && token.indexOf('sess_') === 0) {
      await env.FLAREFORM.delete('session:' + token);
    }
    return jsonResponse({ ok: true }, 200, request);
  }

  if (path === '/v1/auth/resend-verify' && request.method === 'POST') {
    const session = await requireSession(request, env);
    if (!session.ok) return jsonResponse({ error: session.error }, 401, request);
    if (!(await rateOk(env, 'auth-resend:' + session.email, 'auth'))) {
      return jsonResponse({ error: 'Rate limit exceeded' }, 429, request);
    }
    const user = ensureUserShape(session.email, await getUser(env, session.email));
    if (user.emailVerified) {
      return jsonResponse({ ok: true, message: 'Email already verified.' }, 200, request);
    }
    const verifyToken = 'ver_' + randomToken(18);
    await env.FLAREFORM.put(
      'verify:' + verifyToken,
      JSON.stringify({ email: session.email, exp: Date.now() + VERIFY_TTL_SEC * 1000 }),
      { expirationTtl: VERIFY_TTL_SEC }
    );
    const link = appOrigin(env) + '/#account?verify=' + encodeURIComponent(verifyToken);
    const mailed = await sendBrevoEmail(env, {
      to: session.email,
      subject: 'Verify your Flareform email',
      html:
        '<div style="font-family:Poppins,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">' +
        '<p style="color:#f7831e;text-transform:uppercase;letter-spacing:0.08em;font-size:13px">Flareform</p>' +
        '<h1 style="font-weight:400">Verify your email</h1>' +
        '<p><a href="' +
        link +
        '" style="color:#f7831e">Verify email</a></p></div>',
      text: 'Verify your Flareform email: ' + link
    });
    if (!mailed.ok) {
      console.error('Flareform verify-email send failed', mailed.error);
      return jsonResponse({ error: 'Could not send verification email. Try again shortly.' }, 502, request);
    }
    return jsonResponse({ ok: true, message: 'Verification email sent.', emailSent: true }, 200, request);
  }

  if (path === '/v1/auth/me' && request.method === 'GET') {
    const session = await requireSession(request, env);
    if (!session.ok) return jsonResponse({ error: session.error }, 401, request);
    const user = ensureUserShape(session.email, await getUser(env, session.email));
    const plan = userPlan(user);
    return jsonResponse(
      {
        ok: true,
        email: session.email,
        emailVerified: !!user.emailVerified,
        plan,
        planStatus: user.planStatus || 'none',
        limits: PLANS[plan].limits
      },
      200,
      request
    );
  }

  return jsonResponse({ error: 'Not found' }, 404, request);
}
