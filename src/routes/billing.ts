import { requireSession, requireVerifiedEmail } from '../lib/auth.ts';
import { jsonResponse } from '../lib/cors.ts';
import type { Env } from '../lib/env.ts';
import { PLANS, PUBLIC_PLAN_IDS, planFromPriceId, type PlanId } from '../lib/plans.ts';
import { getPriceIds, stripeRequest, verifyStripeSignature } from '../lib/stripe.ts';
import { getUser, putUser, userPlan } from '../lib/users.ts';
import { readJsonBody } from '../lib/validate.ts';

function appOrigin(env: Env): string {
  return (env.APP_ORIGIN || 'https://flareform.com').replace(/\/+$/, '');
}

async function ensureStripeCustomer(env: Env, email: string, user: any): Promise<string | null> {
  if (user.stripeCustomerId) return user.stripeCustomerId;
  const created = await stripeRequest(env, 'POST', '/customers', {
    email,
    'metadata[flareform_email]': email
  });
  if (!created.ok) return null;
  user.stripeCustomerId = created.data.id;
  await putUser(env, user);
  return user.stripeCustomerId as string;
}

async function applyPlanToEmail(env: Env, email: string, plan: PlanId, status: string, subId?: string) {
  const user = (await getUser(env, email)) || { email, createdAt: Date.now(), projectIds: [] };
  user.email = email;
  user.plan = plan;
  user.planStatus = status;
  if (subId) user.stripeSubscriptionId = subId;
  if (status === 'canceled') {
    user.plan = 'free';
    user.stripeSubscriptionId = '';
  }
  await putUser(env, user);
}

