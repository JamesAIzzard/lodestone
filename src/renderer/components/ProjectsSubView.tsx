import { useState, useEffect, useRef } from 'react';
import { Folder, Trash2, Merge, Archive } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useClickOutside } from '@/hooks/use-click-outside';
import { ArchivedProjectSearch } from '@/components/ProjectFilters';
import { SILO_COLORS, SILO_COLOR_MAP, type SiloColor } from '../../shared/silo-appearance';
import type { ProjectWithCounts } from '../../shared/types';

export default function ProjectsSubView({
  projects,
  onRefresh,
  createTrigger = 0,
}: {
  projects: ProjectWithCounts[];
  onRefresh: () => void;
  createTrigger?: number;
}) {
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [openColorId, setOpenColorId] = useState<number | null>(null);
  const [editingNameId, setEditingNameId] = useState<number | null>(null);
  const [editingNameValue, setEditingNameValue] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [confirmMergeId, setConfirmMergeId] = useState<number | null>(null);
  const [confirmArchiveId, setConfirmArchiveId] = useState<number | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState<number | null>(null);
  const colorPopoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (createTrigger > 0) { setIsCreating(true); setNewName(''); }
  }, [createTrigger]);

  // Close color popover on outside click
  useClickOutside(colorPopoverRef, () => setOpenColorId(null), openColorId !== null);

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    setIsCreating(false);
    setNewName('');
    await window.electronAPI?.createProject(name);
    onRefresh();
  }

  async function handleColorChange(id: number, color: SiloColor) {
    setOpenColorId(null);
    await window.electronAPI?.updateProject(id, { color });
    onRefresh();
  }

  async function handleRename(project: ProjectWithCounts) {
    setEditingNameId(null);
    const trimmed = editingNameValue.trim();
    if (!trimmed || trimmed === project.name) return;
    await window.electronAPI?.updateProject(project.id, { name: trimmed });
    onRefresh();
  }

  async function handleDelete(id: number) {
    setConfirmDeleteId(null);
    await window.electronAPI?.deleteProject(id);
    onRefresh();
  }

  async function handleMerge(sourceId: number) {
    if (!mergeTargetId) return;
    setConfirmMergeId(null);
    setMergeTargetId(null);
    await window.electronAPI?.mergeProjects(sourceId, mergeTargetId);
    onRefresh();
  }

  async function handleArchive(id: number) {
    setConfirmArchiveId(null);
    await window.electronAPI?.archiveProject(id);
    onRefresh();
  }

  async function handleUnarchive(id: number) {
    await window.electronAPI?.unarchiveProject(id);
    onRefresh();
  }

  return (
    <div>
      <div className="mb-4">
        <p className="text-xs text-muted-foreground">{projects.length} project{projects.length !== 1 ? 's' : ''}</p>
        <div className="mt-2">
          <ArchivedProjectSearch onUnarchive={handleUnarchive} />
        </div>
      </div>

      {isCreating && (
        <div className="flex items-center gap-2 mb-3 p-3 rounded-lg border border-border/50">
          <input
            autoFocus
            placeholder="Project name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreate();
              if (e.key === 'Escape') { setIsCreating(false); setNewName(''); }
            }}
            onBlur={() => { if (!newName.trim()) { setIsCreating(false); setNewName(''); } }}
            className="flex-1 bg-transparent text-sm text-foreground border-b border-ring focus:outline-none placeholder:text-muted-foreground/30"
          />
        </div>
      )}

      {projects.length === 0 && !isCreating && (
        <p className="text-sm text-muted-foreground">No projects yet.</p>
      )}

      <div className="flex flex-col divide-y divide-border/50">
        {projects.map((p) => {
          const total = p.openCount + p.completedCount;
          const pct = total > 0 ? Math.round((p.completedCount / total) * 100) : 0;
          const colorMap = SILO_COLOR_MAP[p.color as SiloColor];
          const isColorOpen = openColorId === p.id;
          const isDeleting = confirmDeleteId === p.id;
          const isMerging = confirmMergeId === p.id;
          const isArchiving = confirmArchiveId === p.id;
          const mergeTargets = projects.filter(q => q.id !== p.id);

          return (
            <div key={p.id} className="group py-3">
              {/* Main row */}
              <div className="flex items-center gap-3">
                {/* Folder icon — opens inline colour picker */}
                <div className="relative" ref={isColorOpen ? colorPopoverRef : undefined}>
                  <button
                    onClick={() => setOpenColorId(isColorOpen ? null : p.id)}
                    title="Change colour"
                    className="p-0.5 rounded transition-colors hover:bg-accent"
                  >
                    <Folder className={cn('h-4 w-4 shrink-0', SILO_COLOR_MAP[p.color as SiloColor]?.text ?? 'text-blue-500')} />
                  </button>
                  {isColorOpen && (
                    <div className="absolute left-0 top-6 z-20 flex items-center gap-1.5 flex-wrap p-2 rounded-lg border border-border bg-popover shadow-lg w-max">
                      {SILO_COLORS.map((c) => {
                        const map = SILO_COLOR_MAP[c];
                        return (
                          <button
                            key={c}
                            onClick={() => handleColorChange(p.id, c)}
                            className={cn(
                              'h-5 w-5 rounded-full transition-all',
                              map.dot,
                              p.color === c
                                ? 'ring-2 ring-offset-2 ring-offset-background ring-foreground/40 scale-110'
                                : 'opacity-60 hover:opacity-100',
                            )}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Name (inline editable) */}
                {editingNameId === p.id ? (
                  <input
                    autoFocus
                    value={editingNameValue}
                    onChange={(e) => setEditingNameValue(e.target.value)}
                    onBlur={() => handleRename(p)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRename(p);
                      if (e.key === 'Escape') { setEditingNameId(null); }
                    }}
                    className="flex-1 min-w-0 bg-transparent text-sm font-medium text-foreground border-b border-ring focus:outline-none"
                  />
                ) : (
                  <span
                    onClick={() => { setEditingNameId(p.id); setEditingNameValue(p.name); }}
                    className="flex-1 min-w-0 text-sm font-medium text-foreground truncate cursor-text"
                  >
                    {p.name}
                  </span>
                )}

                {/* Progress */}
                <div className="flex items-center gap-2 shrink-0">
                  <div className="w-20 h-1.5 rounded-full bg-border/40 overflow-hidden">
                    <div
                      className={cn('h-full rounded-full transition-all', colorMap?.dot ?? 'bg-blue-500')}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-[11px] tabular-nums text-muted-foreground w-16 text-right">
                    {p.completedCount}/{total} done
                  </span>
                </div>

                {/* Action buttons (visible on row hover) */}
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  {mergeTargets.length > 0 && (
                    <button
                      onClick={() => { setConfirmMergeId(p.id); setMergeTargetId(null); setConfirmDeleteId(null); setConfirmArchiveId(null); }}
                      title="Merge into another project"
                      className="p-1 rounded text-muted-foreground/40 hover:text-amber-400 transition-colors"
                    >
                      <Merge className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <button
                    onClick={() => { setConfirmArchiveId(p.id); setConfirmDeleteId(null); setConfirmMergeId(null); }}
                    title="Archive project"
                    className="p-1 rounded text-muted-foreground/40 hover:text-purple-400 transition-colors"
                  >
                    <Archive className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => { setConfirmDeleteId(p.id); setConfirmMergeId(null); setConfirmArchiveId(null); }}
                    title="Delete project"
                    className="p-1 rounded text-muted-foreground/40 hover:text-red-400 transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              {/* Delete confirmation (inline expand) */}
              {isDeleting && (
                <div className="flex items-center gap-3 mt-2 pl-7">
                  <span className="text-xs text-muted-foreground">
                    Delete "{p.name}"?{total > 0 ? ` ${total} task${total !== 1 ? 's' : ''} will become unassigned.` : ''}
                  </span>
                  <button
                    onClick={() => handleDelete(p.id)}
                    className="text-xs text-red-400 hover:text-red-300 transition-colors font-medium"
                  >
                    Yes, delete
                  </button>
                  <button
                    onClick={() => setConfirmDeleteId(null)}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              )}

              {/* Merge confirmation (inline expand) */}
              {isMerging && (
                <div className="flex items-center gap-3 mt-2 pl-7 flex-wrap">
                  <span className="text-xs text-muted-foreground">Merge into:</span>
                  <select
                    value={mergeTargetId ?? ''}
                    onChange={(e) => setMergeTargetId(e.target.value ? parseInt(e.target.value, 10) : null)}
                    className="h-6 rounded border border-border bg-background px-2 text-xs text-foreground"
                  >
                    <option value="">Select project…</option>
                    {mergeTargets.map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => handleMerge(p.id)}
                    disabled={!mergeTargetId}
                    className="text-xs text-amber-400 hover:text-amber-300 transition-colors font-medium disabled:opacity-30"
                  >
                    Merge ({total} tasks)
                  </button>
                  <button
                    onClick={() => { setConfirmMergeId(null); setMergeTargetId(null); }}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              )}

              {/* Archive confirmation (inline expand) */}
              {isArchiving && (
                <div className="flex items-center gap-3 mt-2 pl-7">
                  <span className="text-xs text-muted-foreground">
                    Archive "{p.name}"?{total > 0 ? ' Tasks will be hidden from recall & agenda.' : ''}
                  </span>
                  <button
                    onClick={() => handleArchive(p.id)}
                    className="text-xs text-purple-400 hover:text-purple-300 transition-colors font-medium"
                  >
                    Yes, archive
                  </button>
                  <button
                    onClick={() => setConfirmArchiveId(null)}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

    </div>
  );
}
