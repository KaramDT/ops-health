// Seed script: generates synthetic site.health.check bizevents and POSTs them to the
// Dynatrace platform bizevents ingest endpoint. Idempotent — re-running just sends a
// fresh batch representing "current state" (no historical trend simulation).
//
// Deterministic RNG seeded per (site.id, category) plus a global DT_SEED, so the same
// stores light up the same way every run — good for demo repeatability.
//
// Env (read from .env at repo root):
//   DT_ENV_URL              e.g. https://REPLACE-ME.apps.dynatrace.com/
//   DT_PLATFORM_TOKEN       platform token with scope storage:events:write
//   DT_BIZEVENT_PROVIDER    optional, defaults to "demo-retail.ops-health"
//   DT_SEED                 optional integer, defaults to 42

import { randomUUID } from "node:crypto";
import * as dotenv from "dotenv";
import {
  BIZEVENT_TYPE,
  CATEGORIES_BY_SITE_TYPE,
  type AnyCategory,
  type Region,
  type SiteHealthCheck,
  type SiteHealthCheckEvent,
  type SiteType,
  type Status,
} from "../shared/schema/siteHealth.ts";

dotenv.config();

const DT_ENV_URL           = requireEnv("DT_ENV_URL").replace(/\/+$/, "");
const DT_PLATFORM_TOKEN    = requireEnv("DT_PLATFORM_TOKEN");
const DT_BIZEVENT_PROVIDER = process.env.DT_BIZEVENT_PROVIDER ?? "demo-retail.ops-health";
const LOG_SOURCE           = DT_BIZEVENT_PROVIDER;
const DT_SEED              = Number(process.env.DT_SEED ?? "42");
const BATCH_SIZE           = 200;

// Every status gets some INFO chatter so each panel has non-zero counts across
// all three level cards; degraded/unhealthy add WARN and ERROR on top.
const LOGS_BY_STATUS: Record<Status, { INFO: number; WARN: number; ERROR: number }> = {
  healthy:   { INFO: 3, WARN: 0, ERROR: 0 },
  degraded:  { INFO: 2, WARN: 4, ERROR: 0 },
  unhealthy: { INFO: 2, WARN: 3, ERROR: 5 },
};

const LOG_TEMPLATES: Record<string, Record<Status, string[]>> = {
  network: {
    healthy:   ["WAN link nominal, throughput within SLA", "VPN tunnels up, no packet loss in the last 5m"],
    degraded:  ["WAN link degraded — measured latency 220ms (baseline 60ms)", "Wi-Fi controller reported 12 client disconnects in 3m", "Packet loss > 5% on primary uplink; failover armed"],
    unhealthy: ["VPN tunnel down: keepalive timeout after 45s", "Primary uplink OFFLINE — carrier reports regional outage", "Core switch unresponsive to SNMP; ping unanswered from HQ"],
  },
  system: {
    healthy:   ["Systems healthy, CPU 22% / mem 41%", "Nightly patch window completed, all hosts green"],
    degraded:  ["Backup server CPU sustained > 85% for 12m", "Root FS at 88% on register-3; cleanup pending", "OS patch queued but pending reboot on 2 hosts"],
    unhealthy: ["Backup server OFFLINE, last heartbeat 6m ago", "Root FS 100% full on register-2 — application errors observed", "Kernel panic reported on pos-terminal-3, service down"],
  },
  device: {
    healthy:   ["Handheld scanners connected, all batteries > 40%", "Receipt printer inventory nominal"],
    degraded:  ["Handheld scanner S-014 battery at 12%", "Receipt printer paper low on lane 4", "Label scale drift detected — calibration recommended"],
    unhealthy: ["Handheld scanner S-014 OFFLINE, last seen 8m ago", "Scale calibration failure on produce station 2", "Camera feed disconnected on entry cam 1"],
  },
  pos: {
    healthy:   ["POS terminals online, txn latency p95 = 320ms", "Card reader firmware up to date across all lanes"],
    degraded:  ["POS lane 3 slower than baseline (p95 780ms)", "Card reader on lane 5 intermittent — auto-retry succeeded", "Receipt printer jam cleared on lane 2, back in service"],
    unhealthy: ["POS terminal 3 UNRESPONSIVE — restart in progress", "Card reader lane 5 OFFLINE, taken out of rotation", "Payment processor timeout: 6 consecutive txn failures"],
  },
  portal: {
    healthy:   ["Employee portal healthy, SSO logins nominal", "Portal p95 response time = 480ms"],
    degraded:  ["Employee portal slow (p95 > 5s)", "SSO token refresh warnings; users may re-auth soon"],
    unhealthy: ["Employee portal returning 5xx — 22 failed page loads in 3m", "SSO login failing for portal.corp.example.local"],
  },
  printer: {
    healthy:   ["Label printer queue empty, last job success", "Toner levels nominal across all printers"],
    degraded:  ["Toner low on label printer B", "Print queue backlog: 47 jobs waiting"],
    unhealthy: ["Label printer B jam — manual clear required", "Printer OFFLINE; job queue holding"],
  },
};

