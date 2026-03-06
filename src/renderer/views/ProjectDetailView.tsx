import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ChevronLeft, Loader2, AlertCircle, Trash2, Merge } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SILO_COLORS, SILO_COLOR_MAP, type SiloColor } from '../../shared/silo-appearance';
import type { ProjectWithCounts } from '../../shared/types';

export default function ProjectDetailView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [project, setProject] = useState<ProjectWithCounts | null>(null);
  const [allProjects, setAllProjects] = useState<ProjectWithCounts[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState<number | null>(null);

  const loadProject = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI?.listProjects();
      if (!result?.success) { setError(result?.error ?? 'Failed to load projects'); return; }
      const projects = (result.projects ?? []) as ProjectWithCounts[];
      setAllProjects(projects);
      const found = projects.find(p => p.id === parseInt(id, 10));
      if (!found) { setError('Project not found'); return; }
      setProject(found);
      setNameValue(found.name);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { loadProject(); }, [loadProject]);

  async function handleRename() {
    setIsEditingName(false);
    const trimmed = nameValue.trim();
    if (!trimmed || !project || trimmed === project.name) {
      if (project) setNameValue(project.name);
      return;
    }
    await window.electronAPI?.updateProject(project.id, { name: trimmed });
    loadProject();
  }

  async function handleColorChange(color: SiloColor) {
    if (!project) return;
    setProject({ ...project, color });
    await window.electronAPI?.updateProject(project.id, { color });
  }

  async function handleDelete() {
    if (!project) return;
    await window.electronAPI?.deleteProject(project.id);
    navigate('/tasks');
  }

  async function handleMerge() {
    if (!project || !mergeTargetId) return;
    await window.electronAPI?.mergeProjects(project.id, mergeTargetId);
    navigate('/tasks');
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-6 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading…
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="px-6 py-8">
        <button
          onClick={() => navigate('/tasks')}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mb-4"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Tasks
        </button>
        <div className="flex items-center gap-2 text-sm text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error ?? 'Project not found'}
        </div>
      </div>
    );
  }

  const total = project.openCount + project.completedCount;
  const pct = total > 0 ? Math.round((project.completedCount / total) * 100) : 0;
  const colorMap = SILO_COLOR_MAP[project.color as SiloColor];
  const mergeTargets = allProjects.filter(p => p.id !== project.id);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 pt-6 pb-4 shrink-0">
        <button
          onClick={() => navigate('/tasks')}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mb-5"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Tasks
        </button>

        {/* Name */}
        <div className="mb-4 max-w-2xl">
          {isEditingName ? (
            <input
              autoFocus
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onBlur={handleRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRename();
                if (e.key === 'Escape') { setIsEditingName(false); setNameValue(project.name); }
              }}
              className="w-full bg-transparent text-xl font-semibold text-foreground border-b border-ring focus:outline-none leading-snug"
            />
          ) : (
            <h1
              onClick={() => setIsEditingName(true)}
              className="text-xl font-semibold text-foreground leading-snug cursor-text flex items-center gap-2"
            >
              <span className={cn('h-3 w-3 rounded-full shrink-0', colorMap?.dot ?? 'bg-blue-500')} />
              {project.name}
            </h1>
          )}
        </div>

        {/* Stats */}
        <div className="flex items-center gap-4 mb-6">
          <span className="text-sm text-muted-foreground">
            {project.openCount} open
          </span>
          <span className="text-sm text-muted-foreground">
            {project.completedCount} completed
          </span>
          <span className="text-sm text-muted-foreground">
            {total} total
          </span>
          {total > 0 && (
            <div className="flex items-center gap-2">
              <div className="w-24 h-1.5 rounded-full bg-border/40 overflow-hidden">
                <div
                  className={cn('h-full rounded-full transition-all', colorMap?.dot ?? 'bg-blue-500')}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-xs tabular-nums text-muted-foreground">{pct}%</span>
            </div>
          )}
        </div>

        {/* Colour picker */}
        <div className="mb-6">
          <p className="text-xs text-muted-foreground mb-2">Colour</p>
          <div className="flex items-center gap-1.5 flex-wrap">
            {SILO_COLORS.map((c) => {
              const map = SILO_COLOR_MAP[c];
              return (
                <button
                  key={c}
                  onClick={() => handleColorChange(c)}
                  className={cn(
                    'h-6 w-6 rounded-full transition-all',
                    map.dot,
                    project.color === c
                      ? 'ring-2 ring-offset-2 ring-offset-background ring-foreground/40 scale-110'
                      : 'opacity-60 hover:opacity-100',
                  )}
                />
              );
            })}
          </div>
        </div>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Actions */}
      <div className="px-6 pb-5 shrink-0 border-t border-border/30 space-y-3 pt-4">
        {/* Merge */}
        {mergeTargets.length > 0 && (
          confirmMerge ? (
            <div className="flex items-center gap-3 flex-wrap">
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
                onClick={handleMerge}
                disabled={!mergeTargetId}
                className="text-xs text-amber-400 hover:text-amber-300 transition-colors font-medium disabled:opacity-30"
              >
                Merge ({total} tasks)
              </button>
              <button
                onClick={() => { setConfirmMerge(false); setMergeTargetId(null); }}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmMerge(true)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground/40 hover:text-amber-400 transition-colors"
            >
              <Merge className="h-3.5 w-3.5" />
              Merge into another project
            </button>
          )
        )}

        {/* Delete */}
        {confirmDelete ? (
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              Delete this project? {total > 0 ? `${total} tasks will become unassigned.` : ''}
            </span>
            <button
              onClick={handleDelete}
              className="text-xs text-red-400 hover:text-red-300 transition-colors font-medium"
            >
              Yes, delete
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground/40 hover:text-red-400 transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete project
          </button>
        )}
      </div>
    </div>
  );
}
