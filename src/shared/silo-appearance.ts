/**
 * Silo appearance constants — colour palette and icon set.
 *
 * Shared between backend and renderer. Does not import React or Electron.
 * Colour names are stored in TOML config; the class map provides Tailwind
 * classes for rendering. Icon names map to lucide-react component names.
 */

// ── Colour Palette ──────────────────────────────────────────────────────────

export const SILO_COLORS = [
  'slate', 'red', 'orange', 'amber', 'emerald',
  'teal', 'cyan', 'blue', 'indigo', 'violet', 'purple', 'rose', 'pink',
] as const;

export type SiloColor = (typeof SILO_COLORS)[number];

/**
 * Tailwind class mappings for each palette colour.
 * All classes are full string literals so Tailwind's JIT scanner finds them.
 */
export const SILO_COLOR_MAP: Record<SiloColor, {
  dot: string;
  bgSoft: string;
  text: string;
  border: string;
  cardAccent: string;
}> = {
  slate:   { dot: 'bg-slate-500',   bgSoft: 'bg-slate-500/15',   text: 'text-slate-400',   border: 'border-slate-500/40',   cardAccent: 'border-l-slate-500' },
  red:     { dot: 'bg-red-500',     bgSoft: 'bg-red-500/15',     text: 'text-red-400',     border: 'border-red-500/40',     cardAccent: 'border-l-red-500' },
  orange:  { dot: 'bg-orange-500',  bgSoft: 'bg-orange-500/15',  text: 'text-orange-400',  border: 'border-orange-500/40',  cardAccent: 'border-l-orange-500' },
  amber:   { dot: 'bg-amber-500',   bgSoft: 'bg-amber-500/15',   text: 'text-amber-400',   border: 'border-amber-500/40',   cardAccent: 'border-l-amber-500' },
  emerald: { dot: 'bg-emerald-500', bgSoft: 'bg-emerald-500/15', text: 'text-emerald-400', border: 'border-emerald-500/40', cardAccent: 'border-l-emerald-500' },
  teal:    { dot: 'bg-teal-500',    bgSoft: 'bg-teal-500/15',    text: 'text-teal-400',    border: 'border-teal-500/40',    cardAccent: 'border-l-teal-500' },
  cyan:    { dot: 'bg-cyan-500',    bgSoft: 'bg-cyan-500/15',    text: 'text-cyan-400',    border: 'border-cyan-500/40',    cardAccent: 'border-l-cyan-500' },
  blue:    { dot: 'bg-blue-500',    bgSoft: 'bg-blue-500/15',    text: 'text-blue-400',    border: 'border-blue-500/40',    cardAccent: 'border-l-blue-500' },
  indigo:  { dot: 'bg-indigo-500',  bgSoft: 'bg-indigo-500/15',  text: 'text-indigo-400',  border: 'border-indigo-500/40',  cardAccent: 'border-l-indigo-500' },
  violet:  { dot: 'bg-violet-500',  bgSoft: 'bg-violet-500/15',  text: 'text-violet-400',  border: 'border-violet-500/40',  cardAccent: 'border-l-violet-500' },
  purple:  { dot: 'bg-purple-500',  bgSoft: 'bg-purple-500/15',  text: 'text-purple-400',  border: 'border-purple-500/40',  cardAccent: 'border-l-purple-500' },
  rose:    { dot: 'bg-rose-500',    bgSoft: 'bg-rose-500/15',    text: 'text-rose-400',    border: 'border-rose-500/40',    cardAccent: 'border-l-rose-500' },
  pink:    { dot: 'bg-pink-500',    bgSoft: 'bg-pink-500/15',    text: 'text-pink-400',    border: 'border-pink-500/40',    cardAccent: 'border-l-pink-500' },
};

export const DEFAULT_SILO_COLOR: SiloColor = 'blue';

/**
 * Auto-assign a colour based on existing silo count.
 * Cycles through the palette skipping slate (too neutral for auto-assignment).
 */
export function autoAssignColor(existingSiloCount: number): SiloColor {
  const assignable = SILO_COLORS.filter((c) => c !== 'slate');
  return assignable[existingSiloCount % assignable.length];
}

// ── Icon Set ────────────────────────────────────────────────────────────────

export const SILO_ICON_NAMES = [
  'file-text', 'code', 'book-open', 'database', 'folder',
  'globe', 'lightbulb', 'brain', 'library', 'beaker',
  'graduation-cap', 'music', 'camera', 'pen', 'archive', 'briefcase',
] as const;

export type SiloIconName = (typeof SILO_ICON_NAMES)[number];

export const DEFAULT_SILO_ICON: SiloIconName = 'database';

// ── Validation ──────────────────────────────────────────────────────────────

/** Validate a colour string, returning the default if invalid. */
export function validateSiloColor(value: string | undefined): SiloColor {
  if (value && (SILO_COLORS as readonly string[]).includes(value)) return value as SiloColor;
  return DEFAULT_SILO_COLOR;
}

/** Validate an icon name string, returning the default if invalid. */
export function validateSiloIcon(value: string | undefined): SiloIconName {
  if (value && (SILO_ICON_NAMES as readonly string[]).includes(value)) return value as SiloIconName;
  return DEFAULT_SILO_ICON;
}
