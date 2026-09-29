import React, { useMemo } from "react";
import { MapView, BubbleLayer, CategoricalLegend } from "@dynatrace/strato-geo";
import Colors from "@dynatrace/strato-design-tokens/colors";
import { Flex, Surface } from "@dynatrace/strato-components/layouts";
import { Text } from "@dynatrace/strato-components/typography";
import { Button } from "@dynatrace/strato-components/buttons";
import type { Status } from "../schema/siteHealth";

export interface MappableSite {
  siteId: string;
  siteName: string;
  siteRegion: string;
  siteStatus: Status;
  latitude: number;
  longitude: number;
}

interface SiteMapProps {
  sites: MappableSite[];
  focusedSiteId?: string | null;
  onSiteClick?: (siteId: string) => void;
  height?: number;
}

// Categorical legend palette keyed on our own status vocabulary.
// Matches the HealthIndicator status→color mapping used everywhere else in the app.
const STATUS_PALETTE: Record<Status, string> = {
  healthy:   Colors.Charts.Status.Ideal.Default,
  degraded:  Colors.Charts.Status.Warning.Default,
  unhealthy: Colors.Charts.Status.Critical.Default,
};

const LEGEND_LABELS: Record<Status, string> = {
  healthy:   "Healthy",
  degraded:  "Degraded",
  unhealthy: "Unhealthy",
};

// The BubbleLayer's `color="legend"` mode expects a palette keyed on the value
// accessor's raw strings. Human-friendly display labels are separate.
const LEGEND_PALETTE: Record<string, string> = Object.fromEntries(
  (Object.keys(STATUS_PALETTE) as Status[]).map((s) => [LEGEND_LABELS[s], STATUS_PALETTE[s]]),
);

type MapPoint = MappableSite & {
  statusLabel: string;
  magnitude: number;
  focused: boolean;
};

export const SiteMap = ({ sites, focusedSiteId, onSiteClick, height = 320 }: SiteMapProps) => {
  // Normalize the data with a displayable status label so both the color-by-legend
  // wiring and the tooltip pull from the same field.
  const points = useMemo<MapPoint[]>(() => {
    return sites
      .filter((s) => Number.isFinite(s.latitude) && Number.isFinite(s.longitude))
      .map<MapPoint>((s) => ({
        ...s,
        statusLabel: LEGEND_LABELS[s.siteStatus],
        // Unhealthy sites should visually pop; degraded slightly larger than healthy.
        magnitude: s.siteStatus === "unhealthy" ? 3 : s.siteStatus === "degraded" ? 2 : 1,
        focused: focusedSiteId ? s.siteId === focusedSiteId : false,
      }));
  }, [sites, focusedSiteId]);

  if (points.length === 0) {
    return (
      <Surface style={{ padding: 16, height }}>
        <Flex flexDirection="column" gap={4}>
          <Text>No mappable sites in this timeframe.</Text>
          <Text textStyle="small" style={{ opacity: 0.6 }}>
            Widen the timeframe, or wait for the next workflow run.
          </Text>
        </Flex>
      </Surface>
    );
  }

  return (
    <MapView height={height}>
      <BubbleLayer<MapPoint>
        data={points}
        color="legend"
        valueAccessor="statusLabel"
        radius={(item) => item.magnitude * 6 + (item.focused ? 8 : 0)}
        radiusRange={[6, 18]}
      >
        <BubbleLayer.Tooltip>
          {(closest) => {
            // BubbleLayerTooltipHandler always types data as Location, not the generic T.
            // Safe to widen here — we're the only source of items in this layer.
            const item = closest.data as unknown as MapPoint;
            return (
              <Flex flexDirection="column" gap={6} padding={8}>
                <Text style={{ fontWeight: 600 }}>{item.siteName}</Text>
                <Text textStyle="small" style={{ opacity: 0.8 }}>
                  {item.siteRegion} · {LEGEND_LABELS[item.siteStatus]}
                </Text>
                {onSiteClick && (
                  <Button
                    variant="default"
                    onClick={() => onSiteClick(item.siteId)}
                  >
                    Focus this site
                  </Button>
                )}
              </Flex>
            );
          }}
        </BubbleLayer.Tooltip>
      </BubbleLayer>
      <CategoricalLegend colorPalette={LEGEND_PALETTE} />
    </MapView>
  );
};
