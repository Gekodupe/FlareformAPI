export interface Env {
  FLAREFORM: KVNamespace;
  DB: D1Database;
  SPAM_RATE_LIMITER?: {
    limit(opts: { key: string }): Promise<{ success: boolean }>;
  };
  BREVO_API_KEY?: string;
  BREVO_SENDER_EMAIL?: string;
  BREVO_SENDER_NAME?: string;
  SUPPORT_INBOX?: string;
  APP_ORIGIN?: string;
  CORS_ORIGINS?: string;
  TURNSTILE_SECRET?: string;
  GECKODUPE_SPAM_URL?: string;
  GECKODUPE_API_KEY?: string;
  SPAM_FAIL_MODE?: string;
  ALLOW_OPEN_API?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_PRICE_IDS?: string;
  STRIPE_WEBHOOK_SECRET?: string;
}
