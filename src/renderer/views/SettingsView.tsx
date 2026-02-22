import { useState, useEffect } from 'react';
import { Loader2, CheckCircle2, XCircle, FileCode, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import IgnorePatternsEditor from '@/components/IgnorePatternsEditor';
import ExtensionPicker from '@/components/ExtensionPicker';
import type { ServerStatus } from '../../shared/types';

export default function SettingsView() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ connected: boolean; models: string[] } | null>(null);
  const [selectedModel, setSelectedModel] = useState('');
  const [extensions, setExtensions] = useState<string[]>([]);
  const [folderIgnore, setFolderIgnore] = useState<string[]>([]);
  const [fileIgnore, setFileIgnore] = useState<string[]>([]);
  const [debounce, setDebounce] = useState(10);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    window.electronAPI?.getServerStatus().then((s) => {
      setStatus(s);
      setOllamaUrl(s.ollamaUrl);
      setSelectedModel(s.defaultModel);
    });
    window.electronAPI?.getDefaults().then((d) => {
      setExtensions(d.extensions);
      setFolderIgnore(d.ignore);
      setFileIgnore(d.ignoreFiles);
      setDebounce(d.debounce);
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

  function handleExtensionsChange(updated: string[]) {
    setExtensions(updated);
    window.electronAPI?.updateDefaults({ extensions: updated });
  }

  function handleFolderIgnoreChange(patterns: string[]) {
    setFolderIgnore(patterns);
    window.electronAPI?.updateDefaults({ ignore: patterns });
  }

  function handleFileIgnoreChange(patterns: string[]) {
    setFileIgnore(patterns);
    window.electronAPI?.updateDefaults({ ignoreFiles: patterns });
  }

  function handleDebounceChange(value: number) {
    const clamped = Math.max(1, value);
    setDebounce(clamped);
    window.electronAPI?.updateDefaults({ debounce: clamped });
  }

  async function handleResetAll() {
    setResetting(true);
    try {
      await window.electronAPI?.resetAllSettings();
      window.location.reload();
    } finally {
      setResetting(false);
      setShowResetConfirm(false);
    }
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
    for (const m of testResult.models) {
      if (!availableModels.includes(m)) {
        availableModels.push(m);
      }
    }
  }
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
          <ExtensionPicker extensions={extensions} onChange={handleExtensionsChange} />
        </Section>

        {/* ── Default Ignore Patterns ──────────────────────────── */}
        <Section
          title="Default Ignore Patterns"
          description="Patterns to exclude from indexing. Applied to newly created silos."
        >
          <IgnorePatternsEditor
            folderPatterns={folderIgnore}
            filePatterns={fileIgnore}
            onFolderPatternsChange={handleFolderIgnoreChange}
            onFilePatternsChange={handleFileIgnoreChange}
          />
        </Section>

        {/* ── File Watching ─────────────────────────────────────── */}
        <Section
          title="File Watching"
          description="How long to wait after a file change before re-indexing it."
        >
          <div className="flex items-center gap-3">
            <input
              type="number"
              min={1}
              step={1}
              value={debounce}
              onChange={(e) => handleDebounceChange(Number(e.target.value))}
              className="h-9 w-24 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <span className="text-sm text-muted-foreground">seconds</span>
          </div>
        </Section>

        {/* ── Advanced ─────────────────────────────────────────── */}
        <Section title="Advanced">
          <div className="flex flex-col gap-3">
            <div>
              <Button variant="outline" size="sm" onClick={handleOpenConfig}>
                <FileCode className="h-3.5 w-3.5" />
                Open Configuration File
              </Button>
              <p className="mt-2 text-xs text-muted-foreground/60">
                Edit the TOML configuration file directly. Changes take effect on restart.
              </p>
            </div>
            <div>
              <Button
                variant="outline"
                size="sm"
                className="border-destructive/50 text-destructive hover:bg-destructive/10"
                onClick={() => setShowResetConfirm(true)}
              >
                <TriangleAlert className="h-3.5 w-3.5" />
                Reset All Settings
              </Button>
              <p className="mt-2 text-xs text-muted-foreground/60">
                Remove all silos and restore default settings.
              </p>
            </div>
          </div>
        </Section>
      </div>

      {/* ── Reset Confirmation Dialog ─────────────────────────── */}
      <Dialog open={showResetConfirm} onOpenChange={setShowResetConfirm}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <TriangleAlert className="h-4 w-4" />
              Reset All Settings?
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will remove all silos and reset every setting to its default value. The database files on disk will not be deleted — you can reconnect silos afterwards.
          </p>
          <p className="text-sm text-muted-foreground">
            This action cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowResetConfirm(false)} disabled={resetting}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleResetAll}
              disabled={resetting}
            >
              {resetting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Reset Everything
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
