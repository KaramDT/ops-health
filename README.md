# Ops Health

A reusable Dynatrace app that shows the current health of every location a customer runs — stores, warehouses, offices, datacenters — in one dashboard. Backed by a synthetic ingest pipeline (bizevents + logs + metrics) so it demos safely without touching real data.

Built as an SE demo asset. Brand it per customer via the in-app Settings sheet — customer name, tile visibility, tile labels are all live-editable.

---

## Install (via Claude Code)

The whole deploy is agent-driven. Two commands, one question, done.

```bash
git clone https://github.com/KaramDT/ops-health.git
cd ops-health
```

Open the folder in **Claude Code** (or any Claude Agent SDK–powered coding agent) and say:

> **deploy this**

The agent reads [CLAUDE.md](./CLAUDE.md) and walks you through it. It will:

1. Ask for your **tenant URL** and a **platform token** (with a link to mint one with the right scopes).
2. Install dependencies, write your `.env`, point the app at your tenant.
3. Verify `dtctl` is installed (and install it via `brew` if not — waits for your one-time login).
4. Run the seed to backfill data and deploy the hourly "Ops Health Data" workflow.
5. Deploy the app to your tenant via `dt-app deploy` (pauses for the one OAuth prompt).
6. Hand you the deployed-app URL. You click the gear icon and brand it for your customer.

**Total time:** ~5 min end-to-end, minus tenant SSO round-trips.

---

## What you get

- **Overview page** — 4 status tiles (Stores / Warehouses / Offices / Datacenters), a hero-stat strip, and a "Sites needing attention" panel. All fed by real Grail queries against synthetic data.
- **Detail pages** — per-site-type tables with region/status/name filtering, an interactive map (marker click → focus row), and expandable rows showing per-signal metrics charts + filtered logs.
- **Settings sheet** — per-user, tenant-scoped. Change the customer name, hide tiles you don't demo, rename tiles for the customer's vocabulary (e.g. "Stores" → "Restaurants" for a QSR).
- **Hourly workflow** — the "Ops Health Data" AutomationEngine workflow that keeps ~350 bizevents + ~1150 logs + ~9000 metric samples flowing every hour without you re-running anything.

---

## Manual install (if you don't have Claude Code)

1. **Deps:** `npm install && cd ops-health && npm install && cd ..`
2. **Env:** `cp .env.example .env` and fill in `DT_ENV_URL` + `DT_PLATFORM_TOKEN` (needs `storage:events:write`, `logs.ingest`, `metrics.ingest`).
3. **Tenant:** edit `ops-health/app.config.json` — replace `environmentUrl` with your tenant URL.
4. **dtctl:** `brew install dynatrace-oss/tap/dtctl && dtctl auth login --context ops-health --environment "<your tenant URL>"`
5. **Data + workflow:** `npm run seed && npm run deploy:workflow`
6. **App:** `cd ops-health && npx dt-app deploy --optimize --no-open` — complete the OAuth flow when it prints an auth URL. When it prints `Open your deployed app: '<url>'`, open that URL.
7. **Brand it:** open the app → gear icon → set customer name.

---

## Repo layout

| Path | What lives here |
|---|---|
| [ops-health/](./ops-health) | The Dynatrace app — Strato + React + TypeScript, built with `dt-app`. |
| [scripts/seed-site-health.ts](./scripts/seed-site-health.ts) | Local one-shot data seeder. `npm run seed`. |
| [scripts/deploy-workflow.ts](./scripts/deploy-workflow.ts) | Assembles + deploys the workflow via `dtctl`. `npm run deploy:workflow`. |
| [automation/](./automation) | Workflow envelope (JSON) + JavaScript task that emits bizevents/logs/metrics. |
| [shared/schema/siteHealth.ts](./shared/schema/siteHealth.ts) | Schema constants (site types, categories, regions, statuses) shared between seed and workflow. |
| [.claude/skills/ops-health-seeder/SKILL.md](./.claude/skills/ops-health-seeder/SKILL.md) | Agent skill — walks a coding agent through generating a customer-specific ingest workflow. |
| [.env.example](./.env.example) | Env template. Real `.env` is gitignored. |
| [.mcp.json.example](./.mcp.json.example) | MCP config template if you're using Claude Code with the Dynatrace MCP server. |
| [CLAUDE.md](./CLAUDE.md) | Agent-facing deploy playbook. |

---

## Customizing beyond the Settings UI

If a customer's site inventory is meaningfully different (different site types, different categories, different scale), invoke the [ops-health-seeder](./.claude/skills/ops-health-seeder/SKILL.md) skill in your agent. It walks through generating a customer-specific ingest workflow — new site names, new categories, new schema — that plugs into the same app.
