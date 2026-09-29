// Kept in sync with /shared/schema/siteHealth.ts and automation/site-health-seed-task.js.
// Copied (not imported) so the dt-app bundler stays scoped to ui/.

export const SITE_TYPES = ["store", "warehouse", "office", "datacenter"] as const;
export type SiteType = (typeof SITE_TYPES)[number];

export const REGIONS = ["West", "Midwest", "Northeast", "South"] as const;
export type Region = (typeof REGIONS)[number];

export const STATUSES = ["healthy", "degraded", "unhealthy"] as const;
export type Status = (typeof STATUSES)[number];

export const CATEGORIES_BY_SITE_TYPE = {
  store:      ["network", "system", "device", "pos",     "portal"] as const,
  warehouse:  ["network", "system", "device", "printer"]           as const,
  office:     ["network", "system"]                                as const,
  datacenter: ["network", "system"]                                as const,
} as const;

export type CategoryFor<T extends SiteType> =
  (typeof CATEGORIES_BY_SITE_TYPE)[T][number];

// Union of every category across every site.type (office/datacenter share categories with store).
export type AnyCategory =
  | (typeof CATEGORIES_BY_SITE_TYPE.store)[number]
  | (typeof CATEGORIES_BY_SITE_TYPE.warehouse)[number];

export const BIZEVENT_PROVIDER = "trader-joes.ops-health";
export const BIZEVENT_TYPE = "site.health.check";

// The customer prefix baked into ingested site.name values by the default seed/workflow.
// Kept here so the display-name rewriter can strip it in favour of the current
// customer name from settings, without re-ingesting any data.
export const DEFAULT_CUSTOMER_PREFIX = "Trader Joe's";

// Rewrite a raw site.name to use the current customer prefix from settings.
// Handles two shapes:
//   "Trader Joe's - Pasadena, CA"   → "<customerName> - Pasadena, CA"
//   "Ontario Distribution Center"   → unchanged (never had the prefix)
export function formatSiteName(rawName: string, customerName: string): string {
  if (!customerName || customerName === DEFAULT_CUSTOMER_PREFIX) return rawName;
  const prefix = `${DEFAULT_CUSTOMER_PREFIX} - `;
  if (rawName.startsWith(prefix)) {
    return `${customerName} - ${rawName.slice(prefix.length)}`;
  }
  return rawName;
}

// Display labels + routes for the four overview tiles.
export const SITE_TYPE_META: Record<SiteType, { label: string; plural: string; route: string }> = {
  store:      { label: "Stores",      plural: "Stores",      route: "/stores" },
  warehouse:  { label: "Warehouses",  plural: "Warehouses",  route: "/warehouses" },
  office:     { label: "Offices",     plural: "Offices",     route: "/offices" },
  datacenter: { label: "Datacenters", plural: "Datacenters", route: "/datacenters" },
};

// Map our status vocabulary to Strato's HealthIndicator status prop.
export type HealthIndicatorStatus = "ideal" | "good" | "neutral" | "warning" | "critical";
export const STATUS_TO_INDICATOR: Record<Status, HealthIndicatorStatus> = {
  healthy:   "ideal",
  degraded:  "warning",
  unhealthy: "critical",
};

// Rollup precedence: worst-of. unhealthy > degraded > healthy.
export const STATUS_RANK: Record<Status, number> = {
  healthy:   0,
  degraded:  1,
  unhealthy: 2,
};

export function worstOf(statuses: readonly Status[]): Status {
  let worst: Status = "healthy";
  for (const s of statuses) {
    if (STATUS_RANK[s] > STATUS_RANK[worst]) worst = s;
  }
  return worst;
}