export async function handleBillingRoutes(
  request: Request,
  env: Env,
  path: string
): Promise<Response | null> {
  if (!path.startsWith('/v1/billing')) return null;

  if (path === '/v1/billing/plans' && request.method === 'GET') {
    const prices = getPriceIds(env);
    const list = PUBLIC_PLAN_IDS.map((id) => ({
      ...PLANS[id],
      priceId: prices[id] || null,
      stripeConfigured: !!env.STRIPE_SECRET_KEY && !!prices[id]
    }));
    return jsonResponse(
      {
        plans: list,
        stripeConfigured: !!env.STRIPE_SECRET_KEY
      },
      200,
      request,
      env
    );
  }

  if (path === '/v1/billing/webhook' && request.method === 'POST') {
    const payload = await request.text();
    const sig = request.headers.get('Stripe-Signature');
    if (!env.STRIPE_WEBHOOK_SECRET) {
      return jsonResponse({ error: 'Webhook not configured' }, 503, request, env);
    }
    const valid = await verifyStripeSignature(payload, sig, env.STRIPE_WEBHOOK_SECRET);
    if (!valid) return jsonResponse({ error: 'Invalid signature' }, 400, request, env);

    let event: any;
    try {
      event = JSON.parse(payload);
    } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400, request, env);
    }

    const prices = getPriceIds(env);
    const type = event.type as string;
    const obj = event.data && event.data.object;

    if (type === 'checkout.session.completed' && obj) {
      // Prefer merchant-controlled identity; never trust checkout-entered customer_email first
      const email = String(
        obj.metadata?.flareform_email || obj.client_reference_id || obj.customer_email || ''
      )
        .trim()
        .toLowerCase();
      const planMeta = (obj.metadata && obj.metadata.plan) as string | undefined;
      let plan: PlanId =
        planMeta === 'starter' || planMeta === 'pro' || planMeta === 'free' ? planMeta : 'starter';
      // Prefer price id when present on the session line items
      const linePrice =
        obj.line_items?.data?.[0]?.price?.id ||
        (Array.isArray(obj.display_items) && obj.display_items[0]?.price?.id) ||
        '';
      if (linePrice) {
        const fromPrice = planFromPriceId(String(linePrice), prices);
        if (fromPrice === 'starter' || fromPrice === 'pro') plan = fromPrice;
      }
      if (email) {
        const user = (await getUser(env, email)) || { email, createdAt: Date.now(), projectIds: [] };
        if (obj.customer) {
          user.stripeCustomerId = obj.customer;
          await env.FLAREFORM.put('stripe_customer:' + obj.customer, email);
        }
        if (obj.subscription) user.stripeSubscriptionId = obj.subscription;
        user.plan = plan;
        user.planStatus = 'active';
        user.email = email;
        await putUser(env, user);
      }
    }

    if ((type === 'customer.subscription.updated' || type === 'customer.subscription.deleted') && obj) {
      const customerId = obj.customer as string;
      const email = await env.FLAREFORM.get('stripe_customer:' + customerId);
      const priceId =
        obj.items && obj.items.data && obj.items.data[0] && obj.items.data[0].price
          ? obj.items.data[0].price.id
          : '';
      const plan = planFromPriceId(priceId, prices);
      if (email) {
        if (type === 'customer.subscription.deleted') {
          await applyPlanToEmail(env, email, 'free', 'canceled', obj.id);
        } else {
          await applyPlanToEmail(env, email, plan, obj.status || 'active', obj.id);
        }
      }
    }

    if (type === 'invoice.paid' && obj && obj.customer) {
      const email = await env.FLAREFORM.get('stripe_customer:' + obj.customer);
      if (email) {
        const user = await getUser(env, email);
        if (user) {
          user.planStatus = 'active';
          await putUser(env, user);
        }
      }
    }

    if (type === 'invoice.payment_failed' && obj && obj.customer) {
      const email = await env.FLAREFORM.get('stripe_customer:' + obj.customer);
      if (email) {
        const user = await getUser(env, email);
        if (user) {
          user.planStatus = 'past_due';
          await putUser(env, user);
        }
      }
    }

    return jsonResponse({ received: true }, 200, request, env);
  }

  const session = await requireSession(request, env);
  if (!session.ok) return jsonResponse({ error: session.error }, 401, request, env);
  if (session.via === 'api_key') {
    return jsonResponse(
      { error: 'Billing requires a browser session, not an API key' },
      403,
      request,
      env
    );
  }
  const email = session.email;
  let user = (await getUser(env, email)) || {
    email,
    createdAt: Date.now(),
    projectIds: [],
    plan: 'free',
    planStatus: 'none'
  };

  if (path === '/v1/billing/checkout' && request.method === 'POST') {
    const verified = await requireVerifiedEmail(env, email);
    if (!verified.ok) {
      return jsonResponse(
        { error: verified.error, code: verified.code },
        verified.status,
        request,
        env
      );
    }
    user = verified.user;

    const parsed = await readJsonBody(request, 8 * 1024);
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status, request, env);
    const plan = String(parsed.body.plan || '');
    if (plan !== 'starter' && plan !== 'pro') {
      return jsonResponse(
        { error: 'Choose starter or pro. Free plan needs no checkout.' },
        400,
        request,
        env
      );
    }
    const prices = getPriceIds(env);
    const priceId = prices[plan];
    if (!priceId) return jsonResponse({ error: 'Price not configured' }, 503, request, env);
    if (!env.STRIPE_SECRET_KEY) {
      return jsonResponse({ error: 'Stripe not configured' }, 503, request, env);
    }

    const customerId = await ensureStripeCustomer(env, email, user);
    if (customerId) {
      await env.FLAREFORM.put('stripe_customer:' + customerId, email);
      user = (await getUser(env, email)) || user;
    }

    const origin = appOrigin(env);
    const sessionRes = await stripeRequest(env, 'POST', '/checkout/sessions', {
      mode: 'subscription',
      customer: customerId || undefined,
      customer_email: customerId ? undefined : email,
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      success_url: origin + '/#pricing?checkout=success',
      cancel_url: origin + '/#pricing?checkout=cancel',
      client_reference_id: email,
      'metadata[flareform_email]': email,
      'metadata[plan]': plan,
      'subscription_data[metadata][flareform_email]': email,
      'subscription_data[metadata][plan]': plan
    });

    if (!sessionRes.ok) {
      console.error('Flareform Stripe checkout failed', sessionRes.error);
      return jsonResponse({ error: 'Checkout unavailable. Try again shortly.' }, 502, request, env);
    }
    return jsonResponse(
      { ok: true, url: sessionRes.data.url, id: sessionRes.data.id },
      200,
      request,
      env
    );
  }

  if (path === '/v1/billing/portal' && request.method === 'POST') {
    const verified = await requireVerifiedEmail(env, email);
    if (!verified.ok) {
      return jsonResponse(
        { error: verified.error, code: verified.code },
        verified.status,
        request,
        env
      );
    }
    user = verified.user;
    if (!env.STRIPE_SECRET_KEY) {
      return jsonResponse({ error: 'Stripe not configured' }, 503, request, env);
    }
    const customerId = await ensureStripeCustomer(env, email, user);
    if (!customerId) return jsonResponse({ error: 'Could not open billing portal' }, 502, request, env);
    await env.FLAREFORM.put('stripe_customer:' + customerId, email);
    const origin = appOrigin(env);
    const portal = await stripeRequest(env, 'POST', '/billing_portal/sessions', {
      customer: customerId,
      return_url: origin + '/#account'
    });
    if (!portal.ok) {
      console.error('Flareform Stripe portal failed', portal.error);
      return jsonResponse({ error: 'Billing portal unavailable. Try again shortly.' }, 502, request, env);
    }
    return jsonResponse({ ok: true, url: portal.data.url }, 200, request, env);
  }

  if (path === '/v1/billing/status' && request.method === 'GET') {
    const plan = userPlan(user);
    return jsonResponse(
      {
        plan,
        planName: PLANS[plan].name,
        planStatus: user.planStatus || 'none',
        paid: plan === 'starter' || plan === 'pro',
        stripeCustomer: !!user.stripeCustomerId,
        stripeConfigured: !!env.STRIPE_SECRET_KEY
      },
      200,
      request,
      env
    );
  }

  return jsonResponse({ error: 'Not found' }, 404, request, env);
}
