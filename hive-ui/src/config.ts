/** Display preferences for the Hive screen, kept in this browser (localStorage). Nothing here changes the host. */
export type ServiceOrb = "spark" | "strato" | "chorus";
export const SERVICE_ORBS: readonly ServiceOrb[] = ["spark", "strato", "chorus"];

export type HiveConfig = {
  serviceOrb: ServiceOrb;            // which Rebar orb style services wear (agents always have illustrated avatars, services always orbs)
  orb: "auto" | "css";               // the orb is the real shader where WebGL allows, or the plain CSS look-alike
  cols: number;                      // the most tiles in a row
  rows: number;                      // rows per page (page size = cols x rows)
  filterMode: "hide" | "dim";        // what a status filter does to tiles that do not match
  theme: "system" | "light" | "dark";
  drawer: boolean;                   // open the Buzz drawer when the page loads
  name: string;                      // who you are in the chat
};

export const DEFAULT_CONFIG: HiveConfig = { serviceOrb: "spark", orb: "auto", cols: 5, rows: 4, filterMode: "hide", theme: "system", drawer: true, name: "" };

const KEY = "hive-config";
const NAME_KEY = "hive-name"; // the chat box has always kept the name here

const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d);
const int = (v: unknown, lo: number, hi: number, d: number) => (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : d);

/** Whatever was saved, cleaned: anything missing or invalid falls back to the default. */
export function sanitize(raw: unknown): HiveConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    serviceOrb: pick(r.serviceOrb, SERVICE_ORBS, DEFAULT_CONFIG.serviceOrb),
    orb: pick(r.orb, ["auto", "css"], DEFAULT_CONFIG.orb),
    cols: int(r.cols, 2, 8, DEFAULT_CONFIG.cols),
    rows: int(r.rows, 2, 8, DEFAULT_CONFIG.rows),
    filterMode: pick(r.filterMode, ["hide", "dim"], DEFAULT_CONFIG.filterMode),
    theme: pick(r.theme, ["system", "light", "dark"], DEFAULT_CONFIG.theme),
    drawer: typeof r.drawer === "boolean" ? r.drawer : DEFAULT_CONFIG.drawer,
    name: typeof r.name === "string" ? r.name.slice(0, 24) : DEFAULT_CONFIG.name,
  };
}

export function readConfig(): HiveConfig {
  try {
    const saved = sanitize(JSON.parse(localStorage.getItem(KEY) ?? "{}"));
    return { ...saved, name: localStorage.getItem(NAME_KEY) ?? saved.name };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function writeConfig(cfg: HiveConfig) {
  try {
    localStorage.setItem(KEY, JSON.stringify(cfg));
    localStorage.setItem(NAME_KEY, cfg.name);
  } catch {
    /* private mode: preferences just are not remembered */
  }
}

/** The address-bar knobs still win over what was saved, so a tuning link always shows what it says (?serviceOrb=strato&cols=4 ...). */
export function withQuery(cfg: HiveConfig, q: URLSearchParams): HiveConfig {
  const n = (k: string) => (q.get(k) ? Number(q.get(k)) : undefined);
  return sanitize({
    ...cfg,
    ...(q.get("serviceOrb") ? { serviceOrb: q.get("serviceOrb") } : {}),
    ...(q.get("orb") ? { orb: q.get("orb") } : {}),
    ...(n("cols") ? { cols: n("cols") } : {}),
    ...(n("rows") ? { rows: n("rows") } : {}),
    ...(q.get("mode") ? { filterMode: q.get("mode") } : {}),
    ...(q.get("theme") ? { theme: q.get("theme") } : {}),
  });
}
