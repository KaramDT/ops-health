// DQL queries for the ops-health app. All three are chained rollups over the
// site.health.check bizevents produced by scripts/seed-site-health.ts and the
// hourly workflow. Meant for the useDql hook from @dynatrace-sdk/react-hooks.
//
// Design:
//   Q1 latestPerSiteCategory — dedupe to the most recent event per (site.id, category)
//   Q2 rollupPerSite         — worst-of status per site (unhealthy > degraded > healthy)
//   Q3 rollupPerSiteType     — tile summary per site.type with per-status counts
//
// Rollup rule (worst-of): if ANY of a site's categories is unhealthy, the site is unhealthy;
// otherwise if ANY is degraded, the site is degraded; otherwise healthy. Same rule scales up
// to the tile level (any unhealthy site makes the tile red, any degraded makes it yellow).
//
// The lookback window is 1 hour by default — matches the hourly seed workflow cadence.
// If the workflow is paused, run `npm run seed` locally before demos.

export const DEFAULT_LOOKBACK = "1h";
export const DEFAULT_PROVIDER = "trader-joes.ops-health";
export const BIZEVENT_TYPE = "site.health.check";

interface QueryOpts {
  lookback?: string; // DQL duration literal, e.g. "1h", "24h", "15m"
  provider?: string;
}

function base({ lookback = DEFAULT_LOOKBACK, provider = DEFAULT_PROVIDER }: QueryOpts = {}) {
  return `fetch bizevents, from: now()-${lookback}
| filter event.provider == "${provider}" and event.type == "${BIZEVENT_TYPE}"`;
}

// Q1 — latest event per (site.id, category). Dedupes the seed script's repeated
// runs down to a single "current state" record per site+category.
export function latestPerSiteCategory(opts: QueryOpts = {}): string {
  return `${base(opts)}
| summarize latest = takeMax(record(timestamp, \`site.id\`, \`site.name\`, \`site.type\`, \`site.region\`, category, status, \`status.detail\`)), by: {\`site.id\`, category}
| fieldsFlatten latest, prefix: ""
| fields timestamp, \`site.id\`, \`site.name\`, \`site.type\`, \`site.region\`, category, status, \`status.detail\``;
}

// Q2 — per-site rollup with worst-of overall_status.
// Emits one row per site with counts of each status across its categories.
// Used by the category detail page to drive the overall-status badge/sort.
export function rollupPerSite(opts: QueryOpts = {}): string {
  return `${base(opts)}
| summarize latest = takeMax(record(timestamp, \`site.id\`, \`site.name\`, \`site.type\`, \`site.region\`, category, status, \`status.detail\`)), by: {\`site.id\`, category}
| fieldsFlatten latest, prefix: ""
| summarize {
    unhealthy_count = countIf(status == "unhealthy"),
    degraded_count  = countIf(status == "degraded"),
    healthy_count   = countIf(status == "healthy"),
    category_count  = count(),
    site_name       = takeAny(\`site.name\`),
    site_region     = takeAny(\`site.region\`),
    last_updated    = takeMax(timestamp)
  }, by: {\`site.id\`, \`site.type\`}
| fieldsAdd overall_status = if(unhealthy_count > 0, "unhealthy", else: if(degraded_count > 0, "degraded", else: "healthy"))`;
}

// Q3 — per-site.type rollup for the overview tiles.
// Emits one row per site.type with the tile color (worst-of) plus per-status site counts.
export function rollupPerSiteType(opts: QueryOpts = {}): string {
  return `${base(opts)}
| summarize latest = takeMax(record(timestamp, \`site.id\`, \`site.name\`, \`site.type\`, \`site.region\`, category, status, \`status.detail\`)), by: {\`site.id\`, category}
| fieldsFlatten latest, prefix: ""
| summarize {
    unhealthy_count = countIf(status == "unhealthy"),
    degraded_count  = countIf(status == "degraded"),
    healthy_count   = countIf(status == "healthy")
  }, by: {\`site.id\`, \`site.type\`}
| fieldsAdd overall_status = if(unhealthy_count > 0, "unhealthy", else: if(degraded_count > 0, "degraded", else: "healthy"))
| summarize {
    total_sites     = count(),
    healthy_sites   = countIf(overall_status == "healthy"),
    degraded_sites  = countIf(overall_status == "degraded"),
    unhealthy_sites = countIf(overall_status == "unhealthy")
  }, by: {\`site.type\`}
| fieldsAdd tile_status = if(unhealthy_sites > 0, "unhealthy", else: if(degraded_sites > 0, "degraded", else: "healthy"))
| sort \`site.type\` asc`;
}

// Row types returned by each query (property names match Grail fields).
export interface LatestPerSiteCategoryRow {
  timestamp: string;
  "site.id": string;
  "site.name": string;
  "site.type": "store" | "warehouse" | "office" | "datacenter";
  "site.region": string;
  category: string;
  status: "healthy" | "degraded" | "unhealthy";
  "status.detail": string;
}

export interface RollupPerSiteRow {
  "site.id": string;
  "site.type": "store" | "warehouse" | "office" | "datacenter";
  site_name: string;
  site_region: string;
  unhealthy_count: number;
  degraded_count: number;
  healthy_count: number;
  category_count: number;
  last_updated: string;
  overall_status: "healthy" | "degraded" | "unhealthy";
}

export interface RollupPerSiteTypeRow {
  "site.type": "store" | "warehouse" | "office" | "datacenter";
  total_sites: number;
  healthy_sites: number;
  degraded_sites: number;
  unhealthy_sites: number;
  tile_status: "healthy" | "degraded" | "unhealthy";
}
