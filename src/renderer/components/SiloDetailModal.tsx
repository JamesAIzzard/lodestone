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
import { FileText, Blocks, FolderOpen, RotateCcw, Trash2, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useState, useEffect } from 'react';
import type { SiloStatus, ActivityEvent } from '../../shared/types';

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
}

export default function SiloDetailModal({ silo, open, onOpenChange, onDeleted }: SiloDetailModalProps) {
  const [siloEvents, setSiloEvents] = useState<ActivityEvent[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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
    }
  }, [open, silo]);

  async function handleDelete() {
    if (!silo) return;
    setDeleting(true);
    setDeleteError(null);
    const result = await window.electronAPI?.deleteSilo(silo.config.name);
    if (result?.success) {
      onOpenChange(false);
      onDeleted?.();
    } else {
      setDeleteError(result?.error ?? 'Failed to delete silo');
      setDeleting(false);
    }
  }

  if (!silo) return null;

  const { config } = silo;
  const model = config.modelOverride ?? 'built-in';
  const isOverride = config.modelOverride !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{config.name}</DialogTitle>
          <DialogDescription>Silo configuration and indexing statistics.</DialogDescription>
        </DialogHeader>

        {/* Stats grid */}
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat icon={FileText} label="Files" value={silo.indexedFileCount.toLocaleString()} />
          <Stat icon={Blocks} label="Chunks" value={silo.chunkCount.toLocaleString()} />
          <Stat label="DB Size" value={formatBytes(silo.databaseSizeBytes)} />
          <Stat label="Updated" value={formatTime(silo.lastUpdated)} />
        </div>

        {/* Configuration */}
        <section className="mt-5">
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Configuration
          </h4>
          <div className="flex flex-col gap-2 text-sm">
            <Row label="Model">
              <span className={cn(isOverride && 'text-amber-400')}>{model}</span>
              {isOverride && (
                <Badge variant="outline" className="ml-2 text-[10px]">
                  override
                </Badge>
              )}
            </Row>
            <Row label="Extensions">
              <div className="flex flex-wrap gap-1">
                {config.extensions.map((ext) => (
                  <Badge key={ext} variant="secondary" className="text-[10px]">
                    {ext}
                  </Badge>
                ))}
              </div>
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
          <Button variant="outline" size="sm" onClick={() => alert('Rebuild triggered (mock)')}>
            <RotateCcw className="h-3.5 w-3.5" />
            Rebuild Index
          </Button>
          {!confirmDelete && (
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
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
      <div className="text-foreground">{children}</div>
    </div>
  );
}
