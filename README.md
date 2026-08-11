# Flareform API

Open-source Cloudflare Worker powering [Flareform](https://github.com/Gekodupe/Flareform): Formspree-style form ingest, error logs, inbox, billing, and image uploads.

Optional edge spam/dedupe via [GeckodupeAPI](https://github.com/Gekodupe/GeckodupeAPI) (`GECKODUPE_SPAM_URL` / `GECKODUPE_API_KEY`).

## Deploy

```bash
npm install
cp .dev.vars.example .dev.vars
# Set BREVO_*, STRIPE_*, GECKODUPE_API_KEY, TURNSTILE_SECRET, etc.
npm run db:schema:remote   # fresh D1
# or: npm run db:migrate:remote   # existing D1 (ordered ALTER/INDEX)
npx wrangler deploy
```

Hosted: `https://flareform-api.nic-58f.workers.dev`

```bash
npm test
```

## Endpoints

| Path | Role |
|------|------|
| `POST /f/{id}` | Form submissions (+ images via multipart) |
| `POST /l/{id}` | Error logs |
| `GET /v1/files/{id}?t=` | Uploaded images (token or owner session) |
| `GET /v1/inbox` | Form inbox |
| `GET /v1/logs` | Deduped logs |
| `GET /v1/health` | Health |

Email verification is required to create/change projects, open billing, and mint API keys.

See frontend **Docs → API reference** for the full surface.

## License

MIT. See [LICENSE](./LICENSE).
