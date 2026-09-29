# Ops Health — Agent-Driven Deploy

**You are an AI coding agent about to deploy this app for a Dynatrace SE.** When the SE says any of "deploy this", "deploy the app", "set this up", or "install ops-health", walk them through the flow below. **Don't ask them what to do next — you drive the interaction, they answer prompts.**

Everything the SE needs is baked into this repo. Your job is to collect their tenant details, write config, and run commands. When something requires their browser (OAuth login) or their password (sudo), pause and tell them exactly what to do, then continue.

---

## The flow (run it in order)

### Step 1 — Ask for two things and only two things

Ask the SE these two questions in a single message (use whatever UI you have for structured questions; if none, ask in prose):

1. **What's your Dynatrace tenant URL?**
   - Format: `https://REPLACE-ME.apps.dynatrace.com` (or `https://<tenant>.dev.apps.dynatracelabs.com` for dev tenants).
   - This is what shows in your address bar when you're using the tenant.
2. **Paste a platform token minted from your tenant** with these scopes:
   - `storage:events:write` (bizevents ingest)
   - `logs.ingest` (log ingest)
   - `metrics.ingest` (metric ingest)
   - Mint at: **your tenant → Account Management → Access Tokens → Generate new token**. Give it any name (e.g. "ops-health-seed").

Treat their answers as sensitive; never echo the token back in prose. Write it straight to `.env` (step 3).

### Step 2 — Install dependencies

```bash
npm install
cd ops-health && npm install && cd ..
```

If `npm install` fails with a permissions error on `.claude/` or `.agents/`, that's a filesystem permissions issue on the SE's machine — tell them to `sudo chown -R "$USER":staff .` in the repo root and re-run.

### Step 3 — Write their `.env`

Create `.env` (gitignored) with their answers from step 1:

```
DT_ENV_URL=<their tenant URL, no trailing slash>
DT_PLATFORM_TOKEN=<their token>
DT_BIZEVENT_PROVIDER=demo-retail.ops-health
```

Leave `DT_BIZEVENT_PROVIDER` as the default `demo-retail.ops-health` unless the SE wants a different slug — the app's DQL queries pin on this exact string (they can swap it later by editing `BIZEVENT_PROVIDER` in `ops-health/ui/app/schema/siteHealth.ts` and redeploying).

### Step 4 — Point the app at their tenant

Edit `ops-health/app.config.json`, replace the placeholder `environmentUrl` with their tenant URL (with trailing slash).

### Step 5 — Verify `dtctl` is available

Run `dtctl auth whoami -o json`. Three possible outcomes:

- **Prints a user id + email + environment matching their tenant** → proceed to step 6.
- **`dtctl: command not found`** → they need to install and log in:
  ```bash
  brew install dynatrace-oss/tap/dtctl
  dtctl auth login --context ops-health --environment "<their tenant URL>"
  ```
  Wait for them to complete the browser sign-in, then re-run `dtctl auth whoami`.
- **`whoami` shows a different environment** than what they gave in step 1 → they have multiple contexts. Run `dtctl ctx` to see the list, and `dtctl ctx <name>` to switch to the one that matches their tenant (or `dtctl auth login --context <new>` to add one).

### Step 6 — Seed data + deploy the workflow

```bash
npm run seed
npm run deploy:workflow
```

- **`npm run seed`** pushes ~348 bizevents + ~2000 logs + ~9000 metric samples so the app has real data to render the moment it opens. Prints per-batch progress and a summary.
- **`npm run deploy:workflow`** installs the "Ops Health Data" workflow (hourly cron) so data keeps flowing without them re-running the seed. Uses `dtctl` under the hood — will fail with a 403 if their user doesn't have `automation:workflows:write` policy in the tenant. If that happens, tell them to open Account Management → Policies and grant themselves an "Automation admin" (or equivalent) policy binding, then retry.

### Step 7 — Deploy the app

```bash
cd ops-health
npx dt-app deploy --optimize --no-open
```

- The first output is an **OAuth URL** — surface it to the SE with a single-line message: "Open this URL in your browser to authenticate, then come back". They complete the flow and dt-app continues on its own.
- Final output prints `Open your deployed app: '<url>'`. **Give the SE that URL.**

### Step 8 — Rebrand for their customer

Tell the SE: "Open the app URL, click the gear icon in the top right, set the customer name, and toggle/rename tiles for that customer's vocabulary. Settings are per-user, stored in the tenant."

Done. Do not schedule follow-ups, do not add background monitors — the workflow keeps the data fresh, the app is live.

---

## Common failure modes (only surface these if they happen)

- **Charts show empty:** first-load Grail indexing lag. Wait 60s and reload. If still empty after 2 min, open DevTools Console, filter to `[ops-health]`, and share the `recordCount` / `error` values back with the SE — they'll diagnose from there.
- **Workflow deploys with wrong actor:** `dtctl` context doesn't match the tenant. Delete `automation/site-health-seed-workflow.deployed.json`, switch `dtctl` context to the right tenant, re-run `npm run deploy:workflow`.
- **App fails on metric queries with 403:** SE hasn't re-consented after a scope change. Tell them to log out of the deployed app (Dynatrace top-right menu) and log back in.

## Deeper docs (only load if the SE asks for detail)

- [README.md](./README.md) — architecture, repo layout, what each folder does.
- [.claude/skills/ops-health-seeder/SKILL.md](./.claude/skills/ops-health-seeder/SKILL.md) — schema of the ingest pipeline. Read this if the SE wants to customize the site inventory beyond what the Settings UI supports (add/remove site types, change categories).
