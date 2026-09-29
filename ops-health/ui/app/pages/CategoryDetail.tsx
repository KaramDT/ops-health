import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useDql } from "@dynatrace-sdk/react-hooks";
import { Flex, Surface } from "@dynatrace/strato-components/layouts";
import { Heading, Paragraph, Text } from "@dynatrace/strato-components/typography";
import { HealthIndicator, MessageContainer } from "@dynatrace/strato-components/content";
import { Tooltip } from "@dynatrace/strato-components/overlays";
import { TextInput, Select, FormField, Label } from "@dynatrace/strato-components/forms";
import { DataTable, type DataTableColumnDef } from "@dynatrace/strato-components/tables";
import { TimeseriesChart, type Timeseries } from "@dynatrace/strato-components/charts";
import Colors from "@dynatrace/strato-design-tokens/colors";
import {
  CATEGORIES_BY_SITE_TYPE,
  REGIONS,
  SITE_TYPE_META,
  STATUSES,
  STATUS_TO_INDICATOR,
  STATUS_RANK,
  formatSiteName,
  type SiteType,
  type Status,
  type Region,
} from "../schema/siteHealth";
import {
  detailQueryForSiteType,
  siteLogsQuery,
  metricsQueryForSite,
  type SiteDetailRow,
  type SiteLogRow,
} from "../queries/siteHealth";
import { useTimeframe } from "../context/TimeframeContext";
import type { TimeframeValue } from "../components/Header";
import { useSettings } from "../context/SettingsContext";
import { Button } from "@dynatrace/strato-components/buttons";
import { SiteMap, type MappableSite } from "../components/SiteMap";

interface CategoryDetailProps {
  siteType: SiteType;
}

// Row shape the DataTable actually consumes — perCategory flattened into cat_<name> fields
// so each category can be its own sortable column with an accessor. Also holds coords so
// the map + table share one filter path.
type TableRow = {
  siteId: string;
  siteName: string;
  siteRegion: string;
  siteStatus: Status;
  worstRank: number;
  lastUpdated: Date;
  detailsByCategory: Record<string, string>;
  latitude: number | null;
  longitude: number | null;
} & Record<`cat_${string}`, Status | undefined>;

