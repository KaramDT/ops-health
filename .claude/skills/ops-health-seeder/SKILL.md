---
name: ops-health-seeder
description: Generate a Dynatrace AutomationEngine workflow that feeds synthetic site health data (bizevents + correlated logs) into the Ops Health app. Use this when an SE wants to demo the Ops Health app for a new customer and needs a workflow ingesting hourly test data matching that customer's site inventory. Trigger phrases include "generate ops health workflow", "seed ops health app", "add hourly workflow for ops health demo", "spin up ops health data for <customer>".
---

# Ops Health seeder

Generate a Dynatrace AutomationEngine workflow that keeps the **Ops Health** app populated with synthetic data. The app renders bizevents (`site.health.check`) as tiles and per-site status columns, and correlated logs as expandable per-site log panels. This skill produces a workflow that matches the app's exact schema so both surfaces render without additional wiring.

## What this skill covers

1. Site inventory design — how many sites, what site types, what regions, plausible names for the customer.
2. Event + log generation logic — deterministic RNG, 92/6/2 status distribution, matched log copy per (category × status).
3. Ingest via `businessEventsClient` for bizevents and direct `fetch()` to the logs ingest endpoint (both auto-auth via workflow actor).
4. Workflow envelope (JSON) with an hourly cron trigger.
5. Deployment via `dtctl apply workflow`.

## When NOT to use

- The customer already has a working workflow — just re-run it, don't re-generate.
- The customer wants to run the app against **real** Dynatrace data (not synthetic). This skill is for demo seeding only.
- The user wants to *change the app schema* (new site types, new categories). That requires editing `shared/schema/siteHealth.ts` + the app itself; the workflow follows from the schema, not the other way around.

## Schema contract (must match the app)

The app queries these fields — the workflow MUST emit them exactly:

### Bizevent (`fetch bizevents | filter event.provider == "<PROVIDER>" and event.type == "site.health.check"`)

| Field | Type | Example |
|---|---|---|
| `event.provider` | `"<PROVIDER>"` | `"trader-joes.ops-health"` — usually `<customer>.ops-health` |
| `event.type` | `"site.health.check"` | fixed |
| `site.id` | string, stable | `"store-0042"`, `"warehouse-01"` |
| `site.name` | string | `"Trader Joe's - Pasadena, CA"` |
| `site.type` | enum | `"store"` \| `"warehouse"` \| `"office"` \| `"datacenter"` |
| `site.region` | enum | `"West"` \| `"Midwest"` \| `"Northeast"` \| `"South"` |
| `category` | enum, varies by `site.type` | see below |
| `status` | enum | `"healthy"` \| `"degraded"` \| `"unhealthy"` |
| `status.detail` | string | `""` when healthy, else a short reason |

**Categories per site.type:**
- `store`: `network`, `system`, `device`, `pos`, `portal`
- `warehouse`: `network`, `system`, `device`, `printer`
- `office`: `network`, `system`
- `datacenter`: `network`, `system`

### Log (`fetch logs | filter log.source == "<PROVIDER>"`)

| Field | Type | Notes |
|---|---|---|
| `content` | string | Human-readable line; conventionally `[<type>/<category>] <site.name> — <message>` |
| `timestamp` | ISO string | Spread across ~10 min before now so timestamps read as a stream |
| `log.level` | `"INFO"` \| `"WARN"` \| `"ERROR"` | Maps from status: healthy→INFO, degraded→WARN, unhealthy→ERROR |
| `log.source` | string | Same as `event.provider` |
| `site.id`, `site.name`, `site.type`, `site.region`, `category` | | Same shapes as bizevent — used for correlation |
| `site.status` | enum | Same as the bizevent's `status` field |

## Generation steps

**Follow these in order.** Each step is small; batch tool calls where independent.

### Step 1 — Gather inputs from the SE

Ask for:
1. **Customer name** and short slug for the provider (e.g. `Acme Grocers` → `acme.ops-health`).
2. **Site inventory shape**. Reasonable defaults if unspecified: 60 stores in 4 regions, 8 warehouses (2 per region), 5 offices, 3 datacenters. Ask if the customer's scale is meaningfully different (e.g. a regional chain with 12 stores in one region).
3. **Realistic site names** — for stores, `<Customer> - <City>, <State>` is fine. Ask the SE if the customer has known-good example city names to feed in.
4. **Which site types to include**. If the SE only demos stores + warehouses, skip offices + datacenters.

### Step 2 — Build the workflow JS task

Start from the reference implementation at `automation/site-health-seed-task.js`. The structure is:

