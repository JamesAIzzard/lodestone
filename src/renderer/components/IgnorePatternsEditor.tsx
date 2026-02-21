import { useState } from 'react';
import { X, FolderX, FileX } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

type PatternMode = 'exact' | 'starts-with' | 'includes';

interface IgnorePatternsEditorProps {
  folderPatterns: string[];
  filePatterns: string[];
  onFolderPatternsChange: (patterns: string[]) => void;
  onFilePatternsChange: (patterns: string[]) => void;
  /** Show inheritance controls (for silo-level editor) */
  inherited?: boolean;
  onOverride?: () => void;
  onRevertToDefaults?: () => void;
  isOverridden?: boolean;
}

function encodePattern(value: string, mode: PatternMode): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  switch (mode) {
    case 'exact': return trimmed;
    case 'starts-with': return `${trimmed}*`;
    case 'includes': return `*${trimmed}*`;
  }
}

function decodePattern(pattern: string): { display: string; mode: PatternMode } {
  if (pattern.startsWith('*') && pattern.endsWith('*') && pattern.length > 2) {
    return { display: pattern.slice(1, -1), mode: 'includes' };
  }
  if (pattern.endsWith('*') && !pattern.startsWith('*')) {
    return { display: pattern.slice(0, -1), mode: 'starts-with' };
  }
  return { display: pattern, mode: 'exact' };
}

const modeLabels: Record<PatternMode, string> = {
  'exact': 'matches',
  'starts-with': 'starts with',
  'includes': 'contains',
};

export default function IgnorePatternsEditor({
  folderPatterns,
  filePatterns,
  onFolderPatternsChange,
  onFilePatternsChange,
  inherited,
  onOverride,
  onRevertToDefaults,
  isOverridden,
}: IgnorePatternsEditorProps) {
  const disabled = inherited && !isOverridden;

  return (
    <div className="flex flex-col gap-4">
      {inherited && !isOverridden && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Using default patterns</span>
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

      <PatternSection
        icon={FolderX}
        label="Folders"
        patterns={folderPatterns}
        onChange={onFolderPatternsChange}
        placeholder="e.g. node_modules"
        disabled={disabled}
      />

      <PatternSection
        icon={FileX}
        label="Files"
        patterns={filePatterns}
        onChange={onFilePatternsChange}
        placeholder="e.g. *.log"
        disabled={disabled}
      />
    </div>
  );
}

function PatternSection({
  icon: Icon,
  label,
  patterns,
  onChange,
  placeholder,
  disabled,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  patterns: string[];
  onChange: (patterns: string[]) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<PatternMode>('exact');

  function addPattern() {
    const encoded = encodePattern(input, mode);
    if (!encoded || patterns.includes(encoded)) return;
    onChange([...patterns, encoded]);
    setInput('');
  }

  function removePattern(pattern: string) {
    onChange(patterns.filter((p) => p !== pattern));
  }

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {patterns.map((pattern) => {
          const { display, mode: patMode } = decodePattern(pattern);
          return (
            <Badge key={pattern} variant="secondary" className="gap-1 text-xs">
              <span className="text-muted-foreground/60 text-[10px]">
                {modeLabels[patMode]}
              </span>
              {display}
              {!disabled && (
                <button onClick={() => removePattern(pattern)} className="ml-0.5">
                  <X className="h-2.5 w-2.5" />
                </button>
              )}
            </Badge>
          );
        })}
        {patterns.length === 0 && (
          <span className="text-xs text-muted-foreground/50">None</span>
        )}
      </div>
      {!disabled && (
        <div className="flex gap-1.5">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as PatternMode)}
            className="h-7 rounded-md border border-input bg-background px-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="exact">Matches</option>
            <option value="starts-with">Starts with</option>
            <option value="includes">Contains</option>
          </select>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addPattern()}
            placeholder={placeholder}
            className="h-7 w-28 rounded-md border border-input bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={addPattern}>
            Add
          </Button>
        </div>
      )}
    </div>
  );
}
