import { cn } from '@/lib/utils';

export interface FilterOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
}

interface FilterBarProps {
  options: FilterOption[];
  isActive: (value: string) => boolean;
  onSelect: (value: string) => void;
  className?: string;
}

export default function FilterBar({
  options,
  isActive,
  onSelect,
  className,
}: FilterBarProps) {

  return (
    <div className={cn('inline-flex h-9 rounded-md border border-input overflow-hidden', className)}>
      {options.map((opt, i) => (
        <button
          key={opt.value}
          onClick={() => onSelect(opt.value)}
          className={cn(
            'flex h-full items-center transition-colors',
            opt.icon && 'gap-1.5',
            'px-3 text-xs',
            i > 0 && 'border-l border-input',
            isActive(opt.value)
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground hover:bg-accent/30',
          )}
        >
          {opt.icon}
          {opt.label}
        </button>
      ))}
    </div>
  );
}
