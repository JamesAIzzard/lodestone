import { useState, useEffect } from 'react';
import { Loader2, CheckCircle2, XCircle, X, FileCode } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { ServerStatus } from '../../shared/types';

export default function SettingsView() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ connected: boolean; models: string[] } | null>(null);
  const [selectedModel, setSelectedModel] = useState('');
  const [extensions, setExtensions] = useState(['.md', '.py']);
  const [extInput, setExtInput] = useState('');
  const [ignorePatterns, setIgnorePatterns] = useState(['.git', '__pycache__', 'node_modules', '.obsidian']);
  const [ignoreInput, setIgnoreInput] = useState('');

  useEffect(() => {
    window.electronAPI?.getServerStatus().then((s) => {
      setStatus(s);
      setOllamaUrl(s.ollamaUrl);
      setSelectedModel(s.defaultModel);
    });
  }, []);

  async function handleTestConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.electronAPI?.testOllamaConnection(ollamaUrl);
      setTestResult(result ?? { connected: false, models: [] });
    } catch {
      setTestResult({ connected: false, models: [] });
    } finally {
      setTesting(false);
    }
  }

  function addExtension() {
    const val = extInput.trim();
    if (!val) return;
    const ext = val.startsWith('.') ? val : `.${val}`;
    if (!extensions.includes(ext)) {
      setExtensions((prev) => [...prev, ext]);
    }
    setExtInput('');
  }

  function removeExtension(ext: string) {
    setExtensions((prev) => prev.filter((e) => e !== ext));
  }

  function addIgnorePattern() {
    const val = ignoreInput.trim();
    if (!val || ignorePatterns.includes(val)) return;
    setIgnorePatterns((prev) => [...prev, val]);
    setIgnoreInput('');
  }

  function removeIgnorePattern(pattern: string) {
    setIgnorePatterns((prev) => prev.filter((p) => p !== pattern));
  }

  async function handleOpenConfig() {
    const configPath = await window.electronAPI?.getConfigPath();
    if (configPath) window.electronAPI?.openPath(configPath);
  }

  // Build model list from server status + Ollama test results
  const availableModels: string[] = [];
  if (status) {
    availableModels.push(...status.availableModels);
  }
  if (testResult?.connected) {
    // Add any Ollama models not already in the list
    for (const m of testResult.models) {
      if (!availableModels.includes(m)) {
        availableModels.push(m);
      }
    }
  }
  // Fallback if nothing loaded yet
  if (availableModels.length === 0) {
    availableModels.push('snowflake-arctic-embed-xs');
  }

  return (
    <div className="p-6">
      <h1 className="mb-8 text-lg font-semibold text-foreground">Settings</h1>

      <div className="flex flex-col gap-10 max-w-2xl">
        {/* ── Ollama Connection ─────────────────────────────────── */}
        <Section title="Ollama Connection">
          <div className="flex items-center gap-3">
            <input
              type="text"
              value={ollamaUrl}
              onChange={(e) => setOllamaUrl(e.target.value)}
              className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={handleTestConnection}
              disabled={testing}
            >
              {testing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {!testing && 'Test Connection'}
            </Button>
          </div>

          {testResult?.connected && (
            <div className="mt-3 flex items-center gap-2 text-sm text-emerald-400">
              <CheckCircle2 className="h-4 w-4" />
              Connected — {testResult.models.length} model{testResult.models.length !== 1 && 's'} available
            </div>
          )}
          {testResult && !testResult.connected && (
            <div className="mt-3 flex items-center gap-2 text-sm text-red-400">
              <XCircle className="h-4 w-4" />
              Could not connect to Ollama at {ollamaUrl}
            </div>
          )}

          {testResult?.connected && testResult.models.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {testResult.models.map((m) => (
                <Badge key={m} variant="secondary" className="text-[10px]">
                  {m}
                </Badge>
              ))}
            </div>
          )}
        </Section>

        {/* ── Default Embedding Model ──────────────────────────── */}
        <Section
          title="Default Embedding Model"
          description="Applies to newly created silos. Existing silos are not affected."
        >
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {availableModels.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Section>

        {/* ── Default File Extensions ──────────────────────────── */}
        <Section
          title="Default File Extensions"
          description="Extensions to index when creating new silos."
        >
          <div className="flex flex-wrap gap-1.5 mb-3">
            {extensions.map((ext) => (
              <Badge key={ext} variant="secondary" className="gap-1 text-xs">
                {ext}
                <button onClick={() => removeExtension(ext)}>
                  <X className="h-2.5 w-2.5" />
                </button>
              </Badge>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={extInput}
              onChange={(e) => setExtInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addExtension()}
              placeholder="e.g. .ts"
              className="h-8 w-32 rounded-md border border-input bg-background px-3 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <Button variant="outline" size="sm" onClick={addExtension}>
              Add
            </Button>
          </div>
        </Section>

        {/* ── Default Ignore Patterns ──────────────────────────── */}
        <Section
          title="Default Ignore Patterns"
          description="Directories and patterns to exclude from indexing."
        >
          <div className="flex flex-wrap gap-1.5 mb-3">
            {ignorePatterns.map((pattern) => (
              <Badge key={pattern} variant="secondary" className="gap-1 text-xs">
                {pattern}
                <button onClick={() => removeIgnorePattern(pattern)}>
                  <X className="h-2.5 w-2.5" />
                </button>
              </Badge>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={ignoreInput}
              onChange={(e) => setIgnoreInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addIgnorePattern()}
              placeholder="e.g. .venv"
              className="h-8 w-32 rounded-md border border-input bg-background px-3 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <Button variant="outline" size="sm" onClick={addIgnorePattern}>
              Add
            </Button>
          </div>
        </Section>

        {/* ── Advanced ─────────────────────────────────────────── */}
        <Section title="Advanced">
          <Button variant="outline" size="sm" onClick={handleOpenConfig}>
            <FileCode className="h-3.5 w-3.5" />
            Open Configuration File
          </Button>
          <p className="mt-2 text-xs text-muted-foreground/60">
            Edit the TOML configuration file directly. Changes take effect on restart.
          </p>
        </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      {description && (
        <p className="mt-1 mb-3 text-xs text-muted-foreground">{description}</p>
      )}
      {!description && <div className="mt-3" />}
      {children}
    </section>
  );
}
