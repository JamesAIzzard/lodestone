/**
 * SiloAppearancePicker — colour dot grid + icon grid.
 *
 * Reusable in both AddSiloModal (Name step) and SiloDetailModal (Appearance row).
 * Selecting a colour tints the icon buttons with that colour.
 */

import { cn } from '@/lib/utils';
import {
  SILO_COLORS,
  SILO_COLOR_MAP,
  SILO_ICON_NAMES,
  type SiloColor,
  type SiloIconName,
} from '../../shared/silo-appearance';
import SiloIcon from './SiloIconComponent';

interface SiloAppearancePickerProps {
  color: SiloColor;
  icon: SiloIconName;
  onColorChange: (color: SiloColor) => void;
  onIconChange: (icon: SiloIconName) => void;
}

export default function SiloAppearancePicker({
  color,
  icon,
  onColorChange,
  onIconChange,
}: SiloAppearancePickerProps) {
  const colorClasses = SILO_COLOR_MAP[color];

  return (
    <div className="flex flex-col gap-3">
      {/* Colour dots */}
      <div>
        <span className="mb-1.5 block text-[11px] text-muted-foreground/60">Colour</span>
        <div className="flex flex-wrap gap-1.5">
          {SILO_COLORS.map((c) => {
            const classes = SILO_COLOR_MAP[c];
            const selected = c === color;
            return (
              <button
                key={c}
                type="button"
                onClick={() => onColorChange(c)}
                className={cn(
                  'h-6 w-6 rounded-full transition-all',
                  classes.dot,
                  selected
                    ? 'ring-2 ring-offset-2 ring-offset-background ring-foreground/60 scale-110'
                    : 'opacity-60 hover:opacity-100 hover:scale-105',
                )}
                title={c}
              />
            );
          })}
        </div>
      </div>

      {/* Icon grid */}
      <div>
        <span className="mb-1.5 block text-[11px] text-muted-foreground/60">Icon</span>
        <div className="flex flex-wrap gap-1">
          {SILO_ICON_NAMES.map((ic) => {
            const selected = ic === icon;
            return (
              <button
                key={ic}
                type="button"
                onClick={() => onIconChange(ic)}
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-md border transition-all',
                  selected
                    ? `${colorClasses.bgSoft} ${colorClasses.border} ${colorClasses.text}`
                    : 'border-transparent text-muted-foreground/40 hover:text-muted-foreground hover:bg-accent/30',
                )}
                title={ic}
              >
                <SiloIcon icon={ic} className="h-4 w-4" />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
