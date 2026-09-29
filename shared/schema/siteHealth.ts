// Site health check bizevent schema.
// Shared by the seed script (scripts/seed-site-health.ts) and the Dynatrace app.
// Field names use dotted keys so they land in Grail with the same name (site.id, etc.).

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

export type StoreCategory      = (typeof CATEGORIES_BY_SITE_TYPE.store)[number];
export type WarehouseCategory  = (typeof CATEGORIES_BY_SITE_TYPE.warehouse)[number];
export type OfficeCategory     = (typeof CATEGORIES_BY_SITE_TYPE.office)[number];
export type DatacenterCategory = (typeof CATEGORIES_BY_SITE_TYPE.datacenter)[number];

export type CategoryFor<T extends SiteType> =
  (typeof CATEGORIES_BY_SITE_TYPE)[T][number];

export type AnyCategory =
  | StoreCategory
  | WarehouseCategory
  | OfficeCategory
  | DatacenterCategory;

export interface SiteHealthCheckOf<T extends SiteType> {
  "site.id":       string;
  "site.name":     string;
  "site.type":     T;
  "site.region":   Region;
  "site.lat":      number;
  "site.lng":      number;
  category:        CategoryFor<T>;
  status:          Status;
  "status.detail": string;
}

export type SiteHealthCheck =
  | SiteHealthCheckOf<"store">
  | SiteHealthCheckOf<"warehouse">
  | SiteHealthCheckOf<"office">
  | SiteHealthCheckOf<"datacenter">;

export const BIZEVENT_TYPE = "site.health.check";

export interface SiteHealthCheckEvent {
  specversion: "1.0";
  id:          string;
  source:      string;
  type:        typeof BIZEVENT_TYPE;
  time:        string;
  data:        SiteHealthCheck;
}
