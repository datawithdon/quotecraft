// localStorage wrapper. Storage can be unavailable (private mode, blocked
// site data) or full, so every access is guarded and the app keeps working
// in memory if it fails.

const PREFIX = "quotecraft.";
export const KEYS = { settings: "settings", rates: "rates", quotes: "quotes", draft: "draft" };

export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function remove(key) {
  try { localStorage.removeItem(PREFIX + key); } catch { /* ignore */ }
}

export function wipe() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k);
  } catch { /* ignore */ }
}
