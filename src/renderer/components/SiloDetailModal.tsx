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
import { FileText, Blocks, FolderOpen, RotateCcw, Trash2, AlertCircle, AlertTriangle, Pause, Play, HardDrive, Unplug, Pencil, Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useState, useEffect } from 'react';
import IgnorePatternsEditor from './IgnorePatternsEditor';
import ExtensionPicker from './ExtensionPicker';
import SiloAppearancePicker from './SiloAppearancePicker';
import SiloIcon from './SiloIconComponent';
import { SILO_COLOR_MAP, type SiloColor, type SiloIconName } from '../../shared/silo-appearance';
import type { SiloStatus, ActivityEvent, ServerStatus, DefaultSettings } from '../../shared/types';

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

function fileName(p: string): string {
  return p.split(/[/\\]/).pop() ?? p;
}

/**
 * Extract the model ID from a display string like "snowflake-arctic-embed-xs — Arctic Embed XS (22MB, 384-dim)".
 * Returns just the model ID portion before the " — " separator.
 */
function modelIdFromDisplay(display: string): string {
  return display.split(' — ')[0].trim();
}

const eventTypeStyles: Record<string, string> = {
  indexed: 'text-emerald-400',
  reindexed: 'text-blue-400',
  deleted: 'text-muted-foreground',
  error: 'text-red-400',
};

interface SiloDetailModalProps {
  silo: SiloStatus | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
  onStopToggle?: () => void;
  onRebuilt?: () => void;
  /** Called after any update so the parent can refresh silo list */
  onUpdated?: () => void;
}

