// Dynatrace AutomationEngine JavaScript task.
// Generates and ingests synthetic site.health.check bizevents for the Trader Joe's
// Ops Health demo. Runs hourly via cron. Duplicates the shared/schema data and
// scripts/seed-site-health.ts generator logic — kept in sync manually.
//
// Ingests via relative-path fetch to /platform/classic/environment-api/v2/bizevents/ingest
// because the SDK's businessEventsClient.ingest() type enum does not accept the
// batch mimetype (application/cloudevents-batch+json). Relative platform paths
// auto-authenticate via the workflow actor.

const BIZEVENT_INGEST_PATH = "/platform/classic/environment-api/v2/bizevents/ingest";
const LOGS_INGEST_PATH     = "/platform/classic/environment-api/v2/logs/ingest";
const METRICS_INGEST_PATH  = "/platform/classic/environment-api/v2/metrics/ingest";

// How many 5-min buckets to backfill on every workflow run. 12 → last hour.
// Enough that charts pop with real data on the first tick, and each hourly
// tick keeps the previous points visible.
const METRIC_BUCKETS = 12;
const METRIC_BUCKET_MS = 5 * 60 * 1000;

// Category-baseline latency in ms; multiplied by status jitter below.
const CATEGORY_BASELINE_MS = {
  network: 60,
  system: 40,
  device: 30,
  pos: 300,
  portal: 500,
  printer: 25,
};

// Line-protocol batch cap. Metrics ingest supports up to 5MB per request, but
// keeping batches small keeps failures localized.
const METRIC_LINE_BATCH = 1000;
const BIZEVENT_TYPE   = "site.health.check";
const DEFAULT_PROVIDER = "trader-joes.ops-health";
const LOG_SOURCE       = "trader-joes.ops-health";
const DEFAULT_SEED = 42;
const BATCH_SIZE   = 200;

// Log lines to emit per (site, category), by severity level. Every status gets
// some INFO events (routine chatter) so each panel has non-zero counts across
// all three level cards; degraded/unhealthy sites get WARN and ERROR on top.
const LOGS_BY_STATUS = {
  healthy:   { INFO: 3, WARN: 0, ERROR: 0 },
  degraded:  { INFO: 2, WARN: 4, ERROR: 0 },
  unhealthy: { INFO: 2, WARN: 3, ERROR: 5 },
};

// Log copy pools per (category, status). Kept alongside REASONS so the two feel
// like the same incident, not two disjoint stories.
const LOG_TEMPLATES = {
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
    unhealthy: ["Employee portal returning 5xx — 22 failed page loads in 3m", "SSO login failing for portal.corp.tj.local"],
  },
  printer: {
    healthy:   ["Label printer queue empty, last job success", "Toner levels nominal across all printers"],
    degraded:  ["Toner low on label printer B", "Print queue backlog: 47 jobs waiting"],
    unhealthy: ["Label printer B jam — manual clear required", "Printer OFFLINE; job queue holding"],
  },
};

const CATEGORIES_BY_SITE_TYPE = {
  store:      ["network", "system", "device", "pos", "portal"],
  warehouse:  ["network", "system", "device", "printer"],
  office:     ["network", "system"],
  datacenter: ["network", "system"],
};

