import { useState, useEffect, useCallback } from 'react';
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
import { mockServerStatus, DEFAULT_MODEL } from '../../shared/mock-data';

const STEPS = ['Ollama', 'Silo', 'Indexing'] as const;
type Step = (typeof STEPS)[number];

const COMMON_EXTENSIONS = ['.md', '.py', '.ts', '.js', '.toml', '.yaml', '.json', '.pdf'];

export default function OnboardingView() {
  const navigate = useNavigate();
  const [stepIndex, setStepIndex] = useState(0);
  const step = STEPS[stepIndex];

  // Step 1 state
  const [ollamaChecking, setOllamaChecking] = useState(false);
  const [ollamaFound, setOllamaFound] = useState<boolean | null>(null);
  // Toggle this to test "not found" state during development
  const [simulateNotFound] = useState(false);

  // Step 2 state
  const [siloName, setSiloName] = useState('');
  const [directories, setDirectories] = useState<string[]>([]);
  const [extensions, setExtensions] = useState<string[]>(['.md', '.py']);
  const [model, setModel] = useState(DEFAULT_MODEL);

  // Step 3 state
  const [indexProgress, setIndexProgress] = useState(0);
  const [indexDone, setIndexDone] = useState(false);

  const checkOllama = useCallback(() => {
    setOllamaChecking(true);
    setOllamaFound(null);
    setTimeout(() => {
      setOllamaChecking(false);
      setOllamaFound(!simulateNotFound);
    }, 1500);
  }, [simulateNotFound]);

  // Auto-check on mount
  useEffect(() => {
    checkOllama();
  }, [checkOllama]);

  // Animate indexing progress
  useEffect(() => {
    if (step !== 'Indexing') return;
    setIndexProgress(0);
    setIndexDone(false);
    const target = 342;
    const duration = 3000;
    const interval = 50;
    const increment = target / (duration / interval);
    let current = 0;
    const timer = setInterval(() => {
      current += increment;
      if (current >= target) {
        setIndexProgress(target);
        setIndexDone(true);
        clearInterval(timer);
      } else {
        setIndexProgress(Math.floor(current));
      }
    }, interval);
    return () => clearInterval(timer);
  }, [step]);

  function canAdvance(): boolean {
    switch (step) {
      case 'Ollama':
        return ollamaFound === true;
      case 'Silo':
        return siloName.trim().length > 0 && directories.length > 0 && extensions.length > 0;
      case 'Indexing':
        return indexDone;
    }
  }

  function handleNext() {
    if (step === 'Indexing') {
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

  function toggleExtension(ext: string) {
    setExtensions((prev) =>
      prev.includes(ext) ? prev.filter((e) => e !== ext) : [...prev, ext],
    );
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
          {/* ── Step 1: Ollama Check ────────────────── */}
          {step === 'Ollama' && (
            <div>
              <h2 className="text-sm font-medium text-foreground">Ollama Connection</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Lodestone uses Ollama to run embedding models locally.
                Your data never leaves your machine.
              </p>

              <div className="mt-5 flex flex-col items-center gap-4">
                {ollamaChecking && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin" />
                    Checking for Ollama...
                  </div>
                )}

                {!ollamaChecking && ollamaFound === true && (
                  <div className="w-full">
                    <div className="flex items-center gap-2 text-sm text-emerald-400">
                      <CheckCircle2 className="h-5 w-5" />
                      Ollama detected — {mockServerStatus.availableModels.length} models available
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {mockServerStatus.availableModels.map((m) => (
                        <Badge key={m} variant="secondary" className="text-[10px]">
                          {m}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {!ollamaChecking && ollamaFound === false && (
                  <div className="w-full">
                    <div className="flex items-center gap-2 text-sm text-red-400">
                      <XCircle className="h-5 w-5" />
                      Ollama not detected
                    </div>
                    <p className="mt-3 text-xs text-muted-foreground">
                      Ollama is a local tool that runs AI models on your machine.
                      Install it, then click Re-check.
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
              <div className="flex flex-wrap gap-1.5">
                {COMMON_EXTENSIONS.map((ext) => (
                  <button
                    key={ext}
                    onClick={() => toggleExtension(ext)}
                    className={cn(
                      'rounded-md border px-2 py-0.5 text-xs transition-colors',
                      extensions.includes(ext)
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border text-muted-foreground hover:border-foreground/20',
                    )}
                  >
                    {ext}
                  </button>
                ))}
              </div>

              {/* Model */}
              <label className="mt-4 mb-1.5 block text-xs text-muted-foreground">
                Embedding Model
              </label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="h-8 w-full rounded-md border border-input bg-background px-3 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {mockServerStatus.availableModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
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
                {/* Progress bar */}
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-100"
                    style={{ width: `${(indexProgress / 342) * 100}%` }}
                  />
                </div>

                <div className="mt-3 flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">
                    {indexDone ? 'Indexing complete' : 'Indexing files...'}
                  </span>
                  <span className="tabular-nums text-foreground">
                    {indexProgress} / 342 files
                  </span>
                </div>

                {indexDone && (
                  <div className="mt-4 flex items-center gap-2 text-sm text-emerald-400">
                    <CheckCircle2 className="h-4 w-4" />
                    All files indexed successfully
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Navigation */}
        <div className="mt-6 flex justify-end">
          <Button onClick={handleNext} disabled={!canAdvance()}>
            {step === 'Indexing' ? (
              <>
                Go to Dashboard
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