export default function SiloDetailModal({ silo, open, onOpenChange, onDeleted, onStopToggle, onRebuilt, onUpdated }: SiloDetailModalProps) {
  const [siloEvents, setSiloEvents] = useState<ActivityEvent[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [editDescription, setEditDescription] = useState('');

  // Rename state
  const [siloName, setSiloName] = useState('');
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);

  // Model selector state
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [selectedModel, setSelectedModel] = useState('');

  // Ignore patterns state
  const [folderIgnore, setFolderIgnore] = useState<string[]>([]);
  const [fileIgnore, setFileIgnore] = useState<string[]>([]);
  const [ignoreOverridden, setIgnoreOverridden] = useState(false);
  const [defaultFolderIgnore, setDefaultFolderIgnore] = useState<string[]>([]);
  const [defaultFileIgnore, setDefaultFileIgnore] = useState<string[]>([]);

  // Extension state
  const [extensions, setExtensions] = useState<string[]>([]);
  const [extensionOverridden, setExtensionOverridden] = useState(false);
  const [defaultExtensions, setDefaultExtensions] = useState<string[]>([]);

  // Appearance state
  const [siloColor, setSiloColor] = useState<SiloColor>('blue');
  const [siloIcon, setSiloIcon] = useState<SiloIconName>('database');

  // Sync description and model from silo prop when modal opens
  useEffect(() => {
    if (open && silo) {
      setSiloName(silo.config.name);
      setIsEditingName(false);
      setEditName('');
      setRenameError(null);
      setEditDescription(silo.config.description || '');

      // Fetch server status for model list
      window.electronAPI?.getServerStatus().then((status) => {
        setServerStatus(status);
        // Set the current effective model as the selected value
        const effective = silo.config.modelOverride ?? status.defaultModel;
        setSelectedModel(effective);
      });

      // Load defaults for inheritance
      window.electronAPI?.getDefaults().then((d) => {
        setDefaultFolderIgnore(d.ignore);
        setDefaultFileIgnore(d.ignoreFiles);
        setDefaultExtensions(d.extensions);
      });

      // Set current ignore patterns
      setFolderIgnore(silo.config.ignorePatterns);
      setFileIgnore(silo.config.ignoreFilePatterns);
      setIgnoreOverridden(silo.config.hasIgnoreOverride || silo.config.hasFileIgnoreOverride);

      // Set current extensions
      setExtensions(silo.config.extensions);
      setExtensionOverridden(silo.config.hasExtensionOverride);

      // Set current appearance
      setSiloColor(silo.config.color);
      setSiloIcon(silo.config.icon);
    }
  }, [open, silo]);

  useEffect(() => {
    if (open && silo) {
      window.electronAPI?.getActivity(100).then((events) => {
        setSiloEvents(events.filter((e) => e.siloName === silo.config.name).slice(0, 8));
      });
    }
    if (!open) {
      setConfirmDelete(false);
      setDeleting(false);
      setDeleteError(null);
      setConfirmDisconnect(false);
      setDisconnecting(false);
    }
  }, [open, silo]);

  async function handleRename() {
    if (!silo || !editName.trim() || isRenaming) return;
    setIsRenaming(true);
    setRenameError(null);
    try {
      const result = await window.electronAPI?.renameSilo(siloName, editName.trim());
      if (result?.success) {
        const newSlug = editName.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
        setSiloName(newSlug);
        setIsEditingName(false);
        onUpdated?.();
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
    if (!silo) return;
    setSelectedModel(newModel);
    await window.electronAPI?.updateSilo(siloName, { model: newModel });
    // Refresh silo list so mismatch status updates
    onUpdated?.();
  }

  async function handleRebuild() {
    if (!silo) return;
    setRebuilding(true);
    try {
      const result = await window.electronAPI?.rebuildSilo(siloName);
      if (result?.success) {
        onOpenChange(false);
        onRebuilt?.();
      }
    } catch (err) {
      console.error('Rebuild failed:', err);
    } finally {
      setRebuilding(false);
    }
  }

  async function handleDelete() {
    if (!silo) return;
    setDeleting(true);
    setDeleteError(null);
    const result = await window.electronAPI?.deleteSilo(siloName);
    if (result?.success) {
      onOpenChange(false);
      onDeleted?.();
    } else {
      setDeleteError(result?.error ?? 'Failed to delete silo');
      setDeleting(false);
    }
  }

  async function handleDisconnect() {
    if (!silo) return;
    setDisconnecting(true);
    const result = await window.electronAPI?.disconnectSilo(siloName);
    if (result?.success) {
      onOpenChange(false);
      onDeleted?.();
    } else {
      setDisconnecting(false);
    }
  }

  async function handleFolderIgnoreChange(patterns: string[]) {
    if (!silo) return;
    setFolderIgnore(patterns);
    await window.electronAPI?.updateSilo(siloName, { ignore: patterns });
    onUpdated?.();
  }

  async function handleFileIgnoreChange(patterns: string[]) {
    if (!silo) return;
    setFileIgnore(patterns);
    await window.electronAPI?.updateSilo(siloName, { ignoreFiles: patterns });
    onUpdated?.();
  }

  async function handleIgnoreOverride() {
    setIgnoreOverridden(true);
    // Copy defaults as starting point for customization
    const folders = [...defaultFolderIgnore];
    const files = [...defaultFileIgnore];
    setFolderIgnore(folders);
    setFileIgnore(files);
    if (silo) {
      await window.electronAPI?.updateSilo(siloName, { ignore: folders, ignoreFiles: files });
      onUpdated?.();
    }
  }

  async function handleIgnoreRevert() {
    setIgnoreOverridden(false);
    setFolderIgnore(defaultFolderIgnore);
    setFileIgnore(defaultFileIgnore);
    if (silo) {
      // Empty arrays signal "revert to defaults"
      await window.electronAPI?.updateSilo(siloName, { ignore: [], ignoreFiles: [] });
      onUpdated?.();
    }
  }

  async function handleExtensionsChange(exts: string[]) {
    if (!silo) return;
    setExtensions(exts);
    await window.electronAPI?.updateSilo(siloName, { extensions: exts });
    onUpdated?.();
  }

  async function handleExtensionOverride() {
    setExtensionOverridden(true);
    const exts = [...defaultExtensions];
    setExtensions(exts);
    if (silo) {
      await window.electronAPI?.updateSilo(siloName, { extensions: exts });
      onUpdated?.();
    }
  }

  async function handleExtensionRevert() {
    setExtensionOverridden(false);
    setExtensions(defaultExtensions);
    if (silo) {
      // Empty array signals "revert to defaults"
      await window.electronAPI?.updateSilo(siloName, { extensions: [] });
      onUpdated?.();
    }
  }

  async function handleColorChange(newColor: SiloColor) {
    if (!silo) return;
    setSiloColor(newColor);
    await window.electronAPI?.updateSilo(siloName, { color: newColor });
    onUpdated?.();
  }

  async function handleIconChange(newIcon: SiloIconName) {
    if (!silo) return;
    setSiloIcon(newIcon);
    await window.electronAPI?.updateSilo(siloName, { icon: newIcon });
    onUpdated?.();
  }

  if (!silo) return null;

  const { config } = silo;
  const colorClasses = SILO_COLOR_MAP[siloColor];
  // Disable destructive actions while the silo is actively indexing.
  // The user must stop the silo first — stop() is always clean and safe.
  const isActive = silo.watcherState === 'indexing';
  const defaultModel = serverStatus?.defaultModel ?? 'snowflake-arctic-embed-xs';
  const effectiveModel = selectedModel || config.modelOverride || defaultModel;
  const isOverride = effectiveModel !== defaultModel;

  // Build model options from server status
  // Each entry in availableModels is like "model-id — Display Name"
  const modelOptions = serverStatus?.availableModels ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SiloIcon icon={siloIcon} className={cn('h-5 w-5', colorClasses.text)} />
            {isEditingName ? (
              <div className="flex items-center gap-1.5 min-w-0">
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
                <button
                  onClick={handleRename}
                  disabled={isRenaming}
                  className="p-1 rounded text-emerald-400 hover:bg-emerald-400/10 disabled:opacity-50"
                  title="Save"
                >
                  <Check className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => { setIsEditingName(false); setRenameError(null); }}
                  className="p-1 rounded text-muted-foreground hover:bg-muted"
                  title="Cancel"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <div className="group flex items-center gap-1.5">
                <span>{siloName}</span>
                <button
                  onClick={() => { setEditName(siloName); setIsEditingName(true); }}
                  className="p-1 rounded text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Rename silo"
                >
                  <Pencil className="h-3 w-3" />
                </button>
              </div>
            )}
          </DialogTitle>
          {renameError && (
            <p className="text-xs text-red-400 mt-1">{renameError}</p>
          )}
          <DialogDescription>Silo configuration and indexing statistics.</DialogDescription>
        </DialogHeader>

        {/* Model mismatch warning */}
        {silo.modelMismatch && (
          <div className="mt-4 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
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

        {/* Stats grid */}
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat icon={FileText} label="Files" value={silo.indexedFileCount.toLocaleString()} />
          <Stat icon={Blocks} label="Chunks" value={silo.chunkCount.toLocaleString()} />
          <Stat label="DB Size" value={isActive ? `~${formatBytes(silo.databaseSizeBytes)}` : formatBytes(silo.databaseSizeBytes)} />
          <Stat label="Updated" value={formatTime(silo.lastUpdated)} />
        </div>

        {/* Configuration */}
        <section className="mt-5">
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Configuration
          </h4>
          <div className="flex flex-col gap-2 text-sm">
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
                    const isDefault = id === defaultModel;
                    return (
                      <option key={m} value={id}>
                        {m}{isDefault ? ' (default)' : ''}
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
                    // Open the folder containing the DB file
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

        {/* Recent activity */}
        <section className="mt-5">
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Recent Activity
          </h4>
          {siloEvents.length === 0 ? (
            <p className="text-xs text-muted-foreground">No recent activity.</p>
          ) : (
            <div className="flex flex-col gap-1">
              {siloEvents.map((event) => (
                <div
                  key={event.id}
                  className="flex items-center gap-2 text-xs"
                >
                  <span className="w-12 shrink-0 text-muted-foreground/60">
                    {formatTime(event.timestamp)}
                  </span>
                  <span className={cn('w-16 shrink-0 capitalize', eventTypeStyles[event.eventType])}>
                    {event.eventType === 'reindexed' ? 're-indexed' : event.eventType}
                  </span>
                  <span className="truncate text-muted-foreground" title={event.filePath}>
                    {fileName(event.filePath)}
                  </span>
                  {event.eventType === 'error' && (
                    <AlertCircle className="h-3 w-3 shrink-0 text-red-400" />
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Disconnect confirmation */}
        {confirmDisconnect && (
          <div className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/5 p-4">
            <p className="text-sm text-foreground">
              Disconnect <span className="font-semibold">{config.name}</span>?
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              This will remove the silo from Lodestone but keep the database file on disk.
              You can reconnect it later using &ldquo;Connect existing database&rdquo; when creating a new silo.
            </p>
            <div className="mt-3 flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmDisconnect(false)}
                disabled={disconnecting}
                autoFocus
              >
                Cancel
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleDisconnect}
                disabled={disconnecting}
              >
                <Unplug className="h-3.5 w-3.5" />
                {disconnecting ? 'Disconnecting…' : 'Disconnect'}
              </Button>
            </div>
          </div>
        )}

        {/* Delete confirmation */}
        {confirmDelete && (
          <div className="mt-4 rounded-md border border-red-500/30 bg-red-500/5 p-4">
            <p className="text-sm text-foreground">
              Permanently delete <span className="font-semibold">{config.name}</span>?
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              This will remove the silo configuration, stop the file watcher, and delete the
              vector database from disk. This action cannot be undone.
            </p>
            {deleteError && (
              <p className="mt-2 text-xs text-red-400">{deleteError}</p>
            )}
            <div className="mt-3 flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
                autoFocus
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDelete}
                disabled={deleting}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {deleting ? 'Deleting…' : 'Delete'}
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          {onStopToggle && silo.watcherState !== 'waiting' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => { onStopToggle(); onOpenChange(false); }}
            >
              {silo.watcherState === 'stopped'
                ? <><Play className="h-3.5 w-3.5" /> Wake</>
                : <><Pause className="h-3.5 w-3.5" /> Stop</>
              }
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handleRebuild}
            disabled={rebuilding}
          >
            <RotateCcw className={cn('h-3.5 w-3.5', rebuilding && 'animate-spin')} />
            Rebuild Index
          </Button>
          {!confirmDelete && !confirmDisconnect && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmDisconnect(true)}
              disabled={isActive}
              title={isActive ? 'Stop the silo before disconnecting' : undefined}
            >
              <Unplug className="h-3.5 w-3.5" />
              Disconnect
            </Button>
          )}
          {!confirmDelete && !confirmDisconnect && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setConfirmDelete(true)}
              disabled={isActive}
              title={isActive ? 'Stop the silo before deleting' : undefined}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete Silo
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Small helpers ─────────────────────────────────────────────────────────────

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
