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
import { FolderOpen, Plus, X, HardDrive, Link, AlertTriangle, DatabaseZap } from 'lucide-react';
import { cn } from '@/lib/utils';
import ExtensionPicker from './ExtensionPicker';
import type { StoredSiloConfigResponse } from '../../shared/electron-api';

const NEW_STEPS = ['Mode', 'Name', 'Directories', 'Extensions', 'Model', 'Storage'] as const;
const EXISTING_STEPS = ['Mode', 'Storage', 'Name', 'Directories', 'Extensions', 'Model'] as const;
type Step = (typeof NEW_STEPS)[number] | (typeof EXISTING_STEPS)[number];


interface AddSiloModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
}

export default function AddSiloModal({ open, onOpenChange, onCreated }: AddSiloModalProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [mode, setMode] = useState<'new' | 'existing' | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [directories, setDirectories] = useState<string[]>([]);
  const [extensions, setExtensions] = useState<string[]>(['.md', '.py']);
  const [dbPath, setDbPath] = useState('');
  const [model, setModel] = useState('snowflake-arctic-embed-xs');
  const [availableModels, setAvailableModels] = useState<string[]>(['snowflake-arctic-embed-xs']);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // "Connect existing" state
  const [originalDirectories, setOriginalDirectories] = useState<string[]>([]);
  const [dbModel, setDbModel] = useState<string | null>(null);
  const [configLoaded, setConfigLoaded] = useState(false);

  const steps = mode === 'existing' ? EXISTING_STEPS : NEW_STEPS;
  const step: Step = steps[stepIndex];
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === steps.length - 1;

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
    if (name.trim() && mode === 'new') {
      const slug = name.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
      setDbPath(`silos/${slug}_${model}.db`);
    }
  }, [name, model, mode]);

  function reset() {
    setStepIndex(0);
    setMode(null);
    setName('');
    setDescription('');
    setDirectories([]);
    setExtensions(['.md', '.py']);
    setDbPath('');
    setModel('snowflake-arctic-embed-xs');
    setError(null);
    setCreating(false);
    setOriginalDirectories([]);
    setDbModel(null);
    setConfigLoaded(false);
  }

  function handleClose(open: boolean) {
    if (!open) reset();
    onOpenChange(open);
  }

  function canAdvance(): boolean {
    switch (step) {
      case 'Mode':
        return mode !== null;
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

  async function handleSelectExistingDb() {
    const path = await window.electronAPI?.selectDbFile();
    if (!path) return;
    setDbPath(path);

    // Read stored config from the database
    const result: StoredSiloConfigResponse | null | undefined =
      await window.electronAPI?.readDbConfig(path);

    if (result?.config) {
      setName(result.config.name);
      setDescription(result.config.description ?? '');
      setExtensions(result.config.extensions);
      setOriginalDirectories(result.config.directories);
      setModel(result.config.model);
      setConfigLoaded(true);
    } else if (result?.meta) {
      // Legacy DB without config blob — pre-fill model from meta
      setModel(result.meta.model);
      setConfigLoaded(false);
    } else {
      setConfigLoaded(false);
    }

    // Always store the DB's built-in model for mismatch warnings
    if (result?.meta) {
      setDbModel(result.meta.model);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {mode === 'existing' ? 'Connect Database' : 'Create Silo'}
          </DialogTitle>
          <DialogDescription>
            Step {stepIndex + 1} of {steps.length}: {step}
          </DialogDescription>
        </DialogHeader>

        {/* Step indicator */}
        <div className="mt-2 flex gap-1">
          {steps.map((_, i) => (
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

          {/* ── Mode ─────────────────────────────────────────────── */}
          {step === 'Mode' && (
            <div>
              <label className="mb-3 block text-sm text-muted-foreground">
                How would you like to set up this silo?
              </label>
              <div className="flex gap-2">
                <button
                  onClick={() => setMode('new')}
                  className={cn(
                    'flex-1 flex items-center gap-2 rounded-md border px-3 py-2.5 text-sm transition-colors text-left',
                    mode === 'new'
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border text-muted-foreground hover:border-foreground/20',
                  )}
                >
                  <HardDrive className="h-4 w-4 shrink-0" />
                  <div>
                    <div className="font-medium">Create new</div>
                    <div className="text-[10px] text-muted-foreground">Fresh silo and database</div>
                  </div>
                </button>
                <button
                  onClick={() => setMode('existing')}
                  className={cn(
                    'flex-1 flex items-center gap-2 rounded-md border px-3 py-2.5 text-sm transition-colors text-left',
                    mode === 'existing'
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border text-muted-foreground hover:border-foreground/20',
                  )}
                >
                  <DatabaseZap className="h-4 w-4 shrink-0" />
                  <div>
                    <div className="font-medium">Connect existing</div>
                    <div className="text-[10px] text-muted-foreground">Reconnect a portable .db file</div>
                  </div>
                </button>
              </div>
            </div>
          )}

          {/* ── Name ─────────────────────────────────────────────── */}
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

          {/* ── Directories ──────────────────────────────────────── */}
          {step === 'Directories' && (
            <div>
              {/* Show original directories from DB as reference */}
              {mode === 'existing' && originalDirectories.length > 0 && (
                <div className="mb-3">
                  <label className="mb-1.5 block text-[11px] text-muted-foreground/60">
                    Original directories (from database)
                  </label>
                  <div className="flex flex-col gap-1">
                    {originalDirectories.map((dir) => (
                      <div
                        key={dir}
                        className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-3 py-1 text-[10px] text-muted-foreground/60 font-mono"
                      >
                        <FolderOpen className="h-2.5 w-2.5 shrink-0" />
                        <span className="truncate">{dir}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <label className="mb-2 block text-sm text-muted-foreground">
                {mode === 'existing' ? 'Select local directories to map' : 'Choose directories to index'}
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

          {/* ── Extensions ───────────────────────────────────────── */}
          {step === 'Extensions' && (
            <div>
              <label className="mb-2 block text-sm text-muted-foreground">
                File extensions to index
              </label>
              <ExtensionPicker
                extensions={extensions}
                onChange={setExtensions}
              />
            </div>
          )}

          {/* ── Model ────────────────────────────────────────────── */}
          {step === 'Model' && (
            <div>
              <label className="mb-2 block text-sm text-muted-foreground">
                Embedding model
              </label>
              {mode === 'existing' && dbModel && model !== dbModel && (
                <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>
                    The index was built with <strong>{dbModel}</strong>. Choosing a different model will require a full rebuild.
                  </span>
                </div>
              )}
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
                    {m === dbModel && mode === 'existing' && (
                      <span className="text-[10px] text-muted-foreground">(stored in DB)</span>
                    )}
                    {m.startsWith('snowflake-arctic-embed') && mode !== 'existing' && (
                      <span className="text-[10px] text-muted-foreground">(default)</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── Storage ──────────────────────────────────────────── */}
          {step === 'Storage' && mode === 'new' && (
            <div>
              <label className="mb-3 block text-sm text-muted-foreground">
                Database storage location
              </label>
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

          {step === 'Storage' && mode === 'existing' && (
            <div>
              <label className="mb-3 block text-sm text-muted-foreground">
                Select a database file to reconnect
              </label>
              <Button variant="outline" size="sm" onClick={handleSelectExistingDb}>
                <FolderOpen className="h-3.5 w-3.5" />
                Browse...
              </Button>
              {dbPath && (
                <div className="mt-3 flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2">
                  <HardDrive className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1 text-sm text-foreground font-mono truncate">{dbPath}</span>
                </div>
              )}
              {dbPath && configLoaded && (
                <p className="mt-2 text-xs text-emerald-400">
                  Settings loaded from database. Review and adjust in the following steps.
                </p>
              )}
              {dbPath && !configLoaded && dbModel && (
                <p className="mt-2 text-xs text-muted-foreground/60">
                  Database found (model: {dbModel}), but no stored settings. You'll configure them manually.
                </p>
              )}
              {dbPath && !configLoaded && !dbModel && (
                <p className="mt-2 text-xs text-muted-foreground/60">
                  Database opened. Configure settings in the following steps.
                </p>
              )}
              {!dbPath && (
                <p className="mt-3 text-xs text-muted-foreground/60">
                  Reconnect a database synced from another machine.
                </p>
              )}
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
                {mode === 'existing' ? 'Connect' : 'Create Silo'}
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
