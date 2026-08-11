import { corsHeaders, jsonResponse } from './lib/cors.ts';
import type { Env } from './lib/env.ts';
import { handleAuthRoutes } from './routes/auth.ts';
import { handleAccountRoutes } from './routes/account.ts';
import { handleProjectRoutes } from './routes/projects.ts';
import { handleInboxRoutes } from './routes/inbox.ts';
import { handleIngestRoutes } from './routes/ingest.ts';
import { handleAnalyticsRoutes } from './routes/analytics.ts';
import { handleBillingRoutes } from './routes/billing.ts';
import { handleSupportRoutes } from './routes/support.ts';
import { handleLogsRoutes } from './routes/logs.ts';
import { handleFileRoutes } from './routes/files.ts';

export type { Env };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';

      if (request.method === 'OPTIONS') {
        if (path.startsWith('/f/') || path.startsWith('/l/') || path.startsWith('/v1/files/')) {
          const { ingestCorsHeaders } = await import('./lib/cors.ts');
          return new Response(null, { status: 204, headers: ingestCorsHeaders(request) });
        }
        return new Response(null, { status: 204, headers: corsHeaders(request, env) });
      }

      if (path === '/v1/health' || path === '/health') {
        return jsonResponse(
          {
            ok: true,
            service: 'flareform-api',
            version: '0.5.0',
            time: new Date().toISOString()
          },
          200,
          request,
          env
        );
      }

      const files = await handleFileRoutes(request, env, path);
      if (files) return files;

      const ingest = await handleIngestRoutes(request, env, path, ctx);
      if (ingest) return ingest;

      const auth = await handleAuthRoutes(request, env, path);
      if (auth) return auth;

      const account = await handleAccountRoutes(request, env, path);
      if (account) return account;

      const billing = await handleBillingRoutes(request, env, path);
      if (billing) return billing;

      const support = await handleSupportRoutes(request, env, path);
      if (support) return support;

      const projects = await handleProjectRoutes(request, env, path);
      if (projects) return projects;

      const inbox = await handleInboxRoutes(request, env, path);
      if (inbox) return inbox;

      const logs = await handleLogsRoutes(request, env, path);
      if (logs) return logs;

      const analytics = await handleAnalyticsRoutes(request, env, path);
      if (analytics) return analytics;

      return jsonResponse({ error: 'Not found' }, 404, request, env);
    } catch (err) {
      console.error('Flareform worker error', err);
      return jsonResponse({ error: 'Internal error' }, 500, request, env);
    }
  }
} satisfies ExportedHandler<Env>;
