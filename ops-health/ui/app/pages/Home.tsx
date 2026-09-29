import React, { useMemo } from "react";
import { useDql } from "@dynatrace-sdk/react-hooks";
import { Link as RouterLink } from "react-router-dom";
import { Flex, Grid, Surface } from "@dynatrace/strato-components/layouts";
import { Heading, Paragraph, Text } from "@dynatrace/strato-components/typography";
import { HealthIndicator, MessageContainer } from "@dynatrace/strato-components/content";
import Colors from "@dynatrace/strato-design-tokens/colors";
import { StatusTile } from "../components/StatusTile";
import {
  SITE_TYPES,
  SITE_TYPE_META,
  formatSiteName,
  worstOf,
  type Status,
  type SiteType,
} from "../schema/siteHealth";
import {
  siteTypeRollupQuery,
  topProblemSitesQuery,
  type SiteTypeRollupRow,
  type ProblemSiteRow,
} from "../queries/siteHealth";
import { useTimeframe } from "../context/TimeframeContext";
import { useSettings } from "../context/SettingsContext";

interface TileState {
  siteStatus: Status;
  total: number;
  healthy: number;
  degraded: number;
  unhealthy: number;
}

const STATUS_COLOR: Record<Status, string> = {
  healthy:   Colors.Charts.Status.Ideal.Default,
  degraded:  Colors.Charts.Status.Warning.Default,
  unhealthy: Colors.Charts.Status.Critical.Default,
};

const KPI_LABEL_STYLE = {
  textTransform: "uppercase" as const,
  letterSpacing: "0.06em",
  opacity: 0.7,
  fontSize: 11,
};

// Compact "N HEALTHY" / "N DEGRADED" / "N UNHEALTHY" stat card. Small footprint
// so the tile grid below stays the visual focus of the overview page.
function HeroStat({ label, value, status }: { label: string; value: number; status: Status }) {
  return (
    <Surface style={{ padding: 12, flex: 1, borderLeft: `3px solid ${STATUS_COLOR[status]}` }}>
      <Flex gap={8} alignItems="baseline">
        <Heading level={3} style={{ margin: 0, fontSize: 24, lineHeight: 1, color: STATUS_COLOR[status] }}>
          {value}
        </Heading>
        <Text style={KPI_LABEL_STYLE}>{label}</Text>
      </Flex>
    </Surface>
  );
}

// Single row inside the "Sites needing attention" panel.
function ProblemRow({ site, customerName }: { site: ProblemSiteRow; customerName: string }) {
  const siteName = formatSiteName(site["site.name"], customerName);
  const worstDetail = site.perCategory
    .filter((c) => c.status !== "healthy")
    .map((c) => c["status.detail"])
    .filter((d) => d && d.length > 0)[0] ?? "";
  const category = site.perCategory
    .filter((c) => c.status !== "healthy")
    .sort((a) => (a.status === "unhealthy" ? -1 : 1))[0]?.category ?? "";
  // Deep-link with ?focus=<site.id> so the detail page auto-focuses this site
  // and immediately shows its logs. Falls through to normal filtering if the
  // param is missing.
  const route = `${SITE_TYPE_META[site["site.type"]].route}?focus=${encodeURIComponent(site["site.id"])}`;
  const indicator = site.siteStatus === "unhealthy" ? "critical" : "warning";

  return (
    <RouterLink to={route} style={{ textDecoration: "none", color: "inherit" }}>
      <Flex
        gap={16}
        alignItems="center"
        padding={12}
        style={{
          borderLeft: `4px solid ${STATUS_COLOR[site.siteStatus as Status]}`,
          borderRadius: 4,
          background: "var(--dt-colors-background-container-primary-default)",
          cursor: "pointer",
        }}
      >
        <HealthIndicator status={indicator} visual="icon" />
        <Flex flexDirection="column" gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ fontWeight: 600 }}>{siteName}</Text>
          <Text textStyle="small" style={{ opacity: 0.7 }}>
            {site["site.region"]} · {SITE_TYPE_META[site["site.type"]].plural.slice(0, -1)}
            {category ? ` · ${category}` : ""}
          </Text>
        </Flex>
        {worstDetail && (
          <Text textStyle="small" style={{ maxWidth: 320, textAlign: "right", opacity: 0.85 }}>
            {worstDetail}
          </Text>
        )}
      </Flex>
    </RouterLink>
  );
}

