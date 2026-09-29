import React, { useEffect, useState } from "react";
import { Sheet } from "@dynatrace/strato-components/overlays";
import { Button } from "@dynatrace/strato-components/buttons";
import { Flex } from "@dynatrace/strato-components/layouts";
import { Heading, Paragraph, Text } from "@dynatrace/strato-components/typography";
import { MessageContainer } from "@dynatrace/strato-components/content";
import { FormField, Label, Switch, TextInput } from "@dynatrace/strato-components/forms";
import { SITE_TYPES, SITE_TYPE_META, type SiteType } from "../schema/siteHealth";
import { DEFAULT_SETTINGS, useSettings, type AppSettings, type TileSetting } from "../context/SettingsContext";

interface SettingsSheetProps {
  show: boolean;
  onDismiss: () => void;
}

export const SettingsSheet = ({ show, onDismiss }: SettingsSheetProps) => {
  const { settings, save, isSaving, saveError } = useSettings();

  // Draft mirrors the saved settings until the user clicks Save. Reset when the
  // sheet opens so a discard doesn't leak into the next session.
  const [draft, setDraft] = useState<AppSettings>(settings);
  useEffect(() => {
    if (show) setDraft(settings);
  }, [show, settings]);

  const updateTile = (t: SiteType, patch: Partial<TileSetting>) =>
    setDraft((d) => ({ ...d, tiles: { ...d.tiles, [t]: { ...d.tiles[t], ...patch } } }));

  const handleSave = () => {
    void save(draft).then(onDismiss);
  };

  const resetDefaults = () => setDraft(DEFAULT_SETTINGS);

  return (
    <Sheet
      title="Ops Health settings"
      show={show}
      onDismiss={onDismiss}
      actions={
        <Flex gap={8}>
          <Button variant="default" onClick={onDismiss}>Cancel</Button>
          <Button variant="emphasized" onClick={handleSave} loading={isSaving}>
            Save
          </Button>
        </Flex>
      }
    >
      <Flex flexDirection="column" gap={24} padding={4}>
        <Paragraph>
          These settings are stored per user. Each teammate can brand the demo for the customer they&apos;re in front of.
        </Paragraph>

        {saveError && (
          <MessageContainer variant="critical">
            <MessageContainer.Title>Couldn&apos;t save settings</MessageContainer.Title>
            <MessageContainer.Description>{saveError.message}</MessageContainer.Description>
          </MessageContainer>
        )}

        <Flex flexDirection="column" gap={12}>
          <Heading level={5}>Customer</Heading>
          <FormField>
            <Label>Customer name</Label>
            <TextInput
              placeholder="e.g. Trader Joe's"
              value={draft.customerName}
              onChange={(v) => setDraft((d) => ({ ...d, customerName: v }))}
            />
          </FormField>
        </Flex>

        <Flex flexDirection="column" gap={12}>
          <Heading level={5}>Tiles</Heading>
          <Text textStyle="small">Toggle which tiles appear on the overview and rename each for the customer&apos;s vocabulary.</Text>
          {SITE_TYPES.map((t: SiteType) => {
            const tile = draft.tiles[t];
            return (
              <Flex key={t} gap={12} alignItems="center">
                <Switch
                  value={tile.visible}
                  onChange={(v) => updateTile(t, { visible: Boolean(v) })}
                />
                <Text style={{ minWidth: 96, opacity: 0.7 }}>{SITE_TYPE_META[t].plural}</Text>
                <FormField style={{ flex: 1 }}>
                  <TextInput
                    value={tile.label}
                    onChange={(v) => updateTile(t, { label: v })}
                    placeholder={SITE_TYPE_META[t].plural}
                  />
                </FormField>
              </Flex>
            );
          })}
        </Flex>

        <Flex justifyContent="flex-start">
          <Button variant="default" onClick={resetDefaults}>Reset to defaults</Button>
        </Flex>
      </Flex>
    </Sheet>
  );
};