interface LogRecord {
  timestamp: string;
  content: string;
  "log.level": "INFO" | "WARN" | "ERROR";
  "log.source": string;
  "site.id": string;
  "site.name": string;
  "site.type": SiteType;
  "site.region": Region;
  category: AnyCategory;
  "site.status": Status;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    console.error(`Missing env ${name}. Set it in .env at the repo root.`);
    process.exit(1);
  }
  return v;
}

// ── Seeded RNG ────────────────────────────────────────────────────────────────
function xmur3(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function rngFor(key: string): () => number {
  return mulberry32(xmur3(`${DT_SEED}|${key}`));
}

// ── Status + status.detail selection ─────────────────────────────────────────
function pickStatus(rng: () => number): Status {
  const r = rng();
  if (r < 0.92) return "healthy";
  if (r < 0.98) return "degraded";
  return "unhealthy";
}

const REASONS: Record<AnyCategory, { degraded: string[]; unhealthy: string[] }> = {
  network: {
    degraded:  ["WAN link degraded", "packet loss > 5%", "elevated WAN latency", "Wi-Fi controller warnings"],
    unhealthy: ["VPN tunnel down", "primary uplink offline", "core switch unresponsive"],
  },
  system: {
    degraded:  ["server CPU sustained > 85%", "disk usage > 85%", "memory pressure warnings", "OS patch pending reboot"],
    unhealthy: ["backup server offline", "root FS 100% full", "kernel panic reported"],
  },
  device: {
    degraded:  ["handheld scanner low battery", "label scale drift", "receipt printer paper low"],
    unhealthy: ["scanner offline", "scale calibration failure", "camera feed disconnected"],
  },
  pos: {
    degraded:  ["POS lane 3 slow", "card reader intermittent", "receipt printer jam"],
    unhealthy: ["POS terminal 3 unresponsive", "card reader offline", "payment processor timeout"],
  },
  portal: {
    degraded:  ["employee portal slow (>5s)", "SSO token refresh warnings"],
    unhealthy: ["employee portal 5xx", "SSO login failing"],
  },
  printer: {
    degraded:  ["toner low", "print queue backlog"],
    unhealthy: ["label printer jam", "printer offline"],
  },
};

function pickDetail(category: AnyCategory, status: Status, rng: () => number): string {
  if (status === "healthy") return "";
  const pool = REASONS[category][status];
  return pool[Math.floor(rng() * pool.length)]!;
}

// ── Site inventory ────────────────────────────────────────────────────────────
interface SiteDef {
  id:     string;
  name:   string;
  type:   SiteType;
  region: Region;
  lat:    number;
  lng:    number;
}

const STORES: SiteDef[] = [
  // West (15)
  { id: "store-0001", name: "Demo Retail - Pasadena, CA",         type: "store", region: "West", lat: 34.1478, lng: -118.1445 },
  { id: "store-0002", name: "Demo Retail - Santa Monica, CA",     type: "store", region: "West", lat: 34.0195, lng: -118.4912 },
  { id: "store-0003", name: "Demo Retail - San Francisco, CA",    type: "store", region: "West", lat: 37.7749, lng: -122.4194 },
  { id: "store-0004", name: "Demo Retail - Seattle, WA",          type: "store", region: "West", lat: 47.6062, lng: -122.3321 },
  { id: "store-0005", name: "Demo Retail - Portland, OR",         type: "store", region: "West", lat: 45.5152, lng: -122.6784 },
  { id: "store-0006", name: "Demo Retail - Denver, CO",           type: "store", region: "West", lat: 39.7392, lng: -104.9903 },
  { id: "store-0007", name: "Demo Retail - Phoenix, AZ",          type: "store", region: "West", lat: 33.4484, lng: -112.074 },
  { id: "store-0008", name: "Demo Retail - San Diego, CA",        type: "store", region: "West", lat: 32.7157, lng: -117.1611 },
  { id: "store-0009", name: "Demo Retail - Berkeley, CA",         type: "store", region: "West", lat: 37.8715, lng: -122.273 },
  { id: "store-0010", name: "Demo Retail - Sacramento, CA",       type: "store", region: "West", lat: 38.5816, lng: -121.4944 },
  { id: "store-0011", name: "Demo Retail - Las Vegas, NV",        type: "store", region: "West", lat: 36.1699, lng: -115.1398 },
  { id: "store-0012", name: "Demo Retail - Boise, ID",            type: "store", region: "West", lat: 43.615, lng: -116.2023 },
  { id: "store-0013", name: "Demo Retail - Salt Lake City, UT",   type: "store", region: "West", lat: 40.7608, lng: -111.891 },
  { id: "store-0014", name: "Demo Retail - Los Angeles, CA",      type: "store", region: "West", lat: 34.0522, lng: -118.2437 },
  { id: "store-0015", name: "Demo Retail - Bellevue, WA",         type: "store", region: "West", lat: 47.6101, lng: -122.2015 },
  // Midwest (15)
  { id: "store-0016", name: "Demo Retail - Chicago, IL",          type: "store", region: "Midwest", lat: 41.8781, lng: -87.6298 },
  { id: "store-0017", name: "Demo Retail - Naperville, IL",       type: "store", region: "Midwest", lat: 41.7508, lng: -88.1535 },
  { id: "store-0018", name: "Demo Retail - Minneapolis, MN",      type: "store", region: "Midwest", lat: 44.9778, lng: -93.265 },
  { id: "store-0019", name: "Demo Retail - Saint Paul, MN",       type: "store", region: "Midwest", lat: 44.9537, lng: -93.09 },
  { id: "store-0020", name: "Demo Retail - Milwaukee, WI",        type: "store", region: "Midwest", lat: 43.0389, lng: -87.9065 },
  { id: "store-0021", name: "Demo Retail - Madison, WI",          type: "store", region: "Midwest", lat: 43.0731, lng: -89.4012 },
  { id: "store-0022", name: "Demo Retail - Kansas City, MO",      type: "store", region: "Midwest", lat: 39.0997, lng: -94.5786 },
  { id: "store-0023", name: "Demo Retail - Saint Louis, MO",      type: "store", region: "Midwest", lat: 38.627, lng: -90.1994 },
  { id: "store-0024", name: "Demo Retail - Cincinnati, OH",       type: "store", region: "Midwest", lat: 39.1031, lng: -84.512 },
  { id: "store-0025", name: "Demo Retail - Columbus, OH",         type: "store", region: "Midwest", lat: 39.9612, lng: -82.9988 },
  { id: "store-0026", name: "Demo Retail - Cleveland, OH",        type: "store", region: "Midwest", lat: 41.4993, lng: -81.6944 },
  { id: "store-0027", name: "Demo Retail - Indianapolis, IN",     type: "store", region: "Midwest", lat: 39.7684, lng: -86.1581 },
  { id: "store-0028", name: "Demo Retail - Ann Arbor, MI",        type: "store", region: "Midwest", lat: 42.2808, lng: -83.743 },
  { id: "store-0029", name: "Demo Retail - Detroit, MI",          type: "store", region: "Midwest", lat: 42.3314, lng: -83.0458 },
  { id: "store-0030", name: "Demo Retail - Des Moines, IA",       type: "store", region: "Midwest", lat: 41.5868, lng: -93.625 },
  // Northeast (15)
  { id: "store-0031", name: "Demo Retail - Boston, MA",           type: "store", region: "Northeast", lat: 42.3601, lng: -71.0589 },
  { id: "store-0032", name: "Demo Retail - Cambridge, MA",        type: "store", region: "Northeast", lat: 42.3736, lng: -71.1097 },
  { id: "store-0033", name: "Demo Retail - Union Square, NY",     type: "store", region: "Northeast", lat: 40.7359, lng: -73.9911 },
  { id: "store-0034", name: "Demo Retail - Brooklyn, NY",         type: "store", region: "Northeast", lat: 40.6782, lng: -73.9442 },
  { id: "store-0035", name: "Demo Retail - Upper West Side, NY",  type: "store", region: "Northeast", lat: 40.787, lng: -73.9754 },
  { id: "store-0036", name: "Demo Retail - Chelsea, NY",          type: "store", region: "Northeast", lat: 40.7465, lng: -74.0014 },
  { id: "store-0037", name: "Demo Retail - Jersey City, NJ",      type: "store", region: "Northeast", lat: 40.7178, lng: -74.0431 },
  { id: "store-0038", name: "Demo Retail - Princeton, NJ",        type: "store", region: "Northeast", lat: 40.3573, lng: -74.6672 },
  { id: "store-0039", name: "Demo Retail - Philadelphia, PA",     type: "store", region: "Northeast", lat: 39.9526, lng: -75.1652 },
  { id: "store-0040", name: "Demo Retail - Pittsburgh, PA",       type: "store", region: "Northeast", lat: 40.4406, lng: -79.9959 },
  { id: "store-0041", name: "Demo Retail - Portland, ME",         type: "store", region: "Northeast", lat: 43.6591, lng: -70.2568 },
  { id: "store-0042", name: "Demo Retail - Providence, RI",       type: "store", region: "Northeast", lat: 41.824, lng: -71.4128 },
  { id: "store-0043", name: "Demo Retail - Hartford, CT",         type: "store", region: "Northeast", lat: 41.7658, lng: -72.6734 },
  { id: "store-0044", name: "Demo Retail - White Plains, NY",     type: "store", region: "Northeast", lat: 41.034, lng: -73.7629 },
  { id: "store-0045", name: "Demo Retail - Washington, DC",       type: "store", region: "Northeast", lat: 38.9072, lng: -77.0369 },
  // South (15)
  { id: "store-0046", name: "Demo Retail - Austin, TX",           type: "store", region: "South", lat: 30.2672, lng: -97.7431 },
  { id: "store-0047", name: "Demo Retail - Houston, TX",          type: "store", region: "South", lat: 29.7604, lng: -95.3698 },
  { id: "store-0048", name: "Demo Retail - Dallas, TX",           type: "store", region: "South", lat: 32.7767, lng: -96.797 },
  { id: "store-0049", name: "Demo Retail - Atlanta, GA",          type: "store", region: "South", lat: 33.749, lng: -84.388 },
  { id: "store-0050", name: "Demo Retail - Nashville, TN",        type: "store", region: "South", lat: 36.1627, lng: -86.7816 },
  { id: "store-0051", name: "Demo Retail - Charlotte, NC",        type: "store", region: "South", lat: 35.2271, lng: -80.8431 },
  { id: "store-0052", name: "Demo Retail - Raleigh, NC",          type: "store", region: "South", lat: 35.7796, lng: -78.6382 },
  { id: "store-0053", name: "Demo Retail - Miami, FL",            type: "store", region: "South", lat: 25.7617, lng: -80.1918 },
  { id: "store-0054", name: "Demo Retail - Orlando, FL",          type: "store", region: "South", lat: 28.5383, lng: -81.3792 },
  { id: "store-0055", name: "Demo Retail - Tampa, FL",            type: "store", region: "South", lat: 27.9506, lng: -82.4572 },
  { id: "store-0056", name: "Demo Retail - New Orleans, LA",      type: "store", region: "South", lat: 29.9511, lng: -90.0715 },
  { id: "store-0057", name: "Demo Retail - Chapel Hill, NC",      type: "store", region: "South", lat: 35.9132, lng: -79.0558 },
  { id: "store-0058", name: "Demo Retail - Charleston, SC",       type: "store", region: "South", lat: 32.7765, lng: -79.9311 },
  { id: "store-0059", name: "Demo Retail - Birmingham, AL",       type: "store", region: "South", lat: 33.5186, lng: -86.8104 },
  { id: "store-0060", name: "Demo Retail - Louisville, KY",       type: "store", region: "South", lat: 38.2527, lng: -85.7585 },
];

const WAREHOUSES: SiteDef[] = [
  { id: "warehouse-01", name: "Ontario Distribution Center, CA",     type: "warehouse", region: "West", lat: 34.0633, lng: -117.6509 },
  { id: "warehouse-02", name: "Fife Distribution Center, WA",        type: "warehouse", region: "West", lat: 47.2318, lng: -122.3654 },
  { id: "warehouse-03", name: "Naperville Distribution Center, IL",  type: "warehouse", region: "Midwest", lat: 41.7508, lng: -88.1535 },
  { id: "warehouse-04", name: "Minneapolis Distribution Center, MN", type: "warehouse", region: "Midwest", lat: 44.9778, lng: -93.265 },
  { id: "warehouse-05", name: "Nazareth Distribution Center, PA",    type: "warehouse", region: "Northeast", lat: 40.7398, lng: -75.3096 },
  { id: "warehouse-06", name: "Boston Distribution Center, MA",      type: "warehouse", region: "Northeast", lat: 42.3601, lng: -71.0589 },
  { id: "warehouse-07", name: "Dallas Distribution Center, TX",      type: "warehouse", region: "South", lat: 32.7767, lng: -96.797 },
  { id: "warehouse-08", name: "Atlanta Distribution Center, GA",     type: "warehouse", region: "South", lat: 33.749, lng: -84.388 },
];

const OFFICES: SiteDef[] = [
  { id: "office-1", name: "Monrovia Headquarters, CA",     type: "office", region: "West", lat: 34.1442, lng: -118.0019 },
  { id: "office-2", name: "East Coast Operations, NJ",     type: "office", region: "Northeast", lat: 40.7357, lng: -74.1724 },
  { id: "office-3", name: "Midwest Operations, IL",        type: "office", region: "Midwest", lat: 41.8781, lng: -87.6298 },
  { id: "office-4", name: "South Operations, GA",          type: "office", region: "South", lat: 33.749, lng: -84.388 },
  { id: "office-5", name: "Product Innovation, CA",        type: "office", region: "West", lat: 34.1478, lng: -118.1445 },
];

const DATACENTERS: SiteDef[] = [
  { id: "datacenter-1", name: "West DC - Phoenix, AZ",   type: "datacenter", region: "West", lat: 33.4484, lng: -112.074 },
  { id: "datacenter-2", name: "Central DC - Chicago, IL", type: "datacenter", region: "Midwest", lat: 41.8781, lng: -87.6298 },
  { id: "datacenter-3", name: "East DC - Ashburn, VA",    type: "datacenter", region: "Northeast", lat: 39.0438, lng: -77.4874 },
];

const ALL_SITES: SiteDef[] = [...STORES, ...WAREHOUSES, ...OFFICES, ...DATACENTERS];

// ── Event + log generation ────────────────────────────────────────────────────
function buildEventsAndLogs(sites: SiteDef[]): { events: SiteHealthCheckEvent[]; logs: LogRecord[] } {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const events: SiteHealthCheckEvent[] = [];
  const logs: LogRecord[] = [];

  for (const site of sites) {
    const categories = CATEGORIES_BY_SITE_TYPE[site.type];
    for (const category of categories) {
      const rng = rngFor(`${site.id}|${category}`);
      const status = pickStatus(rng);
      const detail = pickDetail(category as AnyCategory, status, rng);

      const data: SiteHealthCheck = {
        "site.id":       site.id,
        "site.name":     site.name,
        "site.type":     site.type,
        "site.region":   site.region,
        "site.lat":      site.lat,
        "site.lng":      site.lng,
        category:        category,
        status:          status,
        "status.detail": detail,
      } as SiteHealthCheck;

      events.push({
        specversion: "1.0",
        id:          randomUUID(),
        source:      DT_BIZEVENT_PROVIDER,
        type:        BIZEVENT_TYPE,
        time:        nowIso,
        data:        data,
      });

      // Correlated log lines. Each level pulls from its own template pool so
      // WARN/ERROR content reads as WARN/ERROR-y even for a mostly-healthy site.
      const perLevel = LOGS_BY_STATUS[status];
      const POOL_KEY: Record<LogRecord["log.level"], Status> =
        { INFO: "healthy", WARN: "degraded", ERROR: "unhealthy" };
      for (const level of ["INFO", "WARN", "ERROR"] as const) {
        const pool = LOG_TEMPLATES[category]?.[POOL_KEY[level]] ?? [];
        const count = perLevel[level];
        for (let i = 0; i < count && pool.length > 0; i++) {
          const line = pool[Math.floor(rng() * pool.length)]!;
          const offsetMs = Math.floor(rng() * 10 * 60 * 1000);
          logs.push({
            timestamp: new Date(now - offsetMs).toISOString(),
            content: `[${site.type}/${category}] ${site.name} — ${line}`,
            "log.level": level,
            "log.source": LOG_SOURCE,
            "site.id": site.id,
            "site.name": site.name,
            "site.type": site.type,
            "site.region": site.region,
            category: category as AnyCategory,
            "site.status": status,
          });
        }
      }
    }
  }
  return { events, logs };
}

function summarize(events: SiteHealthCheckEvent[]): Record<Status, number> {
  const acc: Record<Status, number> = { healthy: 0, degraded: 0, unhealthy: 0 };
  for (const e of events) acc[e.data.status]++;
  return acc;
}

// ── Ingest ────────────────────────────────────────────────────────────────────
async function ingestBizeventBatch(events: SiteHealthCheckEvent[]): Promise<void> {
  const url = `${DT_ENV_URL}/platform/classic/environment-api/v2/bizevents/ingest`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${DT_PLATFORM_TOKEN}`,
      "Content-Type": "application/cloudevents-batch+json",
    },
    body: JSON.stringify(events),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Bizevent ingest failed: HTTP ${res.status}\n${await res.text()}`);
  }
}