export const Home = () => {
  const { timeframe } = useTimeframe();
  const { settings } = useSettings();

  const rollupQuery = useMemo(() => siteTypeRollupQuery(timeframe), [timeframe]);
  const { data, isLoading, error } = useDql(rollupQuery, { refetchInterval: 60000 });

  const problemsQuery = useMemo(() => topProblemSitesQuery(timeframe, 10), [timeframe]);
  const problemsResult = useDql(problemsQuery, { refetchInterval: 60000 });

  const rowsByType: Partial<Record<SiteType, TileState>> = {};
  if (data?.records) {
    for (const raw of data.records as unknown as SiteTypeRollupRow[]) {
      const siteType = raw["site.type"];
      const healthy   = Number(raw.healthy   ?? 0);
      const degraded  = Number(raw.degraded  ?? 0);
      const unhealthy = Number(raw.unhealthy ?? 0);
      const total     = Number(raw.total     ?? 0);
      const statuses: Status[] = [];
      if (unhealthy > 0) statuses.push("unhealthy");
      if (degraded  > 0) statuses.push("degraded");
      if (statuses.length === 0) statuses.push("healthy");
      rowsByType[siteType] = {
        siteStatus: worstOf(statuses),
        total,
        healthy,
        degraded,
        unhealthy,
      };
    }
  }

  const visibleTypes = SITE_TYPES.filter((t) => settings.tiles[t].visible);

  const totals = visibleTypes.reduce(
    (acc, t) => {
      const s = rowsByType[t];
      if (!s) return acc;
      acc.total     += s.total;
      acc.healthy   += s.healthy;
      acc.degraded  += s.degraded;
      acc.unhealthy += s.unhealthy;
      return acc;
    },
    { total: 0, healthy: 0, degraded: 0, unhealthy: 0 },
  );

  const problemSites = useMemo<ProblemSiteRow[]>(() => {
    if (!problemsResult.data?.records) return [];
    return problemsResult.data.records as unknown as ProblemSiteRow[];
  }, [problemsResult.data]);

  // Filter the problem list to visible site types so hiding a tile hides its
  // problem sites from the panel too.
  const visibleProblemSites = useMemo<ProblemSiteRow[]>(() => {
    const set = new Set<SiteType>(visibleTypes);
    return problemSites.filter((s) => set.has(s["site.type"]));
  }, [problemSites, visibleTypes]);

  return (
    <Flex flexDirection="column" gap={32} padding={40}>
      <Flex flexDirection="column" gap={4}>
        <Heading level={1} style={{ margin: 0 }}>
          {settings.customerName ? `${settings.customerName} - Ops Health` : "Ops Health"}
        </Heading>
        <Text textStyle="base-emphasized" style={{ opacity: 0.85 }}>
          Real-time status across every location.
        </Text>
        <Paragraph>Timeframe controlled in the header — widen it to see history, narrow it to focus.</Paragraph>
      </Flex>

      {error && (
        <MessageContainer variant="critical">
          <MessageContainer.Title>Couldn&apos;t load status</MessageContainer.Title>
          <MessageContainer.Description>
            {error.message ?? "The health rollup query failed."}
          </MessageContainer.Description>
        </MessageContainer>
      )}

      {/* Hero strip: three big numbers at a glance. */}
      <Flex gap={16}>
        <HeroStat label="Healthy"   value={totals.healthy}   status="healthy" />
        <HeroStat label="Degraded"  value={totals.degraded}  status="degraded" />
        <HeroStat label="Unhealthy" value={totals.unhealthy} status="unhealthy" />
      </Flex>

      {visibleTypes.length === 0 ? (
        <MessageContainer variant="neutral">
          <MessageContainer.Title>All tiles are hidden</MessageContainer.Title>
          <MessageContainer.Description>
            Open Settings (top right) to bring at least one tile back.
          </MessageContainer.Description>
        </MessageContainer>
      ) : (
        <Grid gridTemplateColumns="repeat(auto-fit, minmax(300px, 1fr))" gap={24}>
          {visibleTypes.map((siteType) => {
            const meta  = SITE_TYPE_META[siteType];
            const tile  = settings.tiles[siteType];
            const s     = rowsByType[siteType];
            const isEmpty = !isLoading && !s;
            return (
              <StatusTile
                key={siteType}
                label={tile.label || meta.plural}
                route={meta.route}
                isLoading={isLoading}
                isEmpty={isEmpty}
                siteStatus={s?.siteStatus}
                total={s?.total}
                healthy={s?.healthy}
                degraded={s?.degraded}
                unhealthy={s?.unhealthy}
              />
            );
          })}
        </Grid>
      )}

      {/* Sites needing attention — top 10 across all visible types. */}
      <Flex flexDirection="column" gap={12}>
        <Flex justifyContent="space-between" alignItems="baseline">
          <Heading level={3} style={{ margin: 0 }}>Sites needing attention</Heading>
          <Text textStyle="small" style={{ opacity: 0.6 }}>
            {visibleProblemSites.length === 0
              ? "Everything looks healthy right now."
              : `Top ${visibleProblemSites.length} — click a row to jump into the detail view.`}
          </Text>
        </Flex>
        {visibleProblemSites.length === 0 ? (
          <Surface style={{ padding: 24 }}>
            <Flex gap={12} alignItems="center">
              <HealthIndicator status="ideal" visual="icon" />
              <Text>No degraded or unhealthy sites in this timeframe.</Text>
            </Flex>
          </Surface>
        ) : (
          <Flex flexDirection="column" gap={8}>
            {visibleProblemSites.map((site) => (
              <ProblemRow key={site["site.id"]} site={site} customerName={settings.customerName} />
            ))}
          </Flex>
        )}
      </Flex>
    </Flex>
  );
};