```js
// Constants: BIZEVENT_INGEST_PATH, LOGS_INGEST_PATH, BIZEVENT_TYPE,
// DEFAULT_PROVIDER, LOG_SOURCE, DEFAULT_SEED, BATCH_SIZE, LOGS_PER_STATUS.

// CATEGORIES_BY_SITE_TYPE — exact table from the schema above.
// REASONS — short strings per (category × degraded/unhealthy) that populate `status.detail`.
// LOG_TEMPLATES — parallel strings per (category × healthy/degraded/unhealthy) that
//   become log content; keep messages consistent with REASONS so the two surfaces
//   read as the same incident.

// SITES — the customer-specific inventory as [id, name, type, region] tuples.

// Deterministic helpers: xmur3 → mulberry32, seeded per (seed, site.id, category).
// pickStatus: r < 0.92 → healthy, r < 0.98 → degraded, else unhealthy.
// buildEventsAndLogs(seed, provider) → { events, logs }.

// Ingest:
//   Bizevents: POST /platform/classic/environment-api/v2/bizevents/ingest
//              (Content-Type: application/cloudevents-batch+json)
//   Logs:     POST /platform/classic/environment-api/v2/logs/ingest
//              (Content-Type: application/json)
// Relative paths auto-authenticate via the workflow actor.
```

**Key gotchas:**
- Use `fetch()` for BOTH endpoints. The SDK `businessEventsClient.ingest()` does NOT accept the batch mimetype; the relative-fetch path does.
- CloudEvent `source` becomes `event.provider` in Grail. `type` becomes `event.type`.
- Log severity via a top-level `severity` field gets dropped by Grail's default OpenPipeline. Use a custom `log.level` field instead.
- Dotted field names (`site.id`, `log.level`) survive the ingest — but must be **backticked** in DQL: `` `site.id` == "..." ``.

### Step 3 — Verify locally before deploying

Run the task standalone via dtctl before deploying:

```bash
dtctl exec function -f <path-to-generated-task.js>
```

It should print a distribution close to `{healthy: ~92%, degraded: ~6%, unhealthy: ~2%}` and confirm HTTP 202 / 204 responses. If it fails with `INVALID_TIMEFRAME` or ingest errors, fix them locally — a deployed workflow that errors is harder to debug.

Then query the data back:

```bash
dtctl query 'fetch bizevents, from: now()-10m
  | filter event.provider == "<PROVIDER>"
  | summarize count = count(), by: {`site.type`, status}' -o json
```

### Step 4 — Wrap in a workflow envelope

Match the shape from `automation/site-health-seed-workflow.template.json`. Required fields:

```json
{
  "title": "<Customer> - Ops Health Seeder",
  "description": "Hourly generator of synthetic site.health.check bizevents + correlated logs",
  "type": "STANDARD",
  "isPrivate": false,
  "ownerType": "USER",
  "schemaVersion": 4,
  "triggerType": "Schedule",
  "trigger": {
    "schedule": {
      "isActive": true,
      "timezone": "America/Los_Angeles",
      "inputs": {},
      "filterParameters": {},
      "trigger": { "cron": "0 * * * *", "type": "cron" }
    }
  },
  "hourlyExecutionLimit": 1000,
  "tasks": {
    "seed_bizevents": {
      "action": "dynatrace.automations:run-javascript",
      "name": "seed_bizevents",
      "description": "Generate + ingest synthetic site health data",
      "position": { "x": 0, "y": 1 },
      "predecessors": [],
      "input": { "script": "<generated-js-here>" }
    }
  }
}
```

Set `actor` and `owner` to the current user's UUID (read via `dtctl auth whoami -o json`, field `userId`).

### Step 5 — Deploy via dtctl

```bash
dtctl apply workflow -f <path-to-workflow.json> -o json
```

If deployment 403s, the caller is missing the `automation:workflows:write` policy in the target tenant. Fixing IAM belongs to a tenant admin; do not paper over this by hardcoding tokens.

Once deployed, trigger a manual run to verify:

```bash
dtctl exec workflow <workflow-id>
sleep 15
dtctl get wfe <execution-id> -o json
```

`state` should be `SUCCESS` within a few seconds.

## Post-deployment: point the app at the new data

The Ops Health app's DQL queries filter on `event.provider == "trader-joes.ops-health"` by default (see `ops-health/ui/app/schema/siteHealth.ts`, `BIZEVENT_PROVIDER`). If the seeder uses a different provider slug (e.g. `acme.ops-health`), the SE needs to either:

- Edit `BIZEVENT_PROVIDER` in the schema and rebuild the app, OR
- Add a per-user "provider" setting to the app's Settings sheet (Phase 8 work, not yet built).

## Reference files in this repo

- `automation/site-health-seed-task.js` — canonical workflow JS. **Read this first** when generating a customer-specific version.
- `automation/site-health-seed-workflow.template.json` — workflow envelope template.
- `scripts/deploy-workflow.ts` — deploy helper. Handles ID stamping for idempotent redeploys.
- `shared/schema/siteHealth.ts` and `ops-health/ui/app/schema/siteHealth.ts` — schema constants the workflow must match.
- `scripts/seed-site-health.ts` — local runner that produces the same output as the workflow. Useful for a one-off refresh without deploying anything.
