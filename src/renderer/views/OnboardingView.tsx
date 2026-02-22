import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CheckCircle2,
  Loader2,
  XCircle,
  FolderOpen,
  X,
  ExternalLink,
  ArrowRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import ExtensionPicker from '@/components/ExtensionPicker';

const STEPS = ['Ollama', 'Silo', 'Indexing'] as const;
type Step = (typeof STEPS)[number];

export default function OnboardingView() {
  const navigate = useNavigate();
  const [stepIndex, setStepIndex] = useState(0);
  const step = STEPS[stepIndex];

  // Step 1 state
  const [ollamaChecking, setOllamaChecking] = useState(false);
  const [ollamaConnected, setOllamaConnected] = useState<boolean | null>(null);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [serverModels, setServerModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState('snowflake-arctic-embed-xs');

  // Step 2 state
  const [siloName, setSiloName] = useState('');
  const [directories, setDirectories] = useState<string[]>([]);
  const [extensions, setExtensions] = useState<string[]>(['.md', '.py']);
  const [model, setModel] = useState('');

  // Step 3 state
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [indexDone, setIndexDone] = useState(false);
  const [indexProgress, setIndexProgress] = useState<{ current: number; total: number } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const checkOllama = useCallback(async () => {
    setOllamaChecking(true);
    setOllamaConnected(null);
    try {
      // Fetch server status to get available models and default model
      const status = await window.electronAPI?.getServerStatus();
      if (status) {
        setServerModels(status.availableModels);
        setDefaultModel(status.defaultModel);
        setModel(status.defaultModel);
      }

      // Test Ollama connection
      const result = await window.electronAPI?.testOllamaConnection(
        status?.ollamaUrl ?? 'http://localhost:11434',
      );
      setOllamaConnected(result?.connected ?? false);
      setOllamaModels(result?.models ?? []);
    } catch {
      setOllamaConnected(false);
    } finally {
      setOllamaChecking(false);
    }
  }, []);

  // Auto-check on mount
  useEffect(() => {
    checkOllama();
  }, [checkOllama]);

  // Set model to default once loaded
  useEffect(() => {
    if (defaultModel && !model) {
      setModel(defaultModel);
    }
  }, [defaultModel, model]);

  // Poll indexing progress in step 3
  useEffect(() => {
    if (step !== 'Indexing' || indexDone) return;

    pollRef.current = setInterval(async () => {
      const silos = await window.electronAPI?.getSilos();
      if (!silos) return;
      const slug = siloName.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
      const silo = silos.find((s) => s.config.name === slug);
      if (!silo) return;

      if (silo.reconcileProgress && silo.reconcileProgress.total > 0) {
        setIndexProgress(silo.reconcileProgress);
      }

      if (silo.watcherState === 'idle' && silo.indexedFileCount > 0) {
        setIndexDone(true);
        setIndexProgress({ current: silo.indexedFileCount, total: silo.indexedFileCount });
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }
    }, 1000);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [step, indexDone, siloName]);

  function canAdvance(): boolean {
    switch (step) {
      case 'Ollama':
        return !ollamaChecking && ollamaConnected !== null;
      case 'Silo':
        return siloName.trim().length > 0 && directories.length > 0 && extensions.length > 0;
      case 'Indexing':
        return indexDone;
    }
  }

  async function handleNext() {
    if (step === 'Silo') {
      // Create the silo via the real backend
      setStepIndex(2); // Move to Indexing step
      setCreating(true);
      setCreateError(null);

      const slug = siloName.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
      const result = await window.electronAPI?.createSilo({
        name: slug,
        directories,
        extensions,
        dbPath: `${slug}.db`,
        model: model || defaultModel,
      });

      setCreating(false);

      if (result && !result.success) {
        setCreateError(result.error ?? 'Failed to create silo');
      }
    } else if (step === 'Indexing') {
      navigate('/');
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

  return (
    <div className="flex h-screen items-center justify-center">
      <div className="w-full max-w-lg px-6">
        {/* Header */}
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold text-foreground">Welcome to Lodestone</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Let&apos;s get you set up in a few quick steps.
          </p>
        </div>

        {/* Step indicator */}
        <div className="mb-8 flex items-center justify-center gap-2">
          {STEPS.map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <div
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium transition-colors',
                  i < stepIndex && 'bg-primary text-primary-foreground',
                  i === stepIndex && 'bg-primary text-primary-foreground',
                  i > stepIndex && 'bg-muted text-muted-foreground',
                )}
              >
                {i < stepIndex ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : (
                  i + 1
                )}
              </div>
              {i < STEPS.length - 1 && (
                <div
                  className={cn(
                    'h-px w-12',
                    i < stepIndex ? 'bg-primary' : 'bg-muted',
                  )}
                />
              )}
            </div>
          ))}
        </div>

        {/* Step content */}
        <div className="rounded-lg border border-border bg-card p-6">
          {/* ── Step 1: Ollama Detection (Optional) ──── */}
          {step === 'Ollama' && (
            <div>
              <h2 className="text-sm font-medium text-foreground">Ollama Connection</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Lodestone includes a built-in embedding model — it works out of the box.
                Connecting Ollama unlocks higher-quality and specialised models.
              </p>

              <div className="mt-5 flex flex-col items-center gap-4">
                {ollamaChecking && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin" />
                    Checking for Ollama...
                  </div>
                )}

                {!ollamaChecking && ollamaConnected === true && (
                  <div className="w-full">
                    <div className="flex items-center gap-2 text-sm text-emerald-400">
                      <CheckCircle2 className="h-5 w-5" />
                      Ollama detected — {ollamaModels.length} model{ollamaModels.length !== 1 ? 's' : ''} available
                    </div>
                    {ollamaModels.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {ollamaModels.map((m) => (
                          <Badge key={m} variant="secondary" className="text-[10px]">
                            {m}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {!ollamaChecking && ollamaConnected === false && (
                  <div className="w-full">
                    <div className="flex items-center gap-2 text-sm text-amber-400">
                      <XCircle className="h-5 w-5" />
                      Ollama not detected — using built-in model
                    </div>
                    <p className="mt-3 text-xs text-muted-foreground">
                      The built-in model is ready to go. You can optionally install
                      Ollama later for access to more powerful models.
                    </p>
                    <div className="mt-3 flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          window.electronAPI?.openPath('https://ollama.com')
                        }
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        Download Ollama
                      </Button>
                      <Button variant="outline" size="sm" onClick={checkOllama}>
                        Re-check
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Step 2: Create First Silo ───────────── */}
          {step === 'Silo' && (
            <div>
              <h2 className="text-sm font-medium text-foreground">Create Your First Silo</h2>
              <p className="mt-1 mb-4 text-xs text-muted-foreground">
                A silo is a collection of directories whose files are indexed for search.
              </p>

              {/* Name */}
              <label className="mb-1.5 block text-xs text-muted-foreground">Name</label>
              <input
                type="text"
                value={siloName}
                onChange={(e) => setSiloName(e.target.value)}
                placeholder="e.g. personal-kb, my-project"
                className="mb-4 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring"
                autoFocus
              />

              {/* Directories */}
              <label className="mb-1.5 block text-xs text-muted-foreground">Directories</label>
              <Button variant="outline" size="sm" onClick={handleBrowse}>
                <FolderOpen className="h-3.5 w-3.5" />
                Browse...
              </Button>
              {directories.length > 0 && (
                <div className="mt-2 flex flex-col gap-1">
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

              {/* Extensions */}
              <label className="mt-4 mb-1.5 block text-xs text-muted-foreground">
                File Extensions
              </label>
              <ExtensionPicker extensions={extensions} onChange={setExtensions} />

              {/* Model */}
              <label className="mt-4 mb-1.5 block text-xs text-muted-foreground">
                Embedding Model
              </label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="h-8 w-full rounded-md border border-input bg-background px-3 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {serverModels.length > 0 ? (
                  serverModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))
                ) : (
                  <option value={defaultModel}>{defaultModel}</option>
                )}
              </select>
            </div>
          )}

          {/* ── Step 3: Indexing ────────────────────── */}
          {step === 'Indexing' && (
            <div>
              <h2 className="text-sm font-medium text-foreground">Indexing Your Files</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Building the search index for <span className="text-foreground">{siloName || 'your silo'}</span>.
              </p>

              <div className="mt-6">
                {creating && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Creating silo...
                  </div>
                )}

                {createError && (
                  <div className="flex items-center gap-2 text-sm text-red-400">
                    <XCircle className="h-4 w-4" />
                    {createError}
                  </div>
                )}

                {!creating && !createError && (
                  <>
                    {/* Progress bar */}
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary transition-all duration-300"
                        style={{
                          width: indexProgress && indexProgress.total > 0
                            ? `${(indexProgress.current / indexProgress.total) * 100}%`
                            : '0%',
                        }}
                      />
                    </div>

                    <div className="mt-3 flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">
                        {indexDone ? 'Indexing complete' : 'Indexing files...'}
                      </span>
                      <span className="tabular-nums text-foreground">
                        {indexProgress
                          ? `${indexProgress.current.toLocaleString()} / ${indexProgress.total.toLocaleString()} files`
                          : 'Scanning...'}
                      </span>
                    </div>

                    {indexDone && (
                      <div className="mt-4 flex items-center gap-2 text-sm text-emerald-400">
                        <CheckCircle2 className="h-4 w-4" />
                        All files indexed successfully
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Navigation */}
        <div className="mt-6 flex justify-end">
          <Button onClick={handleNext} disabled={!canAdvance() || creating}>
            {step === 'Indexing' ? (
              <>
                Go to Dashboard
                <ArrowRight className="h-4 w-4" />
              </>
            ) : step === 'Ollama' && ollamaConnected === false ? (
              <>
                Continue with Built-in Model
                <ArrowRight className="h-4 w-4" />
              </>
            ) : (
              <>
                Continue
                <ArrowRight className="h-4 w-4" />
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
