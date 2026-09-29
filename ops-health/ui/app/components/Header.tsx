import React, { useState } from "react";
import { Link } from "react-router-dom";
import { AppHeader } from "@dynatrace/strato-components/layouts";
import { TimeframeSelector } from "@dynatrace/strato-components/filters";
import { Button } from "@dynatrace/strato-components/buttons";
import { Tooltip } from "@dynatrace/strato-components/overlays";
import { SettingIcon } from "@dynatrace/strato-icons";
import { SITE_TYPES, SITE_TYPE_META } from "../schema/siteHealth";
import { useTimeframe } from "../context/TimeframeContext";
import { useSettings } from "../context/SettingsContext";
import { SettingsSheet } from "./SettingsSheet";

// Kept as a plain { from, to } string pair so state is trivially serializable and
// so query-builders can interpolate the values straight into DQL.
export interface TimeframeValue {
  from: string;
  to: string;
}

export const Header = () => {
  const { timeframe, setTimeframe } = useTimeframe();
  const { settings } = useSettings();
  const [showSettings, setShowSettings] = useState(false);

  return (
    <>
      <AppHeader>
        <AppHeader.Navigation>
          <AppHeader.Logo as={Link} to="/" />
          {SITE_TYPES.map((siteType) => {
            const tile = settings.tiles[siteType];
            if (!tile.visible) return null;
            return (
              <AppHeader.NavigationItem key={siteType} as={Link} to={SITE_TYPE_META[siteType].route}>
                {tile.label}
              </AppHeader.NavigationItem>
            );
          })}
        </AppHeader.Navigation>
        <AppHeader.ActionItems>
          <Tooltip text="Settings" placement="bottom">
            <Button
              variant="default"
              onClick={() => setShowSettings(true)}
              aria-label="Open settings"
            >
              <Button.Prefix><SettingIcon /></Button.Prefix>
            </Button>
          </Tooltip>
          <TimeframeSelector
            value={timeframe}
            onChange={(tf) => {
              if (!tf) {
                setTimeframe(null);
                return;
              }
              setTimeframe({ from: tf.from.value, to: tf.to.value });
            }}
          />
        </AppHeader.ActionItems>
      </AppHeader>
      <SettingsSheet show={showSettings} onDismiss={() => setShowSettings(false)} />
    </>
  );
};
