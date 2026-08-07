import type { Env } from './env.ts';
import { PLANS, normalizePlan, type PlanId } from './plans.ts';

export async function getUser(env: Env, email: string): Promise<any | null> {
  return (await env.FLAREFORM.get('user:' + email, 'json')) as any;
}

export async function putUser(env: Env, user: any): Promise<void> {
  await env.FLAREFORM.put('user:' + user.email, JSON.stringify(user));
}

/**
 * Effective plan for limits.
 * Signed-in users without a paid Stripe subscription stay on Free.
 * Starter/Pro require active/trialing subscription.
 */
export function userPlan(user: any | null): PlanId {
  if (!user) return 'guest';
  const plan = normalizePlan(user.plan);
  if (plan === 'guest') return 'free';
  if (plan === 'starter' || plan === 'pro') {
    const status = String(user.planStatus || 'none');
    const paidStatus = status === 'active' || status === 'trialing';
    if (!paidStatus || !user.stripeSubscriptionId) return 'free';
  }
  return plan;
}

export function planLimits(user: any | null) {
  return PLANS[userPlan(user)].limits;
}
