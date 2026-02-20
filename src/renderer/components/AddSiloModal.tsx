import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './ui/dialog';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { FolderOpen, Plus, X } from 'lucide-react';
import { cn } from '@/lib/utils';

const STEPS = ['Name', 'Directories', 'Extensions', 'Storage', 'Model'] as const;
type Step = (typeof STEPS)[number];

const COMMON_EXTENSIONS = ['.md', '.py', '.ts', '.js', '.toml', '.yaml', '.json', '.pdf'];

interface AddSiloModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function AddSiloModal({ open, onOpenChange }: AddSiloModalProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [name, setName] = useState('');
  const [directories, setDirectories] = useState<string[]>([]);
  const [extensions, setExtensions] = useState<string[]>(['.md', '.py']);
  const [dbPath, setDbPath] = useState('');
  const [model, setModel] = useState('built-in');
  const [availableModels, setAvailableModels] = useState<string[]>(['built-in (all-MiniLM-L6-v2)']);

  const step = STEPS[stepIndex];
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === STEPS.length - 1;

  // Fetch available models on mount
  useEffect(() => {
    window.electronAPI?.getServerStatus().then((status) => {
      if (status.availableModels.length > 0) {
        setAvailableModels(status.availableModels);
      }
      setModel(status.defaultModel);
    });
  }, []);

  // Auto-generate db_path when name changes
  useEffect(() => {
    if (name.trim()) {
      const slug = name.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
      setDbPath(`silos/${slug}.db`);
    }
  }, [name]);

  function reset() {
    setStepIndex(0);
    setName('');
    setDirectories([]);
    setExtensions(['.md', '.py']);
    setDbPath('');
    setModel('built-in');
  }

  function handleClose(open: boolean) {
    if (!open) reset();
    onOpenChange(open);
  }

  function canAdvance(): boolean {
    switch (step) {
      case 'Name':
        return name.trim().length > 0;
      case 'Directories':
        return directories.length > 0;
      case 'Extensions':
        return extensions.length > 0;
      case 'Storage':
        return dbPath.trim().length > 0;
      case 'Model':
        return true;
    }
  }

  function handleNext() {
    if (isLast) {
      // Would create the silo in later phases
      alert(`Silo "${name}" created (mock)\ndb_path: ${dbPath}`);
      handleClose(false);
    } else {
      setStepIndex((i) => i + 1);
    }
  }

  async function handleBrowse() {
    const paths = await window.electronAPI?.selectDirectories();
    if (paths && paths.length > 0) {
      setDirectories((prev) => [...new Set([...prev, ...paths])]);
    }
  }

  function removeDirectory(dir: string) {
    setDirectories((prev) => prev.filter((d) => d !== dir));
  }

  function toggleExtension(ext: string) {
    setExtensions((prev) =>
      prev.includes(ext) ? prev.filter((e) => e !== ext) : [...prev, ext],
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Silo</DialogTitle>
          <DialogDescription>
            Step {stepIndex + 1} of {STEPS.length}: {step}
          </DialogDescription>
        </DialogHeader>

        {/* Step indicator */}
        <div className="mt-2 flex gap-1">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={cn(
                'h-1 flex-1 rounded-full',
                i <= stepIndex ? 'bg-primary' : 'bg-muted',
              )}
            />
          ))}
        </div>

        {/* Step content */}
        <div className="mt-4 min-h-[140px]">
          {step === 'Name' && (
            <div>
              <label className="mb-2 block text-sm text-muted-foreground">
                Give your silo a name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. personal-kb, my-project"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring"
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && canAdvance() && handleNext()}
              />
            </div>
          )}

          {step === 'Directories' && (
            <div>
              <label className="mb-2 block text-sm text-muted-foreground">
                Choose directories to index
              </label>
              <Button variant="outline" size="sm" onClick={handleBrowse}>
                <FolderOpen className="h-3.5 w-3.5" />
                Browse...
              </Button>
              {directories.length > 0 && (
                <div className="mt-3 flex flex-col gap-1.5">
                  {directories.map((dir) => (
                    <div
                      key={dir}
                      className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-xs"
                    >
                      <FolderOpen className="h-3 w-3 shrink-0 text-muted-foreground" />
                      <span className="flex-1 truncate text-foreground">{dir}</span>
                      <button
                        onClick={() => removeDirectory(dir)}
                        className="rounded-sm text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {directories.length === 0 && (
                <p className="mt-3 text-xs text-muted-foreground/60">
                  No directories selected yet.
                </p>
              )}
            </div>
          )}

          {step === 'Extensions' && (
            <div>
              <label className="mb-2 block text-sm text-muted-foreground">
                File extensions to index
              </label>
              <div className="flex flex-wrap gap-2">
                {COMMON_EXTENSIONS.map((ext) => (
                  <button
                    key={ext}
                    onClick={() => toggleExtension(ext)}
                    className={cn(
                      'rounded-md border px-2.5 py-1 text-xs transition-colors',
                      extensions.includes(ext)
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border text-muted-foreground hover:border-foreground/20',
                    )}
                  >
                    {ext}
                  </button>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-1">
                {extensions.map((ext) => (
                  <Badge key={ext} variant="secondary" className="gap-1">
                    {ext}
                    <button onClick={() => toggleExtension(ext)}>
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {step === 'Storage' && (
            <div>
              <label className="mb-2 block text-sm text-muted-foreground">
                Database file path
              </label>
              <input
                type="text"
                value={dbPath}
                onChange={(e) => setDbPath(e.target.value)}
                placeholder="e.g. silos/my-silo.db"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring"
                onKeyDown={(e) => e.key === 'Enter' && canAdvance() && handleNext()}
              />
              <p className="mt-2 text-xs text-muted-foreground/60">
                Relative paths are stored inside the app data folder. Use an absolute path to store the database elsewhere.
              </p>
            </div>
          )}

          {step === 'Model' && (
            <div>
              <label className="mb-2 block text-sm text-muted-foreground">
                Embedding model
              </label>
              <div className="flex flex-col gap-1.5">
                {availableModels.map((m) => (
                  <button
                    key={m}
                    onClick={() => setModel(m)}
                    className={cn(
                      'flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors text-left',
                      m === model
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border text-muted-foreground hover:border-foreground/20',
                    )}
                  >
                    <div
                      className={cn(
                        'h-2 w-2 rounded-full border',
                        m === model
                          ? 'border-primary bg-primary'
                          : 'border-muted-foreground/40',
                      )}
                    />
                    {m}
                    {m.startsWith('built-in') && (
                      <span className="text-[10px] text-muted-foreground">(default)</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          {!isFirst && (
            <Button variant="ghost" size="sm" onClick={() => setStepIndex((i) => i - 1)}>
              Back
            </Button>
          )}
          <Button size="sm" onClick={handleNext} disabled={!canAdvance()}>
            {isLast ? (
              <>
                <Plus className="h-3.5 w-3.5" />
                Create Silo
              </>
            ) : (
              'Next'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
