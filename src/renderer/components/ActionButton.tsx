import { cn } from '@/lib/utils';

interface ActionButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: React.ReactNode;
  label?: string;
  collapsed?: boolean;
  title?: string;
}

export default function ActionButton({
  icon,
  label,
  collapsed = false,
  className,
  title,
  ...props
}: ActionButtonProps) {
  const showLabel = !!label && !collapsed;
  return (
    <button
      title={title ?? (collapsed && label ? label : undefined)}
      className={cn(
        'flex items-center transition-colors text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:pointer-events-none',
        showLabel && icon && 'gap-1 text-xs',
        !icon && 'text-xs',
        className,
      )}
      {...props}
    >
      {icon}
      {showLabel && label}
    </button>
  );
}
