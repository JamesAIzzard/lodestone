import { useState, useEffect, useRef } from 'react';
import { Folder, FolderOpen, Archive, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fuzzyScore } from '@/lib/fuzzy';
import { useClickOutside } from '@/hooks/use-click-outside';
import { SILO_COLOR_MAP, type SiloColor } from '../../shared/silo-appearance';
import type { ProjectWithCounts } from '../../shared/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

export function projectIcon(color: string, size = 'h-3.5 w-3.5') {
  const mapping = SILO_COLOR_MAP[color as SiloColor];
  return <Folder className={cn(size, 'shrink-0', mapping?.text ?? 'text-muted-foreground/40')} />;
}

// ── Project search filter (multi-select with pills) ──────────────────────────

export function ProjectSearchFilter({
  projects,
  selectedIds,
  onChange,
}: {
  projects: ProjectWithCounts[];
  selectedIds: number[];
  onChange: (ids: number[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useClickOutside(containerRef, () => setFocused(false), focused);

  // Fuzzy search: score unselected projects and keep close matches
  const q = query.trim();
  const unselected = projects.filter(p => !selectedIds.includes(p.id));
  const suggestions = q
    ? unselected
        .map(p => ({ ...p, dist: fuzzyScore(q, p.name) }))
        .filter(p => p.dist <= Math.max(2, Math.ceil(q.length * 0.4)))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 8)
    : unselected.slice(0, 8);

  const showDropdown = focused && (suggestions.length > 0 || q);

  function addProject(id: number) {
    onChange([...selectedIds, id]);
    setQuery('');
    inputRef.current?.focus();
  }

  function removeProject(id: number) {
    onChange(selectedIds.filter(x => x !== id));
  }

  const selectedProjects = selectedIds.map(id => projects.find(p => p.id === id)).filter(Boolean) as ProjectWithCounts[];

  if (selectedIds.length === 0 && !focused) {
    // Collapsed state: styled to align with the DateRangeFilter button above (same px-2 + border)
    return (
      <button
        onClick={() => { setFocused(true); setTimeout(() => inputRef.current?.focus(), 0); }}
        className="flex items-center gap-1.5 h-6 px-2 rounded-md border border-transparent text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors"
      >
        <FolderOpen className="h-3 w-3" />
        Filter by project…
      </button>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-1.5 flex-wrap min-h-[26px] pl-2">
        {/* Selected pills */}
        {selectedProjects.map(p => {
          const colorMap = SILO_COLOR_MAP[p.color as SiloColor];
          return (
            <span
              key={p.id}
              className={cn(
                'inline-flex items-center gap-1 h-[22px] pl-1.5 pr-1 rounded-full text-[11px] font-medium border transition-colors',
                colorMap?.bgSoft ?? 'bg-muted',
                colorMap?.border ?? 'border-border/50',
                colorMap?.text ?? 'text-foreground',
              )}
            >
              {projectIcon(p.color, 'h-3 w-3')}
              <span className="max-w-[100px] truncate">{p.name}</span>
              <button
                onClick={(e) => { e.stopPropagation(); removeProject(p.id); }}
                className="h-3.5 w-3.5 flex items-center justify-center rounded-full hover:bg-foreground/10 transition-colors ml-0.5"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          );
        })}

        {/* Search input */}
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setQuery(''); setFocused(false); inputRef.current?.blur(); }
            if (e.key === 'Backspace' && !query && selectedIds.length > 0) {
              removeProject(selectedIds[selectedIds.length - 1]);
            }
            if (e.key === 'Enter' && suggestions.length > 0) {
              e.preventDefault();
              addProject(suggestions[0].id);
            }
          }}
          placeholder={selectedIds.length > 0 ? 'Add project…' : 'Search projects…'}
          className="h-[22px] min-w-[80px] flex-1 bg-transparent text-[11px] text-foreground placeholder:text-muted-foreground/30 focus:outline-none"
        />

        {/* Clear all */}
        {selectedIds.length > 0 && (
          <button
            onClick={() => { onChange([]); setQuery(''); }}
            className="h-4 w-4 flex items-center justify-center rounded-sm text-muted-foreground/40 hover:text-foreground transition-colors"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Dropdown */}
      {showDropdown && (
        <div className="absolute left-0 top-full mt-1 z-50 w-56 rounded-md border border-border bg-background shadow-lg py-1 max-h-48 overflow-y-auto">
          {suggestions.length === 0 && q && (
            <div className="px-3 py-2 text-[11px] text-muted-foreground">
              No matching projects
            </div>
          )}
          {suggestions.map((p) => (
            <button
              key={p.id}
              onMouseDown={(e) => { e.preventDefault(); addProject(p.id); }}
              className="flex items-center w-full px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors gap-2"
            >
              {projectIcon(p.color)}
              <span className="truncate flex-1">{p.name}</span>
              <span className="text-muted-foreground/30 tabular-nums text-[11px]">{p.openCount}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Archived project search ──────────────────────────────────────────────────

export function ArchivedProjectSearch({
  onUnarchive,
}: {
  onUnarchive: (id: number) => void;
}) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [archivedProjects, setArchivedProjects] = useState<ProjectWithCounts[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useClickOutside(containerRef, () => setFocused(false), focused);

  // Load archived projects when opened
  useEffect(() => {
    if (!focused) return;
    (async () => {
      const res = await window.electronAPI?.listProjects({ includeArchived: true });
      if (res?.success) {
        setArchivedProjects(res.projects.filter((p: ProjectWithCounts) => p.archivedAt !== null));
      }
    })();
  }, [focused]);

  const q = query.trim();
  const suggestions = q
    ? archivedProjects
        .map(p => ({ ...p, dist: fuzzyScore(q, p.name) }))
        .filter(p => p.dist <= Math.max(2, Math.ceil(q.length * 0.4)))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 8)
    : archivedProjects.slice(0, 8);

  const showDropdown = focused && (suggestions.length > 0 || q || archivedProjects.length === 0);

  function handleUnarchive(id: number) {
    setArchivedProjects(prev => prev.filter(p => p.id !== id));
    onUnarchive(id);
    if (archivedProjects.length <= 1) {
      setFocused(false);
      setQuery('');
    }
  }

  if (!focused) {
    return (
      <button
        onClick={() => { setFocused(true); setTimeout(() => inputRef.current?.focus(), 0); }}
        className="flex items-center gap-1.5 h-6 px-2 rounded-md border border-transparent text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors"
      >
        <Archive className="h-3 w-3" />
        Unarchive a project…
      </button>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-1.5 min-h-[26px] pl-2">
        <Archive className="h-3 w-3 text-muted-foreground/50 shrink-0" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setQuery(''); setFocused(false); inputRef.current?.blur(); }
          }}
          placeholder="Search archived projects…"
          className="h-[22px] min-w-[80px] flex-1 bg-transparent text-[11px] text-foreground placeholder:text-muted-foreground/30 focus:outline-none"
        />
      </div>

      {/* Dropdown */}
      {showDropdown && (
        <div className="absolute left-0 top-full mt-1 z-50 w-64 rounded-md border border-border bg-background shadow-lg py-1 max-h-48 overflow-y-auto">
          {archivedProjects.length === 0 && (
            <div className="px-3 py-2 text-[11px] text-muted-foreground">
              No archived projects
            </div>
          )}
          {suggestions.length === 0 && q && archivedProjects.length > 0 && (
            <div className="px-3 py-2 text-[11px] text-muted-foreground">
              No matching projects
            </div>
          )}
          {suggestions.map((p) => (
            <div
              key={p.id}
              className="flex items-center w-full px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent transition-colors gap-2"
            >
              {projectIcon(p.color)}
              <span className="truncate flex-1">{p.name}</span>
              <button
                onMouseDown={(e) => { e.preventDefault(); handleUnarchive(p.id); }}
                className="text-[11px] text-purple-400 hover:text-purple-300 transition-colors font-medium shrink-0"
              >
                Unarchive
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
