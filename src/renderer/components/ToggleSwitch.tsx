import { cn } from '@/lib/utils';

export default function ToggleSwitch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none group"
    >
      <span
        className={cn(
          'relative inline-flex h-3.5 w-6 shrink-0 rounded-full border transition-colors',
          checked ? 'bg-foreground/80 border-foreground/80' : 'bg-muted border-border',
        )}
      >
        <span
          className={cn(
            'absolute top-px h-2.5 w-2.5 rounded-full bg-background shadow-sm transition-transform',
            checked ? 'translate-x-[10px]' : 'translate-x-px',
          )}
        />
      </span>
      <span className={cn('transition-colors', checked ? 'text-foreground' : 'text-muted-foreground')}>
        {label}
      </span>
    </button>
  );
}
