# MSPoint Assist

**AI support assistant for small business websites.** MSPoint Assist reads a business's public website, answers visitor questions 24/7 using only that content (with source links), and captures leads when a person is needed. It installs with one line of code.

Live: **https://app.mspointbd.com** · A product of **MSPoint LLC** (USA)

## Features

- Self-serve onboarding: enter business name, website and mail address, get an assistant in about a minute
- Same-site crawler (sitemap-first, up to 12 pages on the free beta) built on `HTMLRewriter`
- Retrieval-augmented answers: Workers AI embeddings (`bge-base-en-v1.5`) + Vectorize search + Llama 3.3 70B
- Embeddable chat widget (Shadow DOM, no dependencies, ~9 KB) with lead-capture form
- Owner dashboard: status, usage, leads, CSV export, re-index, delete
- Free-plan quotas and spam guards (daily message cap per assistant, hourly lead cap, one free assistant per mail address)
- Owner keys stored only as SHA-256 hashes

## Architecture

Everything runs on Cloudflare's developer platform:

| Part | Cloudflare product |
|---|---|
| API and routing | Workers (`src/index.js`) |
| Landing page, dashboard, widget | Workers static assets (`public/`) |
| Embeddings and answers | Workers AI |
| Website knowledge (one namespace per assistant) | Vectorize |
| Assistants, leads, usage | D1 (`migrations/`) |
| Custom domain | `app.mspointbd.com` |

```
visitor ──► widget.js ──► /api/chat ──► Vectorize (namespace = bot) ──► Workers AI ──► answer + sources
owner   ──► /api/bots ──► crawler ──► chunk ──► Workers AI embeddings ──► Vectorize ; metadata ──► D1
```

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | – | Health check |
| POST | `/api/bots` | – | Create assistant and index the website |
| GET | `/api/bots/:id/public` | – | Public name and greeting (used by widget) |
| POST | `/api/chat` | – | Ask a question `{bot, message, history}` |
| POST | `/api/leads` | – | Submit a lead `{bot, name, email, phone, message}` |
| GET | `/api/bots/:id` | Bearer owner key | Assistant details and usage |
| GET | `/api/bots/:id/leads` | Bearer owner key | Leads |
| POST | `/api/bots/:id/reindex` | Bearer owner key | Re-crawl and re-index |
| DELETE | `/api/bots/:id` | Bearer owner key | Delete assistant and all data |

## Install on a website

```html
<script src="https://app.mspointbd.com/widget.js" data-bot="YOUR_ASSISTANT_ID" async></script>
```

Optional attributes: `data-color="#0f766e"`, `data-open="true"`.

## Setup (one time)

```bash
npm install
npx wrangler d1 create mspoint-assist          # paste database_id into wrangler.jsonc
npx wrangler vectorize create mspoint-assist --dimensions=768 --metric=cosine
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
```

### Continuous deployment

The Worker is connected to this repository with **Cloudflare Workers Builds**. Every push to `main` runs:

```
Build command:  npm test
Deploy command: npm run deploy:ci   (creates the Vectorize index if missing, applies D1 migrations, deploys)
```

GitHub Actions (`.github/workflows/ci.yml`) runs the unit tests and a `wrangler deploy --dry-run` on every push and pull request.

## Development

```bash
npm test            # unit tests (node --test)
npm run check       # bundle + config validation
npx wrangler dev    # local dev (AI and Vectorize use your Cloudflare account remotely)
```

## Roadmap

- Mail alerts for new leads
- Paid plans (Starter, Pro) with Stripe billing
- Custom branding and widget themes
- File uploads (PDF/FAQ) as knowledge sources via R2
- Conversation analytics and unanswered-question reports

## License

© MSPoint LLC. All rights reserved.
