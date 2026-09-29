// Phase 3 — DQL queries for the ops-health app.
//
// Both queries dedupe to the latest event per (site.id, category) so re-runs of
// the seeder never inflate counts. worst-of rollup precedence: unhealthy > degraded > healthy.
//
// Timeframe is injected as DQL syntax (`from: now()-1h, to: now()` or quoted ISO)
// rather than sent as a separate API parameter — DQL supports relative expressions
// natively and this dodges the Query API's ISO-only validation on the top-level params.

import { BIZEVENT_PROVIDER, BIZEVENT_TYPE, type SiteType } from "../schema/siteHealth";
import { toDql } from "../context/TimeframeContext";
import type { TimeframeValue } from "../components/Header";

const BASE_FILTER = `
  event.provider == "${BIZEVENT_PROVIDER}"
  and event.type == "${BIZEVENT_TYPE}"
`;

function fetchClause(tf: TimeframeValue | null): string {
  if (!tf) return "fetch bizevents";
  return `fetch bizevents, from: ${toDql(tf.from)}, to: ${toDql(tf.to)}`;
}

// Latest-per-key + worst-of rollup + count-by-site.type. Drives the 4 overview tiles.
export function siteTypeRollupQuery(tf: TimeframeValue | null): string {
  return `
${fetchClause(tf)}
| filter ${BASE_FILTER}
| sort timestamp desc
| dedup {\`site.id\`, category}
| summarize
    worstRank = takeMax(if(status == "unhealthy", 2, else: if(status == "degraded", 1, else: 0))),
    lastUpdated = takeMax(timestamp),
    by: {\`site.id\`, \`site.type\`}
| fieldsAdd siteStatus = if(worstRank == 2, "unhealthy", else: if(worstRank == 1, "degraded", else: "healthy"))
| summarize
    total = count(),
    healthy = countIf(siteStatus == "healthy"),
    degraded = countIf(siteStatus == "degraded"),
    unhealthy = countIf(siteStatus == "unhealthy"),
    by: {\`site.type\`}
| sort \`site.type\`
`.trim();
}

// Per-site rollup for one site.type. Drives the detail table.
export function detailQueryForSiteType(siteType: SiteType, tf: TimeframeValue | null): string {
  return `
${fetchClause(tf)}
| filter ${BASE_FILTER} and \`site.type\` == "${siteType}"
| sort timestamp desc
| dedup {\`site.id\`, category}
| summarize
    \`site.name\` = takeFirst(\`site.name\`),
    \`site.region\` = takeFirst(\`site.region\`),
    \`site.lat\` = takeFirst(\`site.lat\`),
    \`site.lng\` = takeFirst(\`site.lng\`),
    lastUpdated = takeMax(timestamp),
    perCategory = collectArray(record(category, status, \`status.detail\`)),
    worstRank = takeMax(if(status == "unhealthy", 2, else: if(status == "degraded", 1, else: 0))),
    by: {\`site.id\`}
| fieldsAdd siteStatus = if(worstRank == 2, "unhealthy", else: if(worstRank == 1, "degraded", else: "healthy"))
| sort worstRank desc, \`site.id\` asc
`.trim();
}

// Row shapes returned by useDql — kept aligned with the queries above.

export interface SiteTypeRollupRow {
  "site.type": SiteType;
  total: number;
  healthy: number;
  degraded: number;
  unhealthy: number;
}

// Top-N problem sites across every site.type. Drives the "Sites needing
// attention" panel on Home. Uses the same dedup+worst-of pipeline as the
// detail queries so the ranking stays consistent between pages.
export function topProblemSitesQuery(tf: TimeframeValue | null, limit = 10): string {
  return `
${fetchClause(tf)}
| filter ${BASE_FILTER}
| sort timestamp desc
| dedup {\`site.id\`, category}
| summarize
    \`site.name\` = takeFirst(\`site.name\`),
    \`site.region\` = takeFirst(\`site.region\`),
    \`site.type\` = takeFirst(\`site.type\`),
    worstRank = takeMax(if(status == "unhealthy", 2, else: if(status == "degraded", 1, else: 0))),
    lastUpdated = takeMax(timestamp),
    perCategory = collectArray(record(category, status, \`status.detail\`)),
    by: {\`site.id\`}
| filter worstRank > 0
| fieldsAdd siteStatus = if(worstRank == 2, "unhealthy", else: "degraded")
| sort worstRank desc, \`site.name\` asc
| limit ${limit}
`.trim();
}

export interface ProblemSiteRow {
  "site.id":     string;
  "site.name":   string;
  "site.region": string;
  "site.type":   SiteType;
  worstRank:     number;
  lastUpdated:   string;
  siteStatus:    "degraded" | "unhealthy";
  perCategory:   Array<{ category: string; status: string; "status.detail": string }>;
}

export interface SiteDetailRow {
  "site.id": string;
  "site.name": string;
  "site.region": string;
  "site.lat": number | null;
  "site.lng": number | null;
  lastUpdated: string;
  siteStatus: "healthy" | "degraded" | "unhealthy";
  worstRank: number;
  perCategory: Array<{
    category: string;
    status: "healthy" | "degraded" | "unhealthy";
    "status.detail": string;
  }>;
}

// Site health logs — matches the shape ingested by the workflow (see
// automation/site-health-seed-task.js). Correlated to a specific site.id.
export function siteLogsQuery(siteType: SiteType, tf: TimeframeValue | null): string {
  return `
${fetchClause(tf).replace("fetch bizevents", "fetch logs")}
| filter log.source == "trader-joes.ops-health" and \`site.type\` == "${siteType}"
| sort timestamp desc
| fields timestamp, content, loglevel, \`site.id\`, category
| limit 500
`.trim();
}

export interface SiteLogRow {
  timestamp: string;
  content: string;
  // Grail's default log OpenPipeline normalises the ingested "log.level" attribute
  // to a top-level "loglevel" field (dot removed). Query and consume it under that name.
  loglevel: string;
  "site.id": string;
  category: string;
}

// Per-signal metric timeseries. Two metric keys, both dimensioned by site.id
// + category, emitted by the workflow every 5 minutes over the last hour.
// The DQL `timeseries` verb accepts relative expressions directly, no ISO
// resolution needed.
function fromClause(tf: TimeframeValue | null): string {
  if (!tf) return "from: now()-1h";
  return `from: ${toDql(tf.from)}, to: ${toDql(tf.to)}`;
}

export function metricsQueryForSite(
  siteId: string,
  category: string,
  tf: TimeframeValue | null,
): string {
  const filter = category === "all"
    ? `\`site.id\` == "${siteId}"`
    : `\`site.id\` == "${siteId}" and category == "${category}"`;
  return `
timeseries {
  responseMs = avg(custom.ops_health.response_ms),
  errors     = sum(custom.ops_health.error_count)
}, ${fromClause(tf)}, interval: 5m, filter: { ${filter} }
`.trim();
}
