import { useRef, useState } from 'react';
import { useClickOutside } from '@/hooks/use-click-outside';
import { cn } from '@/lib/utils';

export function InlineDropdown<T extends string | number>({
  options,
  onSelect,
  onClose,
}: {
  options: {
    value: T;
    label: string;
    className?: string;
    icon?: React.ReactNode;
    divider?: boolean;
    keepOpen?: boolean;
  }[];
  onSelect: (value: T) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, onClose);

  return (
    <div
      ref={ref}
      className="absolute left-0 top-full mt-0.5 z-50 min-w-[110px] rounded-md border border-border bg-background shadow-md py-1"
    >
      {options.map((opt, i) => (
        <div key={i}>
          {opt.divider && <div className="my-1 border-t border-border/50" />}
          <button
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(opt.value);
              if (!opt.keepOpen) onClose();
            }}
            className={cn(
              'flex items-center gap-2 w-full px-3 py-1.5 text-left text-xs hover:bg-accent transition-colors',
              opt.className ?? 'text-foreground',
            )}
          >
            {opt.icon}
            {opt.label}
          </button>
        </div>
      ))}
    </div>
  );
}

export function CellDropdown({
  trigger,
  children,
  containerClassName,
}: {
  trigger: (toggle: () => void) => React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  containerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const toggle = () => setOpen((o) => !o);

  return (
    <div className={cn('relative shrink-0', containerClassName)}>
      {trigger(toggle)}
      {open && children(close)}
    </div>
  );
}
