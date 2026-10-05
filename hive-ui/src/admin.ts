const BASE = import.meta.env.BASE_URL; // "/hive/"
const KEY_STORE = "hive-admin-key";

export type AdminResult = { ok: true } | { ok: false; error: string; needKey?: boolean };

const isDemo = () => {
  try { return new URLSearchParams(location.search).has("demo"); } catch { return false; }
};
export const savedKey = (): string | null => {
  try { return sessionStorage.getItem(KEY_STORE); } catch { return null; }
};
const rememberKey = (k: string) => {
  try { sessionStorage.setItem(KEY_STORE, k); } catch { /* storage unavailable */ }
};
const forgetKey = () => {
  try { sessionStorage.removeItem(KEY_STORE); } catch { /* storage unavailable */ }
};
const typedName = (): string | undefined => {
  try { return localStorage.getItem("hive-name")?.trim() || undefined; } catch { return undefined; }
};

/** POST /hive/admin. `typedKey` wins; else the remembered key; else the host's pre-filled key (GET /hive/join-info). */
export async function adminAction(action: "boot" | "unboot" | "listen", id: string, typedKey?: string): Promise<AdminResult> {
  if (isDemo()) return { ok: true };
  try {
    let key: string | null = typedKey?.trim() || savedKey();
    if (!key) {
      const r = await fetch(`${BASE}join-info`);
      const j = r.ok ? ((await r.json()) as { key?: string | null }) : null;
      key = j?.key ?? null;
    }
    if (!key) return { ok: false, error: "Enter the Hive key to continue.", needKey: true };
    const res = await fetch(`${BASE}admin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, id, key, by: typedName() }),
    });
    if (res.status === 204 || res.ok) { rememberKey(key); return { ok: true }; }
    const j = (await res.json().catch(() => null)) as { error?: string } | null;
    if (res.status === 401) { forgetKey(); return { ok: false, error: j?.error ?? "That is not the Hive key.", needKey: true }; }
    return { ok: false, error: j?.error ?? `Request failed (${res.status}).` };
  } catch {
    return { ok: false, error: "Could not reach the Hive host." };
  }
}