function toTableRow(raw: SiteDetailRow): TableRow {
  const detailsByCategory: Record<string, string> = {};
  const categoryFields: Record<`cat_${string}`, Status | undefined> = {};
  for (const c of raw.perCategory ?? []) {
    detailsByCategory[c.category] = c["status.detail"] ?? "";
    (categoryFields as Record<string, Status | undefined>)[`cat_${c.category}`] = c.status;
  }
  const lat = raw["site.lat"];
  const lng = raw["site.lng"];
  return {
    siteId: raw["site.id"],
    siteName: raw["site.name"],
    siteRegion: raw["site.region"],
    siteStatus: raw.siteStatus,
    worstRank: Number(raw.worstRank ?? 0),
    lastUpdated: new Date(raw.lastUpdated),
    detailsByCategory,
    latitude:  typeof lat === "number" ? lat : null,
    longitude: typeof lng === "number" ? lng : null,
    ...categoryFields,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Overall-status cell: prominent icon + text.
function OverallStatusCell({ status }: { status: Status }) {
  return (
    <Flex gap={8} alignItems="center">
      <HealthIndicator status={STATUS_TO_INDICATOR[status]} visual="icon" />
      <Text>{capitalize(status)}</Text>
    </Flex>
  );
}

// Per-category cell: subtle shape + tooltip carrying the status.detail (or "Healthy").
function CategoryStatusCell({
  status,
  detail,
}: {
  status: Status | undefined;
  detail: string | undefined;
}) {
  if (!status) return <Text>—</Text>;
  const tooltipText = status === "healthy" ? "Healthy" : detail || capitalize(status);
  return (
    <Tooltip text={tooltipText} placement="top">
      <span style={{ display: "inline-flex" }}>
        <HealthIndicator status={STATUS_TO_INDICATOR[status]} visual="shape" />
      </span>
    </Tooltip>
  );
}

function rebrand(content: string, customerName: string): string {
  if (!customerName || customerName === "Trader Joe's") return content;
  return content.replace(/Trader Joe's/g, customerName);
}

// One "metric" stat card inside the expanded-row insights panel.
function MetricCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <Surface style={{ padding: 12, flex: 1, minWidth: 120 }}>
      <Flex flexDirection="column" gap={4}>
        <Text textStyle="small" style={{ textTransform: "uppercase", letterSpacing: "0.05em", opacity: 0.7 }}>
          {label}
        </Text>
        <Heading level={3} style={{ margin: 0, color }}>{value}</Heading>
      </Flex>
    </Surface>
  );
}

// Convert the DQL timeseries result records to a Strato Timeseries[] shape.
// DQL rows: { timeframe:{start,end}, interval:"<ns>", <field>:[values...] }
// Strato:   { name, datapoints: [{ start: Date, value: number }, ...] }
// Grail returns timestamps with NANOsecond precision (`.000000000Z`), which
// Date.parse() silently returns NaN for. Strip to millisecond precision first.
function parseGrailTimestamp(s: string | undefined): number {
  if (!s) return NaN;
  return Date.parse(s.replace(/(\.\d{3})\d+(Z|[+-]\d\d:?\d\d)?$/, "$1$2"));
}

function toTimeseries(
  records: Array<Record<string, unknown>> | undefined,
  field: string,
  name: string,
  unit?: string,
): Timeseries[] {
  if (!records || records.length === 0) return [];
  return records
    .map<Timeseries | null>((r) => {
      const values = r[field];
      if (!Array.isArray(values) || values.length === 0) return null;
      const tf = r.timeframe as { start?: string; end?: string } | undefined;
      const parsed = parseGrailTimestamp(tf?.start);
      const startMs = Number.isFinite(parsed) ? parsed : Date.now() - values.length * 60_000;
      // DQL interval is nanoseconds as a string; fall back to 5m if missing.
      const intervalNs = typeof r.interval === "string" ? Number(r.interval) : 300_000_000_000;
      const intervalMs = Math.max(1_000, Math.floor(intervalNs / 1_000_000));
      // Include both `start` and `end` — the chart uses them to derive each
      // point's time span. Missing `end` makes area/line variants render as
      // needle columns because it can't infer the bucket width.
      const datapoints = values
        .map((v, i) => ({
          start: new Date(startMs + i * intervalMs),
          end:   new Date(startMs + (i + 1) * intervalMs),
          value: typeof v === "number" ? v : NaN,
        }))
        .filter((d) => !Number.isNaN(d.value));
      if (datapoints.length === 0) return null;
      return { name, datapoints, unit };
    })
    .filter((s): s is Timeseries => s !== null);
}


// Big current value + chart for one metric.
function MetricChartCard({
  label,
  series,
  formatValue,
  color,
  isLoading,
}: {
  label: string;
  series: Timeseries[];
  formatValue: (n: number) => string;
  color?: string;
  isLoading?: boolean;
}) {
  const latest = useMemo(() => {
    const dps = series[0]?.datapoints ?? [];
    for (let i = dps.length - 1; i >= 0; i--) {
      const v = dps[i]?.value;
      if (typeof v === "number" && !Number.isNaN(v)) return v;
    }
    return null;
  }, [series]);

  // Self-diagnostic: any time the panel is expanded, print exactly what the
  // chart received. Makes it obvious in the browser console whether the
  // problem is empty data, malformed shape, or something else entirely.
  if (typeof window !== "undefined") {
    // eslint-disable-next-line no-console
    console.debug("[ops-health] MetricChartCard", label, {
      seriesCount: series.length,
      firstDatapointCount: series[0]?.datapoints?.length ?? 0,
      firstDatapointSample: series[0]?.datapoints?.[0],
      isLoading,
      latest,
    });
  }

  return (
    <Surface style={{ padding: 16, flex: 1, minWidth: 260 }}>
      <Flex flexDirection="column" gap={8}>
        <Flex justifyContent="space-between" alignItems="baseline">
          <Text textStyle="small" style={{ textTransform: "uppercase", letterSpacing: "0.05em", opacity: 0.7 }}>
            {label}
          </Text>
          <Text textStyle="small" style={{ opacity: 0.6 }}>last hour</Text>
        </Flex>
        <Heading level={2} style={{ margin: 0, color }}>
          {isLoading ? "…" : latest !== null ? formatValue(latest) : "—"}
        </Heading>
        <TimeseriesChart
          data={series}
          height={140}
          loading={isLoading}
          curve="smooth"
          // Connect consecutive valid buckets even when the middle ones
          // are null — keeps the chart looking like a continuous signal
          // rather than a scattering of columns.
          gapPolicy="connect"
        >
          {series.map((s, i) => (
            <TimeseriesChart.Area
              key={i}
              data={s}
              color={color ?? "var(--dt-colors-charts-status-ideal-default)"}
            />
          ))}
        </TimeseriesChart>
      </Flex>
    </Surface>
  );
}

// Expandable row content: per-category selector + metrics + logs.
// The user picks a category (network / system / device / pos / printer / portal)
// and everything below narrows to that one signal.
function SiteInsightsPanel({
  siteId,
  siteType,
  categories,
  logs,
  perCategoryStatus,
  detailsByCategory,
  customerName,
  timeframe,
}: {
  siteId: string;
  siteType: SiteType;
  categories: readonly string[];
  logs: SiteLogRow[];
  perCategoryStatus: Record<string, Status | undefined>;
  detailsByCategory: Record<string, string>;
  customerName: string;
  timeframe: TimeframeValue | null;
}) {
  // "all" = every category. Default lands on the worst-status category so the
  // user's eye immediately goes to whatever's actually broken.
  const worstCategory = useMemo<string>(() => {
    let best: string | null = null;
    let bestRank = -1;
    for (const c of categories) {
      const s = perCategoryStatus[c];
      const rank = s ? STATUS_RANK[s] : -1;
      if (rank > bestRank) {
        bestRank = rank;
        best = c;
      }
    }
    return best ?? "all";
  }, [categories, perCategoryStatus]);

  const [selected, setSelected] = useState<string>(worstCategory);
  // Reset when the worst category changes for a different site (row remount).
  useEffect(() => setSelected(worstCategory), [worstCategory]);

  const filteredLogs = useMemo(() => {
    if (selected === "all") return logs;
    return logs.filter((l) => l.category === selected);
  }, [logs, selected]);

  const counts = useMemo(() => {
    const acc = { INFO: 0, WARN: 0, ERROR: 0 };
    for (const l of filteredLogs) {
      const lvl = (l.loglevel || "").toUpperCase();
      if (lvl === "INFO" || lvl === "WARN" || lvl === "ERROR") acc[lvl]++;
    }
    return acc;
  }, [filteredLogs]);

  const selectedStatus: Status | undefined =
    selected === "all" ? undefined : perCategoryStatus[selected];
  const selectedDetail = selected === "all" ? "" : (detailsByCategory[selected] || "");

  // Metrics timeseries for this (site, category). Fires on expansion + category change.
  const metricsQuery = useMemo(
    () => metricsQueryForSite(siteId, selected, timeframe),
    [siteId, selected, timeframe],
  );
  const metricsResult = useDql(metricsQuery, { refetchInterval: 60000 });
  const metricRecords = metricsResult.data?.records as Array<Record<string, unknown>> | undefined;
  // Diagnostic — verify the DQL round-trip landed real records for this expansion.
  if (typeof window !== "undefined") {
    // eslint-disable-next-line no-console
    console.debug("[ops-health] metrics DQL result", {
      siteId,
      selected,
      isLoading: metricsResult.isLoading,
      error: metricsResult.error?.message,
      recordCount: metricRecords?.length ?? 0,
      firstRecord: metricRecords?.[0],
    });
  }
  const responseSeries = useMemo(
    () => toTimeseries(metricRecords, "responseMs", "Response time", "ms"),
    [metricRecords],
  );
  const errorsSeries = useMemo(
    () => toTimeseries(metricRecords, "errors", "Errors per 5m"),
    [metricRecords],
  );

  return (
    <Flex flexDirection="column" gap={16}>
      {/* Category picker — narrows metrics and logs below to that signal. */}
      <Flex gap={12} alignItems="flex-end" flexWrap="wrap">
        <FormField style={{ minWidth: 220 }}>
          <Label>Signal</Label>
          <Select value={selected} onChange={(v: string | null) => v && setSelected(v)}>
            <Select.Content>
              <Select.Option value="all">All signals</Select.Option>
              {categories.map((c) => (
                <Select.Option key={c} value={c}>{capitalize(c)}</Select.Option>
              ))}
            </Select.Content>
          </Select>
        </FormField>
        {selectedStatus && (
          <Flex gap={8} alignItems="center" style={{ marginBottom: 4 }}>
            <HealthIndicator status={STATUS_TO_INDICATOR[selectedStatus]} visual="icon" />
            <Text style={{ fontWeight: 600 }}>{capitalize(selectedStatus)}</Text>
            {selectedDetail && <Text style={{ opacity: 0.8 }}>· {selectedDetail}</Text>}
          </Flex>
        )}
        <Text textStyle="small" style={{ marginLeft: "auto", opacity: 0.6 }}>
          {siteType === "store" || siteType === "warehouse"
            ? `${categories.length} signals monitored`
            : `${categories.length} signal${categories.length === 1 ? "" : "s"} monitored`}
        </Text>
      </Flex>

      {/* Real Grail metrics — response time + errors per 5m. Each card shows the
          most recent value big + a mini area chart of the last hour. Charts use
          the Strato "categorical color 01" blue for a calm, uniform look. */}
      <Flex gap={12} flexWrap="wrap">
        <MetricChartCard
          label="Response time"
          series={responseSeries}
          isLoading={metricsResult.isLoading}
          formatValue={(n) => `${n.toFixed(0)} ms`}
          color={Colors.Charts.Categorical.Color01.Default}
        />
        <MetricChartCard
          label="Errors per 5m"
          series={errorsSeries}
          isLoading={metricsResult.isLoading}
          formatValue={(n) => n.toFixed(0)}
          color={Colors.Charts.Categorical.Color01.Default}
        />
      </Flex>

      {/* Log volume — counts derived from the loaded log stream for this signal. */}
      <Flex gap={12} flexWrap="wrap">
        <MetricCard label="Info logs"  value={counts.INFO} />
        <MetricCard label="Warn logs"  value={counts.WARN}
          color={counts.WARN  > 0 ? "var(--dt-colors-charts-status-warning-default)"  : undefined} />
        <MetricCard label="Error logs" value={counts.ERROR}
          color={counts.ERROR > 0 ? "var(--dt-colors-charts-status-critical-default)" : undefined} />
        <MetricCard label="Total logs" value={filteredLogs.length} />
      </Flex>

      {/* Filtered logs. */}
      <Flex flexDirection="column" gap={8}>
        <Text textStyle="small" style={{ opacity: 0.7 }}>
          {filteredLogs.length === 0
            ? "No logs for this signal in the current timeframe."
            : `Recent logs — most recent first, showing up to 20 of ${filteredLogs.length}`}
        </Text>
        {filteredLogs.length > 0 && (
          <Surface style={{ padding: 12 }}>
            <Flex flexDirection="column" gap={6}>
              {filteredLogs.slice(0, 20).map((log, i) => (
                <Flex key={`${log.timestamp}-${i}`} gap={12} alignItems="baseline">
                  <Text textStyle="small" style={{ opacity: 0.7, minWidth: 168 }}>
                    {new Date(log.timestamp).toLocaleString()}
                  </Text>
                  <LogLevelBadge level={log.loglevel} />
                  <Text style={{ flex: 1 }}>{rebrand(log.content, customerName)}</Text>
                </Flex>
              ))}
            </Flex>
          </Surface>
        )}
      </Flex>
    </Flex>
  );
}

function LogLevelBadge({ level }: { level: string }) {
  const status =
    level === "ERROR" ? "critical" :
    level === "WARN"  ? "warning"  :
    "good";
  return (
    <Flex gap={4} alignItems="center" style={{ minWidth: 80 }}>
      <HealthIndicator status={status} visual="shape" />
      <Text textStyle="small">{level || "LOG"}</Text>
    </Flex>
  );
}

export const CategoryDetail = ({ siteType }: CategoryDetailProps) => {
  const meta = SITE_TYPE_META[siteType];
  const categories = CATEGORIES_BY_SITE_TYPE[siteType];
  const { timeframe } = useTimeframe();
  const { settings } = useSettings();
  const displayLabel = settings.tiles[siteType]?.label || meta.plural;

  const rollupQuery = useMemo(
    () => detailQueryForSiteType(siteType, timeframe),
    [siteType, timeframe],
  );
  const { data, isLoading, error } = useDql(rollupQuery, { refetchInterval: 60000 });

  const logsQuery = useMemo(() => siteLogsQuery(siteType, timeframe), [siteType, timeframe]);
  const logsResult = useDql(logsQuery, { refetchInterval: 60000 });

  const [nameFilter, setNameFilter] = useState("");
  const [regionFilter, setRegionFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<string | null>("all");
  // Marker-click focus: when set, the table narrows to the one site and a "clear
  // focus" pill appears above the table. Independent of the region/status filters
  // so a user can click a marker after filtering without losing the filter set.
  const [focusedSiteId, setFocusedSiteId] = useState<string | null>(null);

  // Accept ?focus=<site.id> from Home's "Sites needing attention" list so the
  // detail view opens already narrowed to that site. Also auto-expand its logs row.
  const [searchParams, setSearchParams] = useSearchParams();
  const focusParam = searchParams.get("focus");
  useEffect(() => {
    if (focusParam && focusParam !== focusedSiteId) {
      setFocusedSiteId(focusParam);
    }
    // Intentionally not clearing the URL param — if the user reloads we want the same focus.
  }, [focusParam, focusedSiteId]);

  // When the user clicks "Show all sites", also drop the URL param so refresh
  // doesn't re-focus.
  const clearFocus = () => {
    setFocusedSiteId(null);
    if (searchParams.has("focus")) {
      const next = new URLSearchParams(searchParams);
      next.delete("focus");
      setSearchParams(next, { replace: true });
    }
  };

  const allRows = useMemo<TableRow[]>(() => {
    if (!data?.records) return [];
    const customer = settings.customerName;
    // Rewrite the ingested "Trader Joe's - City, ST" prefix using the current customer
    // name from settings. Doing it here means every downstream consumer (table, map,
    // tooltip, focus pill) sees the branded name without threading customerName further.
    return (data.records as unknown as SiteDetailRow[]).map((raw) => {
      const row = toTableRow(raw);
      row.siteName = formatSiteName(row.siteName, customer);
      return row;
    });
  }, [data, settings.customerName]);

  const logsBySite = useMemo<Map<string, SiteLogRow[]>>(() => {
    const m = new Map<string, SiteLogRow[]>();
    if (!logsResult.data?.records) return m;
    for (const raw of logsResult.data.records as unknown as SiteLogRow[]) {
      const id = raw["site.id"];
      if (!id) continue;
      const arr = m.get(id) ?? [];
      arr.push(raw);
      m.set(id, arr);
    }
    return m;
  }, [logsResult.data]);

  // Rows that pass the region/status/name filters. Both map and table consume this;
  // the marker-click focus is layered on top for the table only, so the map keeps
  // showing the wider set even when the table is narrowed to one row.
  const filteredRows = useMemo<TableRow[]>(() => {
    const needle = nameFilter.trim().toLowerCase();
    return allRows.filter((r) => {
      if (needle && !r.siteName.toLowerCase().includes(needle)) return false;
      if (regionFilter.length > 0 && !regionFilter.includes(r.siteRegion)) return false;
      if (statusFilter && statusFilter !== "all" && r.siteStatus !== statusFilter) return false;
      return true;
    });
  }, [allRows, nameFilter, regionFilter, statusFilter]);

  const rows = useMemo<TableRow[]>(() => {
    if (!focusedSiteId) return filteredRows;
    const only = filteredRows.filter((r) => r.siteId === focusedSiteId);
    // Focus survives even when the current filter set excludes the site (e.g. user
    // clicks a marker after status-filtering) — surface it anyway rather than
    // silently showing an empty table.
    if (only.length > 0) return only;
    return allRows.filter((r) => r.siteId === focusedSiteId);
  }, [filteredRows, allRows, focusedSiteId]);

  const focusedRow = useMemo<TableRow | null>(() => {
    if (!focusedSiteId) return null;
    return allRows.find((r) => r.siteId === focusedSiteId) ?? null;
  }, [allRows, focusedSiteId]);

  const mapPoints = useMemo<MappableSite[]>(() => {
    return filteredRows
      .filter((r) => r.latitude !== null && r.longitude !== null)
      .map<MappableSite>((r) => ({
        siteId:     r.siteId,
        siteName:   r.siteName,
        siteRegion: r.siteRegion,
        siteStatus: r.siteStatus,
        latitude:   r.latitude as number,
        longitude:  r.longitude as number,
      }));
  }, [filteredRows]);

  const columns = useMemo<DataTableColumnDef<TableRow>[]>(() => {
    const base: DataTableColumnDef<TableRow>[] = [
      {
        id: "siteName",
        header: "Site",
        accessor: "siteName",
        minWidth: 240,
      },
      {
        id: "siteRegion",
        header: "Region",
        accessor: "siteRegion",
        width: 120,
      },
      {
        id: "siteStatus",
        header: "Status",
        accessor: "siteStatus",
        sortAccessor: (row) => row.worstRank,
        width: 140,
        cell: ({ rowData }) => <OverallStatusCell status={rowData.siteStatus} />,
      },
    ];
    const categoryColumns: DataTableColumnDef<TableRow>[] = categories.map((cat: string) => {
      const key: `cat_${string}` = `cat_${cat}`;
      return {
        id: key,
        header: capitalize(cat),
        accessor: key,
        width: 90,
        sortAccessor: (row: TableRow) => {
          const s: Status | undefined = row[key];
          return s ? STATUS_RANK[s] : -1;
        },
        cell: ({ rowData }: { rowData: TableRow }) => (
          <CategoryStatusCell
            status={rowData[key]}
            detail={rowData.detailsByCategory[cat]}
          />
        ),
      };
    });
    const trailing: DataTableColumnDef<TableRow>[] = [
      {
        id: "lastUpdated",
        header: "Last updated",
        accessor: "lastUpdated",
        columnType: "datetime",
        width: 200,
      },
    ];
    return [...base, ...categoryColumns, ...trailing];
  }, [categories]);

  return (
    <Flex flexDirection="column" gap={20} padding={40}>
      <Flex flexDirection="column" gap={4}>
        <Heading level={2}>{displayLabel}</Heading>
        <Paragraph>
          Latest health per site — unhealthy and degraded first. Click any row to see recent logs.
        </Paragraph>
      </Flex>

      {error && (
        <MessageContainer variant="critical">
          <MessageContainer.Title>Couldn&apos;t load {displayLabel.toLowerCase()}</MessageContainer.Title>
          <MessageContainer.Description>
            {error.message ?? "The detail query failed."}
          </MessageContainer.Description>
        </MessageContainer>
      )}

      <SiteMap
        sites={mapPoints}
        focusedSiteId={focusedSiteId}
        onSiteClick={setFocusedSiteId}
      />

      {focusedRow && (
        <Flex
          gap={16}
          alignItems="center"
          padding={16}
          style={{
            background: "var(--dt-colors-background-container-primary-emphasized)",
            borderLeft: "4px solid var(--dt-colors-charts-status-warning-default)",
            borderRadius: 6,
          }}
        >
          <Text style={{ fontSize: 15 }}>
            <strong>Focused on:</strong> {focusedRow.siteName} · {focusedRow.siteRegion} · showing 1 of {allRows.length} sites
          </Text>
          <Button
            variant="emphasized"
            onClick={clearFocus}
            style={{ marginLeft: "auto" }}
          >
            Show all {allRows.length} sites
          </Button>
        </Flex>
      )}

      <Flex gap={16} alignItems="flex-end" flexWrap="wrap">
        <FormField>
          <Label>Search</Label>
          <TextInput
            placeholder={`Filter ${displayLabel.toLowerCase()} by name`}
            value={nameFilter}
            onChange={setNameFilter}
            style={{ minWidth: 260 }}
          />
        </FormField>
        <FormField>
          <Label>Region</Label>
          <Select multiple value={regionFilter} onChange={setRegionFilter}>
            <Select.Trigger placeholder="All regions" />
            <Select.Content>
              {REGIONS.map((r: Region) => (
                <Select.Option key={r} value={r}>{r}</Select.Option>
              ))}
            </Select.Content>
          </Select>
        </FormField>
        <FormField>
          <Label>Status</Label>
          <Select value={statusFilter} onChange={setStatusFilter}>
            <Select.Content>
              <Select.Option value="all">All statuses</Select.Option>
              {STATUSES.map((s) => (
                <Select.Option key={s} value={s}>{capitalize(s)}</Select.Option>
              ))}
            </Select.Content>
          </Select>
        </FormField>
        <Text textStyle="small" style={{ marginLeft: "auto", opacity: 0.7 }}>
          Showing {rows.length} of {allRows.length}
        </Text>
      </Flex>

      <DataTable
        data={rows}
        columns={columns}
        loading={isLoading}
        sortable
        sortBy={[{ id: "siteStatus", desc: true }]}
        rowId={(r) => r.siteId}
        fullWidth
      >
        <DataTable.EmptyState>
          {nameFilter || regionFilter.length > 0 || (statusFilter && statusFilter !== "all")
            ? `No ${displayLabel.toLowerCase()} match the current filters.`
            : `No ${displayLabel.toLowerCase()} reported in this timeframe.`}
        </DataTable.EmptyState>
        <DataTable.ExpandableRow
          // Remount when focus changes so `defaultExpandedRows` picks up the new
          // site — controlled `openSubRows` would work too but this is simpler.
          key={focusedSiteId ?? "none"}
          defaultExpandedRows={focusedSiteId ? { [focusedSiteId]: true } : undefined}
        >
          {({ row }: { row: TableRow }) => {
            // Extract per-category status from the row's flattened cat_* fields.
            const perCategoryStatus: Record<string, Status | undefined> = {};
            for (const c of categories) {
              perCategoryStatus[c] = row[`cat_${c}` as `cat_${string}`];
            }
            return (
              <DataTable.ExpandableRowWrapper>
                <SiteInsightsPanel
                  siteId={row.siteId}
                  siteType={siteType}
                  categories={categories}
                  logs={logsBySite.get(row.siteId) ?? []}
                  perCategoryStatus={perCategoryStatus}
                  detailsByCategory={row.detailsByCategory}
                  customerName={settings.customerName}
                  timeframe={timeframe}
                />
              </DataTable.ExpandableRowWrapper>
            );
          }}
        </DataTable.ExpandableRow>
        <DataTable.Pagination defaultPageSize={15} />
      </DataTable>
    </Flex>
  );
};