const REASONS = {
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

// Compact site inventory: [id, name, type, region].
const SITES = [
  ["store-0001", "Trader Joe's - Pasadena, CA",        "store", "West", 34.1478, -118.1445],
  ["store-0002", "Trader Joe's - Santa Monica, CA",    "store", "West", 34.0195, -118.4912],
  ["store-0003", "Trader Joe's - San Francisco, CA",   "store", "West", 37.7749, -122.4194],
  ["store-0004", "Trader Joe's - Seattle, WA",         "store", "West", 47.6062, -122.3321],
  ["store-0005", "Trader Joe's - Portland, OR",        "store", "West", 45.5152, -122.6784],
  ["store-0006", "Trader Joe's - Denver, CO",          "store", "West", 39.7392, -104.9903],
  ["store-0007", "Trader Joe's - Phoenix, AZ",         "store", "West", 33.4484, -112.074],
  ["store-0008", "Trader Joe's - San Diego, CA",       "store", "West", 32.7157, -117.1611],
  ["store-0009", "Trader Joe's - Berkeley, CA",        "store", "West", 37.8715, -122.273],
  ["store-0010", "Trader Joe's - Sacramento, CA",      "store", "West", 38.5816, -121.4944],
  ["store-0011", "Trader Joe's - Las Vegas, NV",       "store", "West", 36.1699, -115.1398],
  ["store-0012", "Trader Joe's - Boise, ID",           "store", "West", 43.615, -116.2023],
  ["store-0013", "Trader Joe's - Salt Lake City, UT",  "store", "West", 40.7608, -111.891],
  ["store-0014", "Trader Joe's - Los Angeles, CA",     "store", "West", 34.0522, -118.2437],
  ["store-0015", "Trader Joe's - Bellevue, WA",        "store", "West", 47.6101, -122.2015],
  ["store-0016", "Trader Joe's - Chicago, IL",         "store", "Midwest", 41.8781, -87.6298],
  ["store-0017", "Trader Joe's - Naperville, IL",      "store", "Midwest", 41.7508, -88.1535],
  ["store-0018", "Trader Joe's - Minneapolis, MN",     "store", "Midwest", 44.9778, -93.265],
  ["store-0019", "Trader Joe's - Saint Paul, MN",      "store", "Midwest", 44.9537, -93.09],
  ["store-0020", "Trader Joe's - Milwaukee, WI",       "store", "Midwest", 43.0389, -87.9065],
  ["store-0021", "Trader Joe's - Madison, WI",         "store", "Midwest", 43.0731, -89.4012],
  ["store-0022", "Trader Joe's - Kansas City, MO",     "store", "Midwest", 39.0997, -94.5786],
  ["store-0023", "Trader Joe's - Saint Louis, MO",     "store", "Midwest", 38.627, -90.1994],
  ["store-0024", "Trader Joe's - Cincinnati, OH",      "store", "Midwest", 39.1031, -84.512],
  ["store-0025", "Trader Joe's - Columbus, OH",        "store", "Midwest", 39.9612, -82.9988],
  ["store-0026", "Trader Joe's - Cleveland, OH",       "store", "Midwest", 41.4993, -81.6944],
  ["store-0027", "Trader Joe's - Indianapolis, IN",    "store", "Midwest", 39.7684, -86.1581],
  ["store-0028", "Trader Joe's - Ann Arbor, MI",       "store", "Midwest", 42.2808, -83.743],
  ["store-0029", "Trader Joe's - Detroit, MI",         "store", "Midwest", 42.3314, -83.0458],
  ["store-0030", "Trader Joe's - Des Moines, IA",      "store", "Midwest", 41.5868, -93.625],
  ["store-0031", "Trader Joe's - Boston, MA",          "store", "Northeast", 42.3601, -71.0589],
  ["store-0032", "Trader Joe's - Cambridge, MA",       "store", "Northeast", 42.3736, -71.1097],
  ["store-0033", "Trader Joe's - Union Square, NY",    "store", "Northeast", 40.7359, -73.9911],
  ["store-0034", "Trader Joe's - Brooklyn, NY",        "store", "Northeast", 40.6782, -73.9442],
  ["store-0035", "Trader Joe's - Upper West Side, NY", "store", "Northeast", 40.787, -73.9754],
  ["store-0036", "Trader Joe's - Chelsea, NY",         "store", "Northeast", 40.7465, -74.0014],
  ["store-0037", "Trader Joe's - Jersey City, NJ",     "store", "Northeast", 40.7178, -74.0431],
  ["store-0038", "Trader Joe's - Princeton, NJ",       "store", "Northeast", 40.3573, -74.6672],
  ["store-0039", "Trader Joe's - Philadelphia, PA",    "store", "Northeast", 39.9526, -75.1652],
  ["store-0040", "Trader Joe's - Pittsburgh, PA",      "store", "Northeast", 40.4406, -79.9959],
  ["store-0041", "Trader Joe's - Portland, ME",        "store", "Northeast", 43.6591, -70.2568],
  ["store-0042", "Trader Joe's - Providence, RI",      "store", "Northeast", 41.824, -71.4128],
  ["store-0043", "Trader Joe's - Hartford, CT",        "store", "Northeast", 41.7658, -72.6734],
  ["store-0044", "Trader Joe's - White Plains, NY",    "store", "Northeast", 41.034, -73.7629],
  ["store-0045", "Trader Joe's - Washington, DC",      "store", "Northeast", 38.9072, -77.0369],
  ["store-0046", "Trader Joe's - Austin, TX",          "store", "South", 30.2672, -97.7431],
  ["store-0047", "Trader Joe's - Houston, TX",         "store", "South", 29.7604, -95.3698],
  ["store-0048", "Trader Joe's - Dallas, TX",          "store", "South", 32.7767, -96.797],
  ["store-0049", "Trader Joe's - Atlanta, GA",         "store", "South", 33.749, -84.388],
  ["store-0050", "Trader Joe's - Nashville, TN",       "store", "South", 36.1627, -86.7816],
  ["store-0051", "Trader Joe's - Charlotte, NC",       "store", "South", 35.2271, -80.8431],
  ["store-0052", "Trader Joe's - Raleigh, NC",         "store", "South", 35.7796, -78.6382],
  ["store-0053", "Trader Joe's - Miami, FL",           "store", "South", 25.7617, -80.1918],
  ["store-0054", "Trader Joe's - Orlando, FL",         "store", "South", 28.5383, -81.3792],
  ["store-0055", "Trader Joe's - Tampa, FL",           "store", "South", 27.9506, -82.4572],
  ["store-0056", "Trader Joe's - New Orleans, LA",     "store", "South", 29.9511, -90.0715],
  ["store-0057", "Trader Joe's - Chapel Hill, NC",     "store", "South", 35.9132, -79.0558],
  ["store-0058", "Trader Joe's - Charleston, SC",      "store", "South", 32.7765, -79.9311],
  ["store-0059", "Trader Joe's - Birmingham, AL",      "store", "South", 33.5186, -86.8104],
  ["store-0060", "Trader Joe's - Louisville, KY",      "store", "South", 38.2527, -85.7585],
  ["warehouse-01", "Ontario Distribution Center, CA",     "warehouse", "West", 34.0633, -117.6509],
  ["warehouse-02", "Fife Distribution Center, WA",        "warehouse", "West", 47.2318, -122.3654],
  ["warehouse-03", "Naperville Distribution Center, IL",  "warehouse", "Midwest", 41.7508, -88.1535],
  ["warehouse-04", "Minneapolis Distribution Center, MN", "warehouse", "Midwest", 44.9778, -93.265],
  ["warehouse-05", "Nazareth Distribution Center, PA",    "warehouse", "Northeast", 40.7398, -75.3096],
  ["warehouse-06", "Boston Distribution Center, MA",      "warehouse", "Northeast", 42.3601, -71.0589],
  ["warehouse-07", "Dallas Distribution Center, TX",      "warehouse", "South", 32.7767, -96.797],
  ["warehouse-08", "Atlanta Distribution Center, GA",     "warehouse", "South", 33.749, -84.388],
  ["office-1", "Monrovia Headquarters, CA", "office", "West", 34.1442, -118.0019],
  ["office-2", "East Coast Operations, NJ", "office", "Northeast", 40.7357, -74.1724],
  ["office-3", "Midwest Operations, IL",    "office", "Midwest", 41.8781, -87.6298],
  ["office-4", "South Operations, GA",      "office", "South", 33.749, -84.388],
  ["office-5", "Product Innovation, CA",    "office", "West", 34.1478, -118.1445],
  ["datacenter-1", "West DC - Phoenix, AZ",    "datacenter", "West", 33.4484, -112.074],
  ["datacenter-2", "Central DC - Chicago, IL", "datacenter", "Midwest", 41.8781, -87.6298],
  ["datacenter-3", "East DC - Ashburn, VA",    "datacenter", "Northeast", 39.0438, -77.4874],
];

function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rngFor(seed, key) {
  return mulberry32(xmur3(`${seed}|${key}`));
}

function pickStatus(rng) {
  const r = rng();
  if (r < 0.92) return "healthy";
  if (r < 0.98) return "degraded";
  return "unhealthy";
}

function pickDetail(category, status, rng) {
  if (status === "healthy") return "";
  const pool = REASONS[category][status];
  return pool[Math.floor(rng() * pool.length)];
}

function buildEventsAndLogs(seed, provider) {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const events = [];
  const logs = [];
  for (const [id, name, type, region, lat, lng] of SITES) {
    for (const category of CATEGORIES_BY_SITE_TYPE[type]) {
      const rng = rngFor(seed, `${id}|${category}`);
      const status = pickStatus(rng);
      const detail = pickDetail(category, status, rng);
      events.push({
        specversion: "1.0",
        id: crypto.randomUUID(),
        source: provider,
        type: BIZEVENT_TYPE,
        time: nowIso,
        data: {
          "site.id": id,
          "site.name": name,
          "site.type": type,
          "site.region": region,
          "site.lat": lat,
          "site.lng": lng,
          category,
          status,
          "status.detail": detail,
        },
      });

      // Correlated log lines. Spread across the last ~10 minutes so timestamps tell a story.
      // Each level draws from its own template pool: healthy templates → INFO,
      // degraded templates → WARN, unhealthy templates → ERROR. Healthy sites
      // still emit INFO chatter; degraded/unhealthy sites emit a mix so the
      // Insights panel's INFO/WARN/ERROR count cards always have something to show.
      const perLevel = LOGS_BY_STATUS[status] ?? { INFO: 1, WARN: 0, ERROR: 0 };
      const POOL_KEY = { INFO: "healthy", WARN: "degraded", ERROR: "unhealthy" };
      for (const level of ["INFO", "WARN", "ERROR"]) {
        const pool = LOG_TEMPLATES[category]?.[POOL_KEY[level]] ?? [];
        const count = perLevel[level];
        for (let i = 0; i < count && pool.length > 0; i++) {
          const line = pool[Math.floor(rng() * pool.length)];
          const offsetMs = Math.floor(rng() * 10 * 60 * 1000);
          logs.push({
            timestamp: new Date(now - offsetMs).toISOString(),
            content: `[${type}/${category}] ${name} — ${line}`,
            "log.level": level,
            "log.source": LOG_SOURCE,
            "site.id": id,
            "site.name": name,
            "site.type": type,
            "site.region": region,
            category,
            "site.status": status,
          });
        }
      }
    }
  }
  return { events, logs };
}

// Build line-protocol metric samples for every (site, category, bucket) triple.
// Two metrics per triple:
//   custom.ops_health.response_ms — synthetic latency, scaled by status
//   custom.ops_health.error_count — synthetic error count per bucket, scaled by status
function buildMetricLines(seed) {
  const lines = [];
  const now = Date.now();
  // Round to the nearest bucket edge so bucket timestamps line up cleanly for charts.
  const anchor = now - (now % METRIC_BUCKET_MS);

  for (const [id, name, type, region] of SITES) {
    for (const category of CATEGORIES_BY_SITE_TYPE[type]) {
      const rng = rngFor(seed, `${id}|${category}`);
      const status = pickStatus(rng);
      const baseline = CATEGORY_BASELINE_MS[category] ?? 100;

      // Same status per (site, category) as the bizevent, but let the individual
      // bucket values fluctuate so the chart doesn't look step-function-flat.
      const bucketRng = rngFor(seed + 7919, `${id}|${category}|buckets`);
      for (let b = 0; b < METRIC_BUCKETS; b++) {
        const ts = anchor - (METRIC_BUCKETS - 1 - b) * METRIC_BUCKET_MS;
        // Latency: healthy jitters around baseline (±20%), degraded 2-3.5×, unhealthy 4-8×.
        const jitter = 0.8 + bucketRng() * 0.4;
        const scale =
          status === "healthy"   ? jitter :
          status === "degraded"  ? 2 + bucketRng() * 1.5 :
                                   4 + bucketRng() * 4;
        const responseMs = (baseline * scale).toFixed(1);

        // Errors per 5-min bucket, scaled by status.
        const errorCount =
          status === "healthy"   ? 0 :
          status === "degraded"  ? Math.floor(bucketRng() * 3) + 1 :
                                   Math.floor(bucketRng() * 12) + 3;

        const dims = `site.id=${id},site.type=${type},site.region=${region.replace(/\s+/g, "_")},category=${category}`;
        lines.push(`custom.ops_health.response_ms,${dims} gauge,${responseMs} ${ts}`);
        lines.push(`custom.ops_health.error_count,${dims} count,delta=${errorCount} ${ts}`);
      }
    }
  }
  return lines;
}

async function ingestMetrics(lines) {
  let ingested = 0;
  for (let i = 0; i < lines.length; i += METRIC_LINE_BATCH) {
    const batch = lines.slice(i, i + METRIC_LINE_BATCH);
    const res = await fetch(METRICS_INGEST_PATH, {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: batch.join("\n"),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Metric ingest failed: HTTP ${res.status} — ${await res.text()}`);
    }
    ingested += batch.length;
    console.log(`  metrics batch ${Math.floor(i / METRIC_LINE_BATCH) + 1}: ${batch.length} (HTTP ${res.status})`);
  }
  return ingested;
}

async function ingestBizevents(events) {
  let ingested = 0;
  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const batch = events.slice(i, i + BATCH_SIZE);
    const res = await fetch(BIZEVENT_INGEST_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/cloudevents-batch+json" },
      body: JSON.stringify(batch),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Bizevent ingest failed: HTTP ${res.status} — ${await res.text()}`);
    }
    ingested += batch.length;
    console.log(`  bizevents batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} (HTTP ${res.status})`);
  }
  return ingested;
}

async function ingestLogs(logs) {
  let ingested = 0;
  for (let i = 0; i < logs.length; i += BATCH_SIZE) {
    const batch = logs.slice(i, i + BATCH_SIZE);
    const res = await fetch(LOGS_INGEST_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Log ingest failed: HTTP ${res.status} — ${await res.text()}`);
    }
    ingested += batch.length;
    console.log(`  logs batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} (HTTP ${res.status})`);
  }
  return ingested;
}

export default async function (event) {
  const payload = event?.payload ?? {};
  const seed = Number(payload.seed ?? DEFAULT_SEED);
  const provider = String(payload.provider ?? DEFAULT_PROVIDER);

  const { events, logs } = buildEventsAndLogs(seed, provider);
  const metricLines = buildMetricLines(seed);
  const dist = events.reduce((acc, e) => {
    acc[e.data.status] = (acc[e.data.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`Generated ${events.length} bizevents + ${logs.length} logs + ${metricLines.length} metric samples (seed=${seed}, provider=${provider})`);
  console.log(`Bizevent status distribution: ${JSON.stringify(dist)}`);

  const bizIngested = await ingestBizevents(events);
  const logsIngested = await ingestLogs(logs);
  const metricsIngested = await ingestMetrics(metricLines);

  return {
    bizeventsIngested: bizIngested,
    logsIngested,
    metricsIngested,
    seed,
    provider,
    distribution: dist,
    timestamp: new Date().toISOString(),
  };
}