async function ingestLogBatch(records: LogRecord[]): Promise<void> {
  const url = `${DT_ENV_URL}/platform/classic/environment-api/v2/logs/ingest`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${DT_PLATFORM_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(records),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Log ingest failed: HTTP ${res.status}\n${await res.text()}`);
  }
}

// Metric ingestion — 12 buckets per (site, category) in line protocol.
// Kept in sync with the workflow task at automation/site-health-seed-task.js.
const METRIC_BUCKETS = 12;
const METRIC_BUCKET_MS = 5 * 60 * 1000;
const METRIC_LINE_BATCH = 1000;
const CATEGORY_BASELINE_MS: Record<string, number> = {
  network: 60, system: 40, device: 30, pos: 300, portal: 500, printer: 25,
};

function buildMetricLines(sites: SiteDef[]): string[] {
  const lines: string[] = [];
  const now = Date.now();
  const anchor = now - (now % METRIC_BUCKET_MS);
  for (const site of sites) {
    for (const category of CATEGORIES_BY_SITE_TYPE[site.type]) {
      const rng = rngFor(`${site.id}|${category}`);
      const status = pickStatus(rng);
      const baseline = CATEGORY_BASELINE_MS[category] ?? 100;
      const bucketRng = rngFor(`${site.id}|${category}|buckets`);
      for (let b = 0; b < METRIC_BUCKETS; b++) {
        const ts = anchor - (METRIC_BUCKETS - 1 - b) * METRIC_BUCKET_MS;
        const jitter = 0.8 + bucketRng() * 0.4;
        const scale =
          status === "healthy"   ? jitter :
          status === "degraded"  ? 2 + bucketRng() * 1.5 :
                                   4 + bucketRng() * 4;
        const responseMs = (baseline * scale).toFixed(1);
        const errorCount =
          status === "healthy"   ? 0 :
          status === "degraded"  ? Math.floor(bucketRng() * 3) + 1 :
                                   Math.floor(bucketRng() * 12) + 3;
        const region = site.region.replace(/\s+/g, "_");
        const dims = `site.id=${site.id},site.type=${site.type},site.region=${region},category=${category}`;
        lines.push(`custom.ops_health.response_ms,${dims} gauge,${responseMs} ${ts}`);
        lines.push(`custom.ops_health.error_count,${dims} count,delta=${errorCount} ${ts}`);
      }
    }
  }
  return lines;
}

async function ingestMetricBatch(lines: string[]): Promise<void> {
  const url = `${DT_ENV_URL}/platform/classic/environment-api/v2/metrics/ingest`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${DT_PLATFORM_TOKEN}`,
      "Content-Type": "text/plain; charset=utf-8",
    },
    body: lines.join("\n"),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Metric ingest failed: HTTP ${res.status}\n${await res.text()}`);
  }
}

async function main(): Promise<void> {
  const { events, logs } = buildEventsAndLogs(ALL_SITES);
  const dist = summarize(events);
  const pct = (n: number) => ((n / events.length) * 100).toFixed(1) + "%";
  console.log(`Sites:  ${ALL_SITES.length}  (stores=${STORES.length}, warehouses=${WAREHOUSES.length}, offices=${OFFICES.length}, datacenters=${DATACENTERS.length})`);
  console.log(`Events: ${events.length}  seed=${DT_SEED}  provider=${DT_BIZEVENT_PROVIDER}`);
  console.log(`Logs:   ${logs.length}`);
  console.log(`Status: healthy=${dist.healthy} (${pct(dist.healthy)}), degraded=${dist.degraded} (${pct(dist.degraded)}), unhealthy=${dist.unhealthy} (${pct(dist.unhealthy)})`);

  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const batch = events.slice(i, i + BATCH_SIZE);
    await ingestBizeventBatch(batch);
    console.log(`  bizevents batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} ingested`);
  }
  for (let i = 0; i < logs.length; i += BATCH_SIZE) {
    const batch = logs.slice(i, i + BATCH_SIZE);
    await ingestLogBatch(batch);
    console.log(`  logs batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} ingested`);
  }
  const metricLines = buildMetricLines(ALL_SITES);
  console.log(`Metrics: ${metricLines.length} line-protocol samples`);
  for (let i = 0; i < metricLines.length; i += METRIC_LINE_BATCH) {
    const batch = metricLines.slice(i, i + METRIC_LINE_BATCH);
    await ingestMetricBatch(batch);
    console.log(`  metrics batch ${Math.floor(i / METRIC_LINE_BATCH) + 1}: ${batch.length} ingested`);
  }
  console.log("Done. Give Grail ~30s before querying metrics back (custom metric indexing has some latency).");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
