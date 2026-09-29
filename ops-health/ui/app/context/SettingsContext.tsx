import React, {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import { useUserAppState, useSetUserAppState } from "@dynatrace-sdk/react-hooks";
import { SITE_TYPES, SITE_TYPE_META, type SiteType } from "../schema/siteHealth";

const SETTINGS_KEY = "ops-health.settings.v1";

export interface TileSetting {
  visible: boolean;
  label:   string;
}

export interface AppSettings {
  customerName: string;
  tiles: Record<SiteType, TileSetting>;
}

export const DEFAULT_SETTINGS: AppSettings = {
  customerName: "Demo Retail",
  tiles: Object.fromEntries(
    SITE_TYPES.map((t) => [t, { visible: true, label: SITE_TYPE_META[t].plural }]),
  ) as Record<SiteType, TileSetting>,
};

// Merge saved settings over defaults so future schema additions never leave a saved
// value in an inconsistent shape (e.g. a new site type gains a default entry).
function withDefaults(saved: Partial<AppSettings> | null | undefined): AppSettings {
  if (!saved) return DEFAULT_SETTINGS;
  const tiles: Record<SiteType, TileSetting> = { ...DEFAULT_SETTINGS.tiles };
  for (const t of SITE_TYPES) {
    const s = saved.tiles?.[t];
    if (s) tiles[t] = { visible: s.visible ?? true, label: s.label ?? DEFAULT_SETTINGS.tiles[t].label };
  }
  return {
    customerName: saved.customerName ?? DEFAULT_SETTINGS.customerName,
    tiles,
  };
}

interface SettingsContextValue {
  settings: AppSettings;
  save:     (next: AppSettings) => Promise<void>;
  isLoading: boolean;
  isSaving:  boolean;
  // Only surfaces genuine save failures. First-load "key not found" is expected
  // (the user hasn't customized yet) and is intentionally NOT reported as an error.
  saveError: Error | undefined;
}

const Ctx = createContext<SettingsContextValue | null>(null);

export const SettingsProvider = ({ children }: PropsWithChildren) => {
  const stateResult = useUserAppState({ key: SETTINGS_KEY });
  const setter = useSetUserAppState();

  // Hold a local copy so the sheet can call save() and the UI updates instantly
  // even before the round-trip write to the state service completes.
  const [local, setLocal] = useState<AppSettings | null>(null);

  useEffect(() => {
    if (stateResult.isLoading) return;
    const raw = stateResult.data?.value;
    if (!raw) {
      setLocal(DEFAULT_SETTINGS);
      return;
    }
    try {
      setLocal(withDefaults(JSON.parse(raw) as Partial<AppSettings>));
    } catch {
      setLocal(DEFAULT_SETTINGS);
    }
  }, [stateResult.data, stateResult.isLoading]);

  const save = useCallback(
    async (next: AppSettings) => {
      setLocal(next);
      await setter.execute({
        key: SETTINGS_KEY,
        body: { value: JSON.stringify(next) },
      });
    },
    [setter],
  );

  const value = useMemo<SettingsContextValue>(
    () => ({
      settings: local ?? DEFAULT_SETTINGS,
      save,
      isLoading: stateResult.isLoading && local === null,
      isSaving:  setter.isLoading,
      saveError: setter.error,
    }),
    [local, save, stateResult.isLoading, setter.isLoading, setter.error],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export function useSettings(): SettingsContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSettings must be used inside <SettingsProvider>");
  return v;
}
