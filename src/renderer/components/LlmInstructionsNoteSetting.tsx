import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Search, TriangleAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { dirPath, fileName } from '@/lib/format';
import { getInstructionsNoteStatus } from '@/lib/llm-instructions-note';
import type { SearchResult } from '../../shared/types';

const UNSET_WARNING =
  'No instructions note is configured. LLM clients will receive general advice to search for user instructions.';

const UNAVAILABLE_WARNING =
  'The selected note is not currently available in an indexed silo. It may have moved, or its silo may be stopped or still indexing.';

export default function LlmInstructionsNoteSetting() {
  const [notePath, setNotePath] = useState<string>();
  const [availabilityResults, setAvailabilityResults] = useState<SearchResult[]>([]);
  const [availabilityChecked, setAvailabilityChecked] = useState(false);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;

    async function loadSelection() {
      try {
        const settings = await window.electronAPI?.getLlmInstructionsSettings();
        if (cancelled) return;

        const selectedPath = settings?.notePath;
        setNotePath(selectedPath);
        if (!selectedPath) {
          setAvailabilityChecked(true);
          return;
        }

        const results = await findNote(selectedPath);
        if (!cancelled) {
          setAvailabilityResults(results);
          setAvailabilityChecked(true);
        }
      } catch (cause) {
        if (!cancelled) {
          setAvailabilityChecked(true);
          setError(errorMessage(cause, 'Could not load the instructions note setting.'));
        }
      }
    }

    void loadSelection();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      setSearchResults([]);
      setSearching(false);
      return undefined;
    }

    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      setSearching(true);
      setError(undefined);
      try {
        const results = await window.electronAPI?.search({
          query: trimmedQuery,
          mode: 'filepath',
          limit: 8,
        });
        if (!cancelled) setSearchResults(results ?? []);
      } catch (cause) {
        if (!cancelled) setError(errorMessage(cause, 'Could not search indexed notes.'));
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [query]);

  const status = getInstructionsNoteStatus(notePath, availabilityChecked, availabilityResults);

  async function selectNote(result: SearchResult) {
    setSaving(true);
    setError(undefined);
    try {
      const outcome = await window.electronAPI?.updateLlmInstructionsSettings(result.filePath);
      if (!outcome?.success) throw new Error('Lodestone could not save the selected note.');

      setNotePath(result.filePath);
      setAvailabilityResults([result]);
      setAvailabilityChecked(true);
      setQuery('');
      setSearchResults([]);
    } catch (cause) {
      setError(errorMessage(cause, 'Could not save the selected note.'));
    } finally {
      setSaving(false);
    }
  }

  async function clearSelection() {
    setSaving(true);
    setError(undefined);
    try {
      const outcome = await window.electronAPI?.updateLlmInstructionsSettings(undefined);
      if (!outcome?.success) throw new Error('Lodestone could not clear the selected note.');

      setNotePath(undefined);
      setAvailabilityResults([]);
      setAvailabilityChecked(true);
    } catch (cause) {
      setError(errorMessage(cause, 'Could not clear the selected note.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {notePath && (
        <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-muted/20 p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{fileName(notePath)}</p>
            <p className="mt-1 break-all text-xs text-muted-foreground">{notePath}</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Clear instructions note"
            onClick={clearSelection}
            disabled={saving}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
          </Button>
        </div>
      )}

      <StatusMessage status={status} />

      <div>
        <label className="mb-1.5 block text-xs text-muted-foreground" htmlFor="llm-note-search">
          Find an indexed instructions note
        </label>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            id="llm-note-search"
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search filenames..."
            className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-9 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {searching && (
            <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
        </div>
      </div>

      {query.trim() && !searching && (
        <SearchResults results={searchResults} saving={saving} onSelect={selectNote} />
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

async function findNote(notePath: string): Promise<SearchResult[]> {
  return (
    (await window.electronAPI?.search({
      query: fileName(notePath),
      mode: 'filepath',
      limit: 20,
    })) ?? []
  );
}

function StatusMessage({ status }: { status: ReturnType<typeof getInstructionsNoteStatus> }) {
  if (status === 'checking') {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Checking the selected note
      </p>
    );
  }

  if (status === 'available') {
    return (
      <p className="flex items-center gap-2 text-xs text-emerald-400">
        <CheckCircle2 className="h-3.5 w-3.5" />
        Selected note is available
      </p>
    );
  }

  const message = status === 'unset' ? UNSET_WARNING : UNAVAILABLE_WARNING;
  const colour = status === 'unset' ? 'text-amber-400' : 'text-red-400';
  return (
    <p className={`flex items-start gap-2 text-xs ${colour}`}>
      <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      {message}
    </p>
  );
}

function SearchResults({
  results,
  saving,
  onSelect,
}: {
  results: SearchResult[];
  saving: boolean;
  onSelect: (result: SearchResult) => Promise<void>;
}) {
  if (results.length === 0) {
    return <p className="text-xs text-muted-foreground">No indexed notes found.</p>;
  }

  return (
    <div className="max-h-56 overflow-y-auto rounded-md border border-border">
      {results.map((result) => (
        <button
          key={`${result.siloName}:${result.filePath}`}
          type="button"
          onClick={() => void onSelect(result)}
          disabled={saving}
          className="block w-full border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-muted/40 disabled:opacity-50"
        >
          <span className="block text-sm text-foreground">{fileName(result.filePath)}</span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {dirPath(result.filePath)}
          </span>
          <span className="mt-0.5 block text-[10px] uppercase tracking-wide text-muted-foreground/60">
            {result.siloName}
          </span>
        </button>
      ))}
    </div>
  );
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}
