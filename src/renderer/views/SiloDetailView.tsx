import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ChevronLeft, FileText, Blocks, FolderOpen,
  Loader2, RotateCcw, Trash2, AlertTriangle, Pause, Play,
  HardDrive, Unplug, Pencil, Check, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import IgnorePatternsEditor from '@/components/IgnorePatternsEditor';
import ExtensionPicker from '@/components/ExtensionPicker';
import SiloAppearancePicker from '@/components/SiloAppearancePicker';
import SiloIcon from '@/components/SiloIconComponent';
import ActivityFeed from '@/components/ActivityFeed';
import { SILO_COLOR_MAP, type SiloColor, type SiloIconName } from '../../shared/silo-appearance';
import type { SiloStatus, ServerStatus } from '../../shared/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function abbreviatePath(p: string): string {
  return p
    .replace(/^[A-Z]:\\Users\\[^\\]+/, '~')
    .replace(/^\/home\/[^/]+/, '~');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(isoString: string | null): string {
  if (!isoString) return '—';
  return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function modelIdFromDisplay(display: string): string {
  return display.split(' — ')[0].trim();
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function SiloDetailView() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();

  // Live silo data — updated by polling
  const [silo, setSilo] = useState<SiloStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Tracks which silo name we've already initialised form state for
  const initializedRef = useRef<string | null>(null);

  // Action state
  const [isStopping, setIsStopping]       = useState(false);
  const [isWaking, setIsWaking]           = useState(false);
  const [rebuilding, setRebuilding]       = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting]           = useState(false);
  const [deleteError, setDeleteError]     = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  // Rename state
  const [siloName, setSiloName]           = useState(name ?? '');
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName]           = useState('');
  const [renameError, setRenameError]     = useState<string | null>(null);
  const [isRenaming, setIsRenaming]       = useState(false);

  // Editable form state
  const [editDescription, setEditDescription] = useState('');
  const [serverStatus, setServerStatus]     = useState<ServerStatus | null>(null);
  const [selectedModel, setSelectedModel]   = useState('');
  const [folderIgnore, setFolderIgnore]     = useState<string[]>([]);
  const [fileIgnore, setFileIgnore]         = useState<string[]>([]);
  const [ignoreOverridden, setIgnoreOverridden] = useState(false);
  const [defaultFolderIgnore, setDefaultFolderIgnore] = useState<string[]>([]);
  const [defaultFileIgnore, setDefaultFileIgnore]     = useState<string[]>([]);
  const [extensions, setExtensions]         = useState<string[]>([]);
  const [extensionOverridden, setExtensionOverridden] = useState(false);
  const [defaultExtensions, setDefaultExtensions]     = useState<string[]>([]);
  const [siloColor, setSiloColor]           = useState<SiloColor>('blue');
  const [siloIcon, setSiloIcon]             = useState<SiloIconName>('database');

  // ── Data fetching ───────────────────────────────────────────────────────────

  function fetchSilo() {
    window.electronAPI?.getSilos().then((silos) => {
      const found = silos.find((s) => s.config.name === name);
      if (!found) { navigate('/'); return; }
      setSilo(found);
    });
  }

  // Reset and re-fetch whenever the name param changes
  useEffect(() => {
    initializedRef.current = null;
    setSilo(null);
    setConfirmDelete(false);
    setConfirmDisconnect(false);
    fetchSilo();
  }, [name]); // eslint-disable-line react-hooks/exhaustive-deps

  // Polling — active while indexing, waiting, or during stop/wake transitions
  useEffect(() => {
    if (!silo) return;
    const active = silo.watcherState === 'indexing' || silo.watcherState === 'waiting' || isStopping || isWaking;
    if (active && !pollRef.current) {
      pollRef.current = setInterval(fetchSilo, 2000);
    } else if (!active && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [silo?.watcherState, isStopping, isWaking]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear isWaking once the backend state moves past 'stopped'
  useEffect(() => {
    if (isWaking && silo && silo.watcherState !== 'stopped') {
      setIsWaking(false);
    }
  }, [silo?.watcherState, isWaking]);

  // Initialise editable form state once per silo (not on every poll tick)
  useEffect(() => {
    if (!silo || initializedRef.current === silo.config.name) return;
    initializedRef.current = silo.config.name;

    setSiloName(silo.config.name);
    setIsEditingName(false);
    setEditName('');
    setRenameError(null);
    setEditDescription(silo.config.description || '');
    setFolderIgnore(silo.config.ignorePatterns);
    setFileIgnore(silo.config.ignoreFilePatterns);
    setIgnoreOverridden(silo.config.hasIgnoreOverride || silo.config.hasFileIgnoreOverride);
    setExtensions(silo.config.extensions);
    setExtensionOverridden(silo.config.hasExtensionOverride);
    setSiloColor(silo.config.color);
    setSiloIcon(silo.config.icon);

    window.electronAPI?.getServerStatus().then((status) => {
      setServerStatus(status);
      const effective = silo.config.modelOverride ?? status.defaultModel;
      setSelectedModel(effective);
    });

    window.electronAPI?.getDefaults().then((d) => {
      setDefaultFolderIgnore(d.ignore);
      setDefaultFileIgnore(d.ignoreFiles);
      setDefaultExtensions(d.extensions);
    });

  }, [silo]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Handlers ────────────────────────────────────────────────────────────────

  function handleStopToggle() {
    if (!silo) return;
    if (silo.watcherState === 'stopped') {
      // Wake is long-running (startup + reconciliation). Fire-and-forget
      // so the UI can poll state transitions (waiting → indexing → ready).
      setIsWaking(true);
      window.electronAPI?.wakeSilo(siloName).catch(() => {}).finally(() => setIsWaking(false));
    } else {
      // Stop may take a moment (awaiting in-flight indexing). Fire-and-forget
      // so the badge can track the transition via polling.
      setIsStopping(true);
      window.electronAPI?.stopSilo(siloName).catch(() => {}).finally(() => setIsStopping(false));
    }
    // Kick off a poll after a short delay so the backend has time to
    // update its state synchronously before we read it.
    setTimeout(fetchSilo, 300);
  }

  async function handleRename() {
    if (!editName.trim() || isRenaming) return;
    setIsRenaming(true);
    setRenameError(null);
    try {
      const result = await window.electronAPI?.renameSilo(siloName, editName.trim());
      if (result?.success) {
        const newSlug = editName.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
        // Replace history entry so Back still goes to /
        navigate(`/silos/${newSlug}`, { replace: true });
      } else {
        setRenameError(result?.error ?? 'Rename failed');
      }
    } catch (err) {
      setRenameError(String(err));
    } finally {
      setIsRenaming(false);
    }
  }

  async function handleModelChange(newModel: string) {
    setSelectedModel(newModel);
    await window.electronAPI?.updateSilo(siloName, { model: newModel });
    fetchSilo();
  }

  async function handleRebuild() {
    setRebuilding(true);
    try {
      const result = await window.electronAPI?.rebuildSilo(siloName);
      if (result?.success) fetchSilo();
    } catch (err) {
      console.error('Rebuild failed:', err);
    } finally {
      setRebuilding(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setDeleteError(null);
    const result = await window.electronAPI?.deleteSilo(siloName);
    if (result?.success) {
      navigate('/');
    } else {
      setDeleteError(result?.error ?? 'Failed to delete silo');
      setDeleting(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    const result = await window.electronAPI?.disconnectSilo(siloName);
    if (result?.success) {
      navigate('/');
    } else {
      setDisconnecting(false);
    }
  }

  async function handleFolderIgnoreChange(patterns: string[]) {
    setFolderIgnore(patterns);
    await window.electronAPI?.updateSilo(siloName, { ignore: patterns });
    fetchSilo();
  }

  async function handleFileIgnoreChange(patterns: string[]) {
    setFileIgnore(patterns);
    await window.electronAPI?.updateSilo(siloName, { ignoreFiles: patterns });
    fetchSilo();
  }

  async function handleIgnoreOverride() {
    setIgnoreOverridden(true);
    const folders = [...defaultFolderIgnore];
    const files   = [...defaultFileIgnore];
    setFolderIgnore(folders);
    setFileIgnore(files);
    await window.electronAPI?.updateSilo(siloName, { ignore: folders, ignoreFiles: files });
    fetchSilo();
  }

  async function handleIgnoreRevert() {
    setIgnoreOverridden(false);
    setFolderIgnore(defaultFolderIgnore);
    setFileIgnore(defaultFileIgnore);
    await window.electronAPI?.updateSilo(siloName, { ignore: [], ignoreFiles: [] });
    fetchSilo();
  }

  async function handleExtensionsChange(exts: string[]) {
    setExtensions(exts);
    await window.electronAPI?.updateSilo(siloName, { extensions: exts });
    fetchSilo();
  }

  async function handleExtensionOverride() {
    setExtensionOverridden(true);
    const exts = [...defaultExtensions];
    setExtensions(exts);
    await window.electronAPI?.updateSilo(siloName, { extensions: exts });
    fetchSilo();
  }

  async function handleExtensionRevert() {
    setExtensionOverridden(false);
    setExtensions(defaultExtensions);
    await window.electronAPI?.updateSilo(siloName, { extensions: [] });
    fetchSilo();
  }

  async function handleColorChange(newColor: SiloColor) {
    setSiloColor(newColor);
    await window.electronAPI?.updateSilo(siloName, { color: newColor });
  }

  async function handleIconChange(newIcon: SiloIconName) {
    setSiloIcon(newIcon);
    await window.electronAPI?.updateSilo(siloName, { icon: newIcon });
  }

  // ── Loading state ────────────────────────────────────────────────────────────

  if (!silo) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // ── Derived values ───────────────────────────────────────────────────────────

  const { config } = silo;
  const colorClasses  = SILO_COLOR_MAP[siloColor];
  const isActive      = silo.watcherState === 'indexing';
  const isStopped     = silo.watcherState === 'stopped';
  const isWaiting     = silo.watcherState === 'waiting';
  const defaultModel  = serverStatus?.defaultModel ?? 'snowflake-arctic-embed-xs';
  const effectiveModel = selectedModel || config.modelOverride || defaultModel;
  const isOverride    = effectiveModel !== defaultModel;
  const modelOptions  = serverStatus?.availableModels ?? [];
  const progress      = silo.reconcileProgress;
  const progressPctRaw = progress && progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : null;
  const progressPct = progressPctRaw !== null ? Math.min(progressPctRaw, 99) : null;

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="p-6">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="mb-6 flex items-start justify-between gap-4">

        {/* Left: breadcrumb + title */}
        <div className="flex flex-col gap-1.5 min-w-0">
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors w-fit"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Silos
          </button>

          <div className="flex items-center gap-2">
            <SiloIcon icon={siloIcon} className={cn('h-5 w-5 shrink-0', colorClasses.text)} />
            {isEditingName ? (
              <div className="flex items-center gap-1.5">
                <input
                  autoFocus
                  value={editName}
                  onChange={(e) => { setEditName(e.target.value); setRenameError(null); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRename();
                    if (e.key === 'Escape') { setIsEditingName(false); setRenameError(null); }
                  }}
                  className="h-7 rounded border border-input bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring w-40"
                />
                <button onClick={handleRename} disabled={isRenaming} className="p-1 rounded text-emerald-400 hover:bg-emerald-400/10 disabled:opacity-50" title="Save">
                  <Check className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => { setIsEditingName(false); setRenameError(null); }} className="p-1 rounded text-muted-foreground hover:bg-muted" title="Cancel">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <div className="group flex items-center gap-1.5">
                <h1 className="text-lg font-semibold text-foreground">{siloName}</h1>
                <button
                  onClick={() => { setEditName(siloName); setIsEditingName(true); }}
                  className="p-1 rounded text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Rename silo"
                >
                  <Pencil className="h-3 w-3" />
                </button>
              </div>
            )}
          </div>

          {renameError && <p className="text-xs text-red-400">{renameError}</p>}
          {config.description && (
            <p className="text-sm text-muted-foreground">{config.description}</p>
          )}
        </div>

        {/* Right: status badge + action buttons */}
        <div className="flex items-center gap-2 shrink-0 pt-6">
          <Badge
            variant={isActive ? 'default' : silo.watcherState === 'error' ? 'destructive' : 'secondary'}
            className="gap-1.5 whitespace-nowrap"
          >
            <span className={cn('inline-block h-1.5 w-1.5 rounded-full', {
              'bg-emerald-500':            silo.watcherState === 'ready',
              'bg-amber-500 animate-pulse': isActive,
              'bg-red-500':                silo.watcherState === 'error',
              'bg-blue-400':               isStopped,
              'bg-gray-400 animate-pulse': isWaiting,
            })} />
            {isActive && progressPct !== null
              ? (progress?.fileStage === 'compacting' ? 'Compacting…'
                : progress?.fileStage === 'flushing' ? 'Saving…'
                : `Indexing ${progressPct}%`)
              : silo.watcherState.charAt(0).toUpperCase() + silo.watcherState.slice(1)}
          </Badge>

          {silo.watcherState !== 'waiting' && !isWaking && (
            <Button variant="outline" size="sm" disabled={isStopping} onClick={handleStopToggle}>
              {isStopping
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Stopping…</>
                : isStopped
                  ? <><Play className="h-3.5 w-3.5" /> Wake</>
                  : <><Pause className="h-3.5 w-3.5" /> Stop</>}
            </Button>
          )}

          <Button variant="outline" size="sm" onClick={handleRebuild} disabled={rebuilding}>
            <RotateCcw className={cn('h-3.5 w-3.5', rebuilding && 'animate-spin')} />
            Rebuild Index
          </Button>
        </div>
      </div>

      {/* ── Model mismatch warning ───────────────────────────────────────────── */}
      {silo.modelMismatch && (
        <div className="mb-6 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" />
          <div>
            <p className="text-sm text-foreground">Model mismatch detected</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              The index was built with a different embedding model. Search results may be inaccurate.
              Click &ldquo;Rebuild Index&rdquo; to re-index with the current model.
            </p>
          </div>
        </div>
      )}

      {/* ── Stats grid ──────────────────────────────────────────────────────── */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat icon={FileText} label="Files"   value={silo.indexedFileCount.toLocaleString()} />
        <Stat icon={Blocks}   label="Chunks"  value={silo.chunkCount.toLocaleString()} />
        <Stat                 label="DB Size" value={isActive ? `~${formatBytes(silo.databaseSizeBytes)}` : formatBytes(silo.databaseSizeBytes)} />
        <Stat                 label="Updated" value={formatTime(silo.lastUpdated)} />
      </div>

      {/* Progress bar (shown while indexing) */}
      {isActive && progress && progress.total > 0 && (
        <div className="mb-6 flex flex-col gap-1">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-amber-500 transition-[width] duration-300"
              style={{ width: `${progressPct ?? 0}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
            <span>
              {progress.current.toLocaleString()} / {progress.total.toLocaleString()} files
            </span>
            {progress.fileStage === 'embedding' && progress.embedTotal != null && progress.embedTotal > 0 && (
              <span className="text-muted-foreground/60">
                Embedding {progress.embedDone?.toLocaleString()}/{progress.embedTotal.toLocaleString()} chunks
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── Configuration ───────────────────────────────────────────────────── */}
      <section className="mb-6">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Configuration
        </h2>
        <div className="flex flex-col gap-3 text-sm">
          <Row label="Description">
            <textarea
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              onBlur={() => {
                if (editDescription !== (config.description || '')) {
                  window.electronAPI?.updateSilo(siloName, { description: editDescription });
                }
              }}
              placeholder="Describe what this silo contains..."
              rows={2}
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring resize-none"
            />
          </Row>
          <Row label="Appearance">
            <SiloAppearancePicker
              color={siloColor}
              icon={siloIcon}
              onColorChange={handleColorChange}
              onIconChange={handleIconChange}
            />
          </Row>
          <Row label="Model">
            <div className="flex flex-col gap-1.5">
              <select
                value={effectiveModel}
                onChange={(e) => handleModelChange(e.target.value)}
                className={cn(
                  'h-7 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground',
                  'focus:outline-none focus:ring-1 focus:ring-ring',
                  isOverride && 'border-amber-500/40',
                )}
              >
                {modelOptions.map((m) => {
                  const id = modelIdFromDisplay(m);
                  return (
                    <option key={m} value={id}>
                      {m}{id === defaultModel ? ' (default)' : ''}
                    </option>
                  );
                })}
              </select>
              {isOverride && (
                <div className="flex items-center gap-1.5">
                  <Badge variant="outline" className="text-[10px] text-amber-400 border-amber-500/30">
                    override
                  </Badge>
                  <button
                    onClick={() => handleModelChange(defaultModel)}
                    className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Reset to default
                  </button>
                </div>
              )}
            </div>
          </Row>
          <Row label="Extensions">
            <ExtensionPicker
              extensions={extensions}
              onChange={handleExtensionsChange}
              inherited
              isOverridden={extensionOverridden}
              onOverride={handleExtensionOverride}
              onRevertToDefaults={handleExtensionRevert}
            />
          </Row>
          <Row label="Ignore">
            <IgnorePatternsEditor
              folderPatterns={folderIgnore}
              filePatterns={fileIgnore}
              onFolderPatternsChange={handleFolderIgnoreChange}
              onFilePatternsChange={handleFileIgnoreChange}
              inherited
              isOverridden={ignoreOverridden}
              onOverride={handleIgnoreOverride}
              onRevertToDefaults={handleIgnoreRevert}
            />
          </Row>
          <Row label="Directories">
            <div className="flex flex-col gap-1">
              {config.directories.map((dir) => (
                <span key={dir} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <FolderOpen className="h-3 w-3 shrink-0" />
                  {abbreviatePath(dir)}
                </span>
              ))}
            </div>
          </Row>
          <Row label="Database">
            <div className="flex items-center gap-2">
              <HardDrive className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="text-xs text-muted-foreground font-mono truncate" title={silo.resolvedDbPath}>
                {abbreviatePath(silo.resolvedDbPath)}
              </span>
              <button
                onClick={() => {
                  const dir = silo.resolvedDbPath.replace(/[/\\][^/\\]+$/, '');
                  window.electronAPI?.openPath(dir);
                }}
                className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                title="Reveal in file manager"
              >
                <FolderOpen className="h-3 w-3" />
              </button>
            </div>
          </Row>
        </div>
      </section>

      {/* ── Recent activity ─────────────────────────────────────────────────── */}
      <section className="mb-6">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Recent Activity
        </h2>
        <ActivityFeed siloName={siloName} limit={100} />
      </section>

      {/* ── Danger zone ─────────────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Danger Zone
        </h2>
        <div className="flex flex-col gap-3">

          {/* Disconnect */}
          {!confirmDisconnect ? (
            <div className="flex items-center gap-3">
              <Button variant="outline" size="sm" onClick={() => setConfirmDisconnect(true)} disabled={isActive}>
                <Unplug className="h-3.5 w-3.5" /> Disconnect
              </Button>
              <span className="text-xs text-muted-foreground">
                Remove from Lodestone but keep the database file on disk.
              </span>
            </div>
          ) : (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-4">
              <p className="text-sm text-foreground">
                Disconnect <span className="font-semibold">{config.name}</span>?
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                This will remove the silo from Lodestone but keep the database file on disk.
                You can reconnect it later using &ldquo;Connect existing database&rdquo; when creating a new silo.
              </p>
              <div className="mt-3 flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setConfirmDisconnect(false)} disabled={disconnecting} autoFocus>
                  Cancel
                </Button>
                <Button variant="outline" size="sm" onClick={handleDisconnect} disabled={disconnecting}>
                  <Unplug className="h-3.5 w-3.5" />
                  {disconnecting ? 'Disconnecting…' : 'Disconnect'}
                </Button>
              </div>
            </div>
          )}

          {/* Delete */}
          {!confirmDelete ? (
            <div className="flex items-center gap-3">
              <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)} disabled={isActive}>
                <Trash2 className="h-3.5 w-3.5" /> Delete Silo
              </Button>
              <span className="text-xs text-muted-foreground">
                Permanently remove the silo and delete the database from disk.
              </span>
            </div>
          ) : (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 p-4">
              <p className="text-sm text-foreground">
                Permanently delete <span className="font-semibold">{config.name}</span>?
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                This will remove the silo configuration, stop the file watcher, and delete the
                vector database from disk. This action cannot be undone.
              </p>
              {deleteError && <p className="mt-2 text-xs text-red-400">{deleteError}</p>}
              <div className="mt-3 flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setConfirmDelete(false)} disabled={deleting} autoFocus>
                  Cancel
                </Button>
                <Button variant="destructive" size="sm" onClick={handleDelete} disabled={deleting}>
                  <Trash2 className="h-3.5 w-3.5" />
                  {deleting ? 'Deleting…' : 'Delete'}
                </Button>
              </div>
            </div>
          )}

        </div>
      </section>
    </div>
  );
}

// ── Small layout helpers ───────────────────────────────────────────────────────

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-md border border-border bg-background px-3 py-2">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </div>
      <div className="mt-0.5 text-sm font-medium text-foreground">{value}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-20 shrink-0 text-xs text-muted-foreground">{label}</span>
      <div className="flex-1 text-foreground">{children}</div>
    </div>
  );
}
