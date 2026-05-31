import { useState, useEffect } from 'react';
import { Loader2, CheckCircle2, XCircle, FileCode, FolderOpen, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import IgnorePatternsEditor from '@/components/IgnorePatternsEditor';
import ExtensionPicker from '@/components/ExtensionPicker';
import type {
  McpClientConfigureResult,
  McpClientId,
  McpClientStatus,
} from '../../shared/electron-api';

const MCP_CLIENTS: Array<{
  id: McpClientId;
  label: string;
  fallbackConfigName: string;
  restartLabel: string;
}> = [
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    fallbackConfigName: 'claude_desktop_config.json',
    restartLabel: 'Claude Desktop',
  },
  {
    id: 'codex-desktop',
    label: 'Codex Desktop',
    fallbackConfigName: 'config.toml',
    restartLabel: 'Codex Desktop',
  },
];

export default function SettingsView() {
  const [extensions, setExtensions] = useState<string[]>([]);
  const [folderIgnore, setFolderIgnore] = useState<string[]>([]);
  const [fileIgnore, setFileIgnore] = useState<string[]>([]);
  const [fileChangeDelaySeconds, setFileChangeDelaySeconds] = useState(10);
  const [maxActivityLogEntries, setMaxActivityLogEntries] = useState(2000);
  const [dataDir, setDataDir] = useState('');
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [selectedMcpClient, setSelectedMcpClient] = useState<McpClientId>('claude-desktop');
  const [mcpClientStatuses, setMcpClientStatuses] = useState<
    Partial<Record<McpClientId, McpClientStatus>>
  >({});
  const [configuringMcpClient, setConfiguringMcpClient] = useState(false);
  const [mcpClientConfigResult, setMcpClientConfigResult] =
    useState<McpClientConfigureResult | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);

  useEffect(() => {
    window.electronAPI?.getDefaults().then((d) => {
      setExtensions(d.indexedFileExtensions);
      setFolderIgnore(d.ignoredFolderPatterns);
      setFileIgnore(d.ignoredFilePatterns);
      setFileChangeDelaySeconds(d.fileChangeDelaySeconds);
      setMaxActivityLogEntries(d.maxActivityLogEntries);
    });
    window.electronAPI?.getDataDir().then((dir) => setDataDir(dir));
    for (const client of MCP_CLIENTS) {
      window.electronAPI?.getMcpClientStatus(client.id).then((clientStatus) => {
        setMcpClientStatuses((current) => ({
          ...current,
          [client.id]: clientStatus,
        }));
      });
    }
    window.electronAPI?.getAppVersion().then(setAppVersion);
  }, []);

  function handleExtensionsChange(updated: string[]) {
    setExtensions(updated);
    window.electronAPI?.updateDefaults({ indexedFileExtensions: updated });
  }

  function handleFolderIgnoreChange(patterns: string[]) {
    setFolderIgnore(patterns);
    window.electronAPI?.updateDefaults({ ignoredFolderPatterns: patterns });
  }

  function handleFileIgnoreChange(patterns: string[]) {
    setFileIgnore(patterns);
    window.electronAPI?.updateDefaults({ ignoredFilePatterns: patterns });
  }

  function handleDebounceChange(value: number) {
    const clamped = Math.max(1, value);
    setFileChangeDelaySeconds(clamped);
    window.electronAPI?.updateDefaults({ fileChangeDelaySeconds: clamped });
  }

  function handleActivityLogLimitChange(value: number) {
    const clamped = Math.max(100, Math.min(50000, value));
    setMaxActivityLogEntries(clamped);
    window.electronAPI?.updateDefaults({ maxActivityLogEntries: clamped });
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

  async function handleConfigureMcpClient() {
    setConfiguringMcpClient(true);
    setMcpClientConfigResult(null);
    try {
      const result = await window.electronAPI?.configureMcpClient(selectedMcpClient);
      setMcpClientConfigResult(
        result ?? { success: false, configPath: '', error: 'Unknown error' },
      );
      if (result?.success) {
        const status = await window.electronAPI?.getMcpClientStatus(selectedMcpClient);
        if (status) {
          setMcpClientStatuses((current) => ({
            ...current,
            [selectedMcpClient]: status,
          }));
        }
      }
    } finally {
      setConfiguringMcpClient(false);
    }
  }

  async function handleOpenConfig() {
    const configPath = await window.electronAPI?.getConfigPath();
    if (configPath) window.electronAPI?.openPath(configPath);
  }

  function handleOpenDataDir() {
    if (dataDir) window.electronAPI?.openPath(dataDir);
  }

  const selectedMcpClientInfo =
    MCP_CLIENTS.find((client) => client.id === selectedMcpClient) ?? MCP_CLIENTS[0];
  const selectedMcpClientStatus = mcpClientStatuses[selectedMcpClient] ?? null;

  return (
    <div className="p-6">
      <h1 className="mb-8 text-lg font-semibold text-foreground">Settings</h1>

      <div className="flex flex-col gap-10 max-w-2xl">
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
          description="Controls for the file watcher and activity log."
        >
          <div className="flex flex-col gap-4">
            <div>
              <label className="mb-1.5 block text-xs text-muted-foreground">
                File change delay
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={fileChangeDelaySeconds}
                  onChange={(e) => handleDebounceChange(Number(e.target.value))}
                  className="h-9 w-24 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <span className="text-sm text-muted-foreground">seconds</span>
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-xs text-muted-foreground">
                Activity log limit
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="number"
                  min={100}
                  max={50000}
                  step={100}
                  value={maxActivityLogEntries}
                  onChange={(e) => handleActivityLogLimitChange(Number(e.target.value))}
                  className="h-9 w-28 rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <span className="text-sm text-muted-foreground">events per silo</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground/60">
                Older events are pruned automatically. Takes effect on next indexing event.
              </p>
            </div>
          </div>
        </Section>

        {/* ── MCP Client Integration ────────────────────────────── */}
        <Section
          title="LLM Client Integration"
          description="Register Lodestone as a local MCP server for supported desktop clients."
        >
          <div className="flex flex-col gap-3">
            <div>
              <label className="mb-1.5 block text-xs text-muted-foreground">Client</label>
              <select
                value={selectedMcpClient}
                onChange={(event) => {
                  setSelectedMcpClient(event.target.value as McpClientId);
                  setMcpClientConfigResult(null);
                }}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {MCP_CLIENTS.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.label}
                  </option>
                ))}
              </select>
            </div>

            {selectedMcpClientStatus?.isConfigured && (
              <div className="flex items-center gap-2 text-sm text-emerald-400">
                <CheckCircle2 className="h-4 w-4" />
                MCP server is configured
              </div>
            )}
            {selectedMcpClientStatus && !selectedMcpClientStatus.isConfigured && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <XCircle className="h-4 w-4" />
                Not yet configured
              </div>
            )}
            <div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleConfigureMcpClient}
                disabled={configuringMcpClient}
              >
                {configuringMcpClient && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {selectedMcpClientStatus?.isConfigured
                  ? `Reconfigure ${selectedMcpClientInfo.label}`
                  : `Configure ${selectedMcpClientInfo.label}`}
              </Button>
              <p className="mt-2 text-xs text-muted-foreground/60">
                Writes the <code className="text-[10px]">lodestone-files</code> entry to{' '}
                <code className="text-[10px]">
                  {selectedMcpClientStatus?.configPath ?? selectedMcpClientInfo.fallbackConfigName}
                </code>
                . Existing MCP servers are preserved. Restart {selectedMcpClientInfo.restartLabel}{' '}
                after configuring.
              </p>
            </div>
            {mcpClientConfigResult?.success && (
              <div className="flex items-center gap-2 text-sm text-emerald-400">
                <CheckCircle2 className="h-4 w-4" />
                Configured — restart {selectedMcpClientInfo.restartLabel} to apply
              </div>
            )}
            {mcpClientConfigResult && !mcpClientConfigResult.success && (
              <div className="text-sm text-red-400">Error: {mcpClientConfigResult.error}</div>
            )}
          </div>
        </Section>

        {/* ── Advanced ─────────────────────────────────────────── */}
        <Section title="Advanced">
          <div className="flex flex-col gap-3">
            <div>
              <p className="mb-2 text-xs text-muted-foreground font-mono break-all">
                {dataDir || '…'}
              </p>
              <Button variant="outline" size="sm" onClick={handleOpenDataDir} disabled={!dataDir}>
                <FolderOpen className="h-3.5 w-3.5" />
                Open Data Folder
              </Button>
              <p className="mt-2 text-xs text-muted-foreground/60">
                All configuration, databases, and local app data are stored here.
              </p>
            </div>
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
            {appVersion && (
              <p className="text-xs text-muted-foreground/50">Lodestone v{appVersion}</p>
            )}
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
            This will remove all silos and reset every setting to its default value. The database
            files on disk will not be deleted — you can reconnect silos afterwards.
          </p>
          <p className="text-sm text-muted-foreground">This action cannot be undone.</p>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowResetConfirm(false)}
              disabled={resetting}
            >
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={handleResetAll} disabled={resetting}>
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
      {description && <p className="mt-1 mb-3 text-xs text-muted-foreground">{description}</p>}
      {!description && <div className="mt-3" />}
      {children}
    </section>
  );
}
