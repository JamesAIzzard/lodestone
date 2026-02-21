import { useState } from 'react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';

const COMMON_EXTENSIONS = ['.md', '.txt', '.py', '.ts', '.js', '.toml', '.yaml', '.json', '.pdf', '.rs', '.go', '.java'];

interface ExtensionPickerProps {
  extensions: string[];
  onChange: (extensions: string[]) => void;
  /** Show inheritance controls (for silo-level editor) */
  inherited?: boolean;
  isOverridden?: boolean;
  onOverride?: () => void;
  onRevertToDefaults?: () => void;
}

export default function ExtensionPicker({
  extensions,
  onChange,
  inherited,
  isOverridden,
  onOverride,
  onRevertToDefaults,
}: ExtensionPickerProps) {
  const [customInput, setCustomInput] = useState('');
  const disabled = inherited && !isOverridden;

  function toggleExtension(ext: string) {
    if (disabled) return;
    if (extensions.includes(ext)) {
      onChange(extensions.filter((e) => e !== ext));
    } else {
      onChange([...extensions, ext]);
    }
  }

  function addCustom() {
    const val = customInput.trim();
    if (!val) return;
    const ext = val.startsWith('.') ? val : `.${val}`;
    if (!extensions.includes(ext)) {
      onChange([...extensions, ext]);
    }
    setCustomInput('');
  }

  return (
    <div className="flex flex-col gap-2">
      {inherited && !isOverridden && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Using default extensions</span>
          {onOverride && (
            <button
              onClick={onOverride}
              className="text-[10px] text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
            >
              Customize
            </button>
          )}
        </div>
      )}

      {isOverridden && onRevertToDefaults && (
        <div className="flex items-center gap-2 text-xs">
          <Badge variant="outline" className="text-[10px] text-amber-400 border-amber-500/30">
            override
          </Badge>
          <button
            onClick={onRevertToDefaults}
            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          >
            Reset to defaults
          </button>
        </div>
      )}

      {/* Toggle chips for common extensions */}
      {!disabled && (
        <div className="flex flex-wrap gap-1.5">
          {COMMON_EXTENSIONS.map((ext) => (
            <button
              key={ext}
              onClick={() => toggleExtension(ext)}
              className={cn(
                'rounded-md border px-2 py-0.5 text-[11px] transition-colors',
                extensions.includes(ext)
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border text-muted-foreground/60 hover:border-foreground/20',
              )}
            >
              {ext}
            </button>
          ))}
        </div>
      )}

      {/* Custom extension input */}
      {!disabled && (
        <div className="flex gap-1.5">
          <input
            type="text"
            value={customInput}
            onChange={(e) => setCustomInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addCustom()}
            placeholder=".ext"
            className="h-7 w-20 rounded-md border border-input bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={addCustom}>
            Add
          </Button>
        </div>
      )}
    </div>
  );
}
