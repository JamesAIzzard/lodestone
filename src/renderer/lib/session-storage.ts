// ── Session storage helpers ──────────────────────────────────────────────────

export function readSession<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key);
    return raw !== null ? (JSON.parse(raw) as T) : fallback;
  } catch { return fallback; }
}

export function writeSession<T>(key: string, value: T): void {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}
