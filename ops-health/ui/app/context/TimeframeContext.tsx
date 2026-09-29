import React, { createContext, useContext, useMemo, useState, type PropsWithChildren } from "react";
import type { TimeframeValue } from "../components/Header";

// Simple app-wide timeframe context. Held at App shell level so both the Home
// tiles and any detail page see the same value, and switching pages doesn't
// reset it.
interface TimeframeContextValue {
  timeframe: TimeframeValue | null;
  setTimeframe: (tf: TimeframeValue | null) => void;
}

const Ctx = createContext<TimeframeContextValue | null>(null);

const DEFAULT_TIMEFRAME: TimeframeValue = { from: "now()-1h", to: "now()" };

export const TimeframeProvider = ({ children }: PropsWithChildren) => {
  const [timeframe, setTimeframe] = useState<TimeframeValue | null>(DEFAULT_TIMEFRAME);
  const value = useMemo(() => ({ timeframe, setTimeframe }), [timeframe]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export function useTimeframe(): TimeframeContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTimeframe must be used inside <TimeframeProvider>");
  return v;
}

// Normalize whatever Strato hands us — "now", "now-1h", "now()-1h", etc. —
// into DQL syntax which requires the parens form ("now()", "now()-1h").
// Absolute ISO strings pass through unchanged and get quoted at the call site.
export function toDql(expr: string): string {
  const t = expr.trim();
  if (/^now(\(\))?$/i.test(t)) return "now()";
  const m = /^now(?:\(\))?-(\d+)([smhdw])$/i.exec(t);
  if (m) return `now()-${m[1]}${m[2].toLowerCase()}`;
  // Assume ISO / RFC3339 — quote it for DQL.
  return `"${t}"`;
}
