export type PlanId = 'guest' | 'free' | 'starter' | 'pro';

export interface PlanLimits {
  maxProjects: number;
  submissionsPerMonth: number;
  imagesPerMonth: number;
  maxImageBytes: number;
  maxKeys: number;
}

export interface PlanInfo {
  id: PlanId;
  name: string;
  priceMonthly: number;
  blurb: string;
  limits: PlanLimits;
  features: string[];
}

export const PLANS: Record<PlanId, PlanInfo> = {
  guest: {
    id: 'guest',
    name: 'Guest',
    priceMonthly: 0,
    blurb: 'Sign in to create projects and receive submissions.',
    limits: {
      maxProjects: 0,
      submissionsPerMonth: 0,
      imagesPerMonth: 0,
      maxImageBytes: 0,
      maxKeys: 0
    },
    features: ['Browse the Flareform UI']
  },
  free: {
    id: 'free',
    name: 'Free',
    priceMonthly: 0,
    blurb: 'Hosted form endpoints for indie sites and early projects.',
    limits: {
      maxProjects: 3,
      submissionsPerMonth: 1000,
      imagesPerMonth: 50,
      maxImageBytes: 2 * 1024 * 1024,
      maxKeys: 2
    },
    features: [
      '3 projects',
      '1k forms+logs / month',
      '50 images / month',
      '2 API keys',
      'Inbox + logs + analytics'
    ]
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    priceMonthly: 19,
    blurb: 'For growing sites and agencies.',
    limits: {
      maxProjects: 15,
      submissionsPerMonth: 25000,
      imagesPerMonth: 2000,
      maxImageBytes: 2 * 1024 * 1024,
      maxKeys: 5
    },
    features: [
      '15 projects',
      '25k forms+logs / month',
      '2k images / month',
      '5 API keys',
      'Priority email support'
    ]
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceMonthly: 49,
    blurb: 'Production volumes and multi-project teams.',
    limits: {
      maxProjects: 100,
      submissionsPerMonth: 200000,
      imagesPerMonth: 20000,
      maxImageBytes: 2 * 1024 * 1024,
      maxKeys: 10
    },
    features: [
      '100 projects',
      '200k forms+logs / month',
      '20k images / month',
      '10 API keys',
      'Priority support'
    ]
  }
};

export const PUBLIC_PLAN_IDS: PlanId[] = ['free', 'starter', 'pro'];

export function parsePriceIds(raw: string | undefined): Record<string, string> {
  const defaults = {
    free: '',
    starter: 'price_1U1u6hGrsdJU1djqgYmoylSp',
    pro: 'price_1U1u6jGrsdJU1djqyssrZ6Od'
  };
  if (!raw) return defaults;
  try {
    const obj = JSON.parse(raw) as Record<string, string>;
    return {
      free: obj.free || defaults.free,
      starter: obj.starter || defaults.starter,
      pro: obj.pro || defaults.pro
    };
  } catch {
    return defaults;
  }
}

export function planFromPriceId(priceId: string, priceMap: Record<string, string>): PlanId {
  for (const [plan, id] of Object.entries(priceMap)) {
    if (id && id === priceId) return plan as PlanId;
  }
  return 'free';
}

export function normalizePlan(plan: string | undefined | null): PlanId {
  if (plan === 'starter' || plan === 'pro' || plan === 'free' || plan === 'guest') return plan;
  return 'free';
}
