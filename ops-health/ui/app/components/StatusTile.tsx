import React from "react";
import { Link as RouterLink } from "react-router-dom";
import { Flex, Surface } from "@dynatrace/strato-components/layouts";
import { Heading, Paragraph, Text } from "@dynatrace/strato-components/typography";
import { HealthIndicator, Skeleton } from "@dynatrace/strato-components/content";
import Colors from "@dynatrace/strato-design-tokens/colors";
import type { Status, HealthIndicatorStatus } from "../schema/siteHealth";
import { STATUS_TO_INDICATOR } from "../schema/siteHealth";

type StatusTileProps = {
  label: string;
  route: string;
  siteStatus?: Status;
  total?: number;
  healthy?: number;
  degraded?: number;
  unhealthy?: number;
  isLoading?: boolean;
  isEmpty?: boolean;
};

const HEADLINE: Record<Status, string> = {
  healthy:   "All clear",
  degraded:  "Attention needed",
  unhealthy: "Action required",
};

// Match the map's palette + Strato HealthIndicator colors.
const STATUS_COLOR: Record<Status, string> = {
  healthy:   Colors.Charts.Status.Ideal.Default,
  degraded:  Colors.Charts.Status.Warning.Default,
  unhealthy: Colors.Charts.Status.Critical.Default,
};

const KPI_LABEL_STYLE = { textTransform: "uppercase" as const, letterSpacing: "0.05em", opacity: 0.7 };

// The big, unmissable status badge in the top-right.
// Strato's HealthIndicator has a fixed icon size; wrapping in a scale() transform
// gives us a much larger footprint without diverging from the design system.
function BigStatusBadge({ status }: { status: HealthIndicatorStatus }) {
  return (
    <div
      style={{
        width: 56,
        height: 56,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transform: "scale(2.4)",
        transformOrigin: "center",
      }}
    >
      <HealthIndicator status={status} visual="icon" />
    </div>
  );
}

export const StatusTile = ({
  label,
  route,
  siteStatus,
  total,
  healthy,
  degraded,
  unhealthy,
  isLoading,
  isEmpty,
}: StatusTileProps) => {
  const indicator: HealthIndicatorStatus = siteStatus
    ? STATUS_TO_INDICATOR[siteStatus]
    : "neutral";

  const numberColor = siteStatus ? STATUS_COLOR[siteStatus] : undefined;

  return (
    <RouterLink to={route} style={{ textDecoration: "none", color: "inherit" }}>
      <Surface
        style={{
          minHeight: 240,
          padding: 32,
          cursor: "pointer",
          // Colored accent bar down the left edge — instant status signal even
          // before the eye reaches the header row.
          borderLeft: siteStatus ? `8px solid ${STATUS_COLOR[siteStatus]}` : undefined,
          position: "relative",
        }}
      >
        <Flex flexDirection="column" gap={20} height="100%">
          <Flex justifyContent="space-between" alignItems="flex-start" gap={16}>
            <Flex flexDirection="column" gap={4} style={{ flex: 1, minWidth: 0 }}>
              <Text textStyle="small" style={KPI_LABEL_STYLE}>{label}</Text>
              <Heading
                level={1}
                style={{
                  fontSize: 56,
                  lineHeight: 1,
                  margin: 0,
                  color: numberColor,
                }}
              >
                {isLoading || total === undefined ? "—" : total}
              </Heading>
            </Flex>
            {siteStatus ? (
              <BigStatusBadge status={indicator} />
            ) : (
              <HealthIndicator status={indicator} visual="icon" />
            )}
          </Flex>

          {isLoading ? (
            <Skeleton width="100%" height={72} />
          ) : isEmpty || total === undefined || siteStatus === undefined ? (
            <Paragraph>No sites reported in this timeframe.</Paragraph>
          ) : (
            <Flex flexDirection="column" gap={16} height="100%">
              <Heading level={4} style={{ margin: 0, color: numberColor }}>
                {HEADLINE[siteStatus]}
              </Heading>
              <Flex gap={24} marginTop="auto">
                <Flex flexDirection="column" gap={4}>
                  <Text textStyle="small" style={KPI_LABEL_STYLE}>Healthy</Text>
                  <Heading level={3} style={{ margin: 0 }}>{healthy ?? 0}</Heading>
                </Flex>
                <Flex flexDirection="column" gap={4}>
                  <Text textStyle="small" style={KPI_LABEL_STYLE}>Degraded</Text>
                  <Heading
                    level={3}
                    style={{ margin: 0, color: (degraded ?? 0) > 0 ? STATUS_COLOR.degraded : undefined }}
                  >
                    {degraded ?? 0}
                  </Heading>
                </Flex>
                <Flex flexDirection="column" gap={4}>
                  <Text textStyle="small" style={KPI_LABEL_STYLE}>Unhealthy</Text>
                  <Heading
                    level={3}
                    style={{ margin: 0, color: (unhealthy ?? 0) > 0 ? STATUS_COLOR.unhealthy : undefined }}
                  >
                    {unhealthy ?? 0}
                  </Heading>
                </Flex>
              </Flex>
            </Flex>
          )}
        </Flex>
      </Surface>
    </RouterLink>
  );
};
