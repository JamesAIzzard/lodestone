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
import { FolderOpen, Plus, X, HardDrive, Link } from 'lucide-react';
import { cn } from '@/lib/utils';

const STEPS = ['Name', 'Directories', 'Extensions', 'Model', 'Storage'] as const;
type Step = (typeof STEPS)[number];

const COMMON_EXTENSIONS = ['.md', '.py', '.ts', '.js', '.toml', '.yaml', '.json', '.pdf'];

interface AddSiloModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
}

export default function AddSiloModal({ open, onOpenChange, onCreated }: AddSiloModalProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [directories, setDirectories] = useState<string[]>([]);
  const [extensions, setExtensions] = useState<string[]>(['.md', '.py']);
  const [dbPath, setDbPath] = useState('');
  const [storageMode, setStorageMode] = useState<'new' | 'existing'>('new');
  const [model, setModel] = useState('snowflake-arctic-embed-xs');
  const [availableModels, setAvailableModels] = useState<string[]>(['snowflake-arctic-embed-xs']);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  // Auto-generate db_path when name or model changes (only in 'new' mode)
  useEffect(() => {
    if (name.trim() && storageMode === 'new') {
      const slug = name.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
      setDbPath(`silos/${slug}_${model}.db`);
    }
  }, [name, model, storageMode]);

  function reset() {
    setStepIndex(0);
    setName('');
    setDescription('');
    setDirectories([]);
    setExtensions(['.md', '.py']);
    setDbPath('');
    setStorageMode('new');
    setModel('snowflake-arctic-embed-xs');
    setError(null);
    setCreating(false);
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

  async function handleNext() {
    if (isLast) {
      setCreating(true);
      setError(null);
      try {
        const result = await window.electronAPI?.createSilo({
          name: name.trim(),
          directories,
          extensions,
          dbPath: dbPath.trim(),
          model,
          description: description.trim() || undefined,
        });
        if (result && !result.success) {
          setError(result.error ?? 'Unknown error');
          setCreating(false);
          return;
        }
        handleClose(false);
        onCreated?.();
      } catch (err) {
        setError(String(err));
      } finally {
        setCreating(false);
      }
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
              <label className="mb-1 mt-4 block text-sm text-muted-foreground">
                Description <span className="text-muted-foreground/40">(optional)</span>
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. Personal notes and research — Markdown files from my Obsidian vault"
                rows={2}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring resize-none"
              />
              <p className="mt-1 text-[11px] text-muted-foreground/50">
                Helps AI agents decide which silo to search.
              </p>
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
              <label className="mb-3 block text-sm text-muted-foreground">
                Database storage
              </label>
              <div className="flex gap-2 mb-4">
                <button
                  onClick={() => {
                    setStorageMode('new');
                    // Reset to auto-generated path
                    if (name.trim()) {
                      const slug = name.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
                      setDbPath(`silos/${slug}_${model}.db`);
                    }
                  }}
                  className={cn(
                    'flex-1 flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors text-left',
                    storageMode === 'new'
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border text-muted-foreground hover:border-foreground/20',
                  )}
                >
                  <HardDrive className="h-4 w-4 shrink-0" />
                  <div>
                    <div className="font-medium">Create new</div>
                    <div className="text-[10px] text-muted-foreground">Fresh database</div>
                  </div>
                </button>
                <button
                  onClick={() => {
                    setStorageMode('existing');
                    setDbPath('');
                  }}
                  className={cn(
                    'flex-1 flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors text-left',
                    storageMode === 'existing'
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border text-muted-foreground hover:border-foreground/20',
                  )}
                >
                  <Link className="h-4 w-4 shrink-0" />
                  <div>
                    <div className="font-medium">Connect existing</div>
                    <div className="text-[10px] text-muted-foreground">Reuse a .db file</div>
                  </div>
                </button>
              </div>

              {storageMode === 'new' && (
                <div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 min-w-0">
                      <HardDrive className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="flex-1 text-sm text-foreground font-mono truncate">{dbPath}</span>
                    </div>
                    <Button variant="outline" size="sm" className="shrink-0" onClick={async () => {
                      const slug = name.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-') || 'silo';
                      const chosen = await window.electronAPI?.saveDbFile(`${slug}_${model}.db`);
                      if (chosen) setDbPath(chosen);
                    }}>
                      <FolderOpen className="h-3.5 w-3.5" />
                      Browse...
                    </Button>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground/60">
                    {dbPath.includes('/') || dbPath.includes('\\')
                      ? 'Custom location selected.'
                      : 'Default: stored inside the app data folder. Use Browse to choose a different location.'}
                  </p>
                </div>
              )}

              {storageMode === 'existing' && (
                <div>
                  <Button variant="outline" size="sm" onClick={async () => {
                    const path = await window.electronAPI?.selectDbFile();
                    if (path) setDbPath(path);
                  }}>
                    <FolderOpen className="h-3.5 w-3.5" />
                    Browse...
                  </Button>
                  {dbPath && (
                    <div className="mt-2 flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2">
                      <HardDrive className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="flex-1 text-sm text-foreground font-mono truncate">{dbPath}</span>
                    </div>
                  )}
                  <p className="mt-2 text-xs text-muted-foreground/60">
                    Reconnect a database synced from another machine. The directories above must match
                    the folder structure used when the database was built.
                  </p>
                </div>
              )}
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
                    {m.startsWith('snowflake-arctic-embed') && (
                      <span className="text-[10px] text-muted-foreground">(default)</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {error && (
          <p className="text-xs text-red-400">{error}</p>
        )}

        <DialogFooter>
          {!isFirst && (
            <Button variant="ghost" size="sm" onClick={() => setStepIndex((i) => i - 1)} disabled={creating}>
              Back
            </Button>
          )}
          <Button size="sm" onClick={handleNext} disabled={!canAdvance() || creating}>
            {creating ? (
              'Creating...'
            ) : isLast ? (
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
