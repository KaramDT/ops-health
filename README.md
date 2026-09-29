# Ops Health

A Dynatrace app that shows the current health of every location a customer runs — stores, warehouses, offices, datacenters — in one dashboard. Backed entirely by synthetic bizevents and logs, so it's safe to demo without touching a customer's real data.

Built as a reusable demo asset for SEs. Each teammate brands the app for the customer they're in front of via a Settings sheet in the top right.

## What's in here

| Path | Purpose |
|---|---|
| [ops-health/](./ops-health/) | The Dynatrace app itself — Strato + React + TypeScript. |
| [scripts/seed-site-health.ts](./scripts/seed-site-health.ts) | Local runner that ingests one round of bizevents + logs. Use before a demo if you need fresh data now. |
| [automation/](./automation/) | The Dynatrace AutomationEngine workflow that ingests hourly so the app is always populated. Reference implementation the seeder skill points at. |
| [shared/schema/siteHealth.ts](./shared/schema/siteHealth.ts) | Schema constants (site types, categories, regions, statuses) shared by the seed script and the app. |
| [.claude/skills/ops-health-seeder/SKILL.md](./.claude/skills/ops-health-seeder/SKILL.md) | Agent skill that guides a coding agent to generate a customer-specific ingest workflow. |
| [.env](./.env) *(gitignored)* | Local env: `DT_ENV_URL`, `DT_PLATFORM_TOKEN`, `DT_BIZEVENT_PROVIDER`. See [.env.example](./.env.example). |

## First-time setup

1. Install dtctl and log in against the target tenant:
   ```bash
   brew install dynatrace-oss/tap/dtctl
   dtctl auth login --context <name> --environment "https://<tenant>.apps.dynatrace.com"
   ```
2. Install the skill packs used by the coding agent (optional but recommended):
   ```bash
   npx skills add dynatrace/dynatrace-for-ai
   npx skills add dynatrace-oss/dtctl
   ```
3. Copy [.env.example](./.env.example) to `.env` and fill in a platform token with scopes `storage:events:write` and `logs.ingest`.
4. Install dependencies (both the root seed tooling and the app):
   ```bash
   npm install
   cd ops-health && npm install
   ```

## Running the app locally

```bash
cd ops-health
npm run start
```

Then open the URL that `dt-app dev` prints — the tenant-hosted `local-dev-server` URL. Log into Dynatrace when prompted and accept the app scopes.

## Feeding the app with data

Two options — pick whichever fits your demo:

### One-off refresh (local)
```bash
npm run seed
```
Ingests ~348 bizevents + ~416 logs, deterministic per (`DT_SEED`, site.id, category). Re-runnable — each run overwrites the "current state" the app queries.

### Continuous (deployed workflow)
```bash
npm run deploy:workflow
```
Deploys an hourly workflow that keeps events flowing. Idempotent — subsequent runs update the same workflow in place. `dtctl exec workflow <id>` triggers it manually.

## Standing up a new customer demo

1. Update the customer branding from inside the app: click the gear icon in the top right → set the customer name, toggle tiles on/off, rename tiles for the customer's vocabulary (e.g. "Stores" → "Restaurants" for a QSR customer). Settings are per-user.
2. If the customer's inventory looks meaningfully different (different scale, different site names, different provider slug), have your coding agent invoke the [ops-health-seeder](./.claude/skills/ops-health-seeder/SKILL.md) skill: `/ops-health-seeder generate a workflow for <Customer>`. It'll walk you through inputs, generate the workflow JS, verify it locally, and deploy.
3. Demo.

## Architecture notes

- **Timeframe** is app-wide, controlled from the header. It's injected directly into the DQL text (`fetch bizevents, from: now()-1h, to: now()`) rather than passed as a separate API param — DQL accepts relative expressions natively; the API's `defaultTimeframeStart`/`End` only accept ISO.
- **Refresh** is via `refetchInterval: 60000` on each `useDql`. If the workflow ingests while the app is open, tiles update within a minute.
- **Settings** live in per-user App State (`state:user-app-states:read` + `state:user-app-states:write`). Each teammate can brand the demo differently in the same tenant.
- **Logs** are correlated to bizevents by matching `(site.id, category)`. Level (`INFO`/`WARN`/`ERROR`) maps from the site's rolled-up status. Content is generated from a template pool that mirrors the reasons pool used for `status.detail`, so the log stream reads like the same incident.
