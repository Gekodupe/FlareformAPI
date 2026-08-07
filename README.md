# Flareform API

Open-source Cloudflare Worker powering [Flareform](https://github.com/Gekodupe/Flareform) — Formspree-style form ingest, error logs, inbox, billing, and image uploads.

**Repo:** [Gekodupe/FlareformAPI](https://github.com/Gekodupe/FlareformAPI) · **Org:** [Gekodupe](https://github.com/orgs/Gekodupe)

## Deploy

```bash
npm install
cp .dev.vars.example .dev.vars
# Set BREVO_*, STRIPE_*, GECKODUPE_API_KEY, etc.
npx wrangler deploy
```

Hosted: `https://flareform-api.nic-58f.workers.dev`

## Endpoints

| Path | Role |
|------|------|
| `POST /f/{id}` | Form submissions (+ images via multipart) |
| `POST /l/{id}` | Error logs |
| `GET /v1/files/{id}` | Uploaded images |
| `GET /v1/inbox` | Form inbox |
| `GET /v1/logs` | Deduped logs |
| `GET /v1/health` | Health |

See frontend **Docs → API reference** for the full surface.

## License

MIT
