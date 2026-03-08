// ── Shared formatting utilities ──────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatTime(isoString: string | null): string {
  if (!isoString) return '\u2014';
  return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatTimeWithSeconds(isoString: string): string {
  return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function abbreviatePath(p: string): string {
  return p
    .replace(/^[A-Z]:\\Users\\[^\\]+/, '~')
    .replace(/^\/home\/[^/]+/, '~');
}

export function fileName(p: string): string {
  return p.split(/[/\\]/).pop() ?? p;
}

export function dirPath(p: string): string {
  const parts = p.split(/[/\\]/);
  parts.pop();
  return parts.join('/');
}

export function toSlug(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
}

export function toModelSlug(model: string): string {
  return model.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
}

export function modelIdFromDisplay(display: string): string {
  return display.split(' \u2014 ')[0].trim();
}

export function scorePercent(score: number): string {
  return `${Math.round(score * 100)}%`;
}
