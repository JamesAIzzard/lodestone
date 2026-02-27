import { useState } from 'react';
import { Brain, FolderOpen, Unplug } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import type { MemoryStatus } from '../../shared/types';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface MemoryCardProps {
  status: MemoryStatus;
  onDone: () => void;
  shimmerKey?: number;
}

export default function MemoryCard({ status, onDone, shimmerKey }: MemoryCardProps) {
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSetup() {
    setError(null);
    // Show the native file picker first — no overlay during picker
    const dbPath = await window.electronAPI?.saveDbFile('claude-memory.db');
    if (!dbPath) return;
    setLoading('Setting up memory database…');
    try {
      const result = await window.electronAPI?.setupMemory(dbPath);
      if (!result?.success) {
        setError(result?.error ?? 'Failed to set up memory database');
        return;
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(null);
    }
  }

  async function handleConnect() {
    setError(null);
    const dbPath = await window.electronAPI?.selectDbFile();
    if (!dbPath) return;
    setLoading('Connecting memory database…');
    try {
      const result = await window.electronAPI?.connectMemory(dbPath);
      if (!result?.success) {
        setError(result?.error ?? 'Failed to connect memory database');
        return;
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(null);
    }
  }

  async function handleDisconnect() {
    setError(null);
    setLoading('Disconnecting…');
    try {
      await window.electronAPI?.disconnectMemory();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(null);
    }
  }

  if (!status.connected) {
    return (
      <div className="mb-6 flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-violet-500/10 text-violet-500">
            <Brain className="h-4 w-4" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">Claude's Memory</p>
            <p className="text-xs text-muted-foreground">
              {loading ?? 'No memory database connected'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={handleSetup} disabled={!!loading}>
              Set up
            </Button>
            <Button size="sm" variant="outline" onClick={handleConnect} disabled={!!loading}>
              Connect
            </Button>
          </div>
        </div>
        {error && <p className="text-xs text-destructive pl-11">{error}</p>}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'relative overflow-hidden mb-6 flex flex-col gap-2 rounded-lg border border-border border-l-[3px] bg-card p-4',
        'border-l-violet-500',
      )}
    >
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-violet-500/10 text-violet-500">
          <Brain className="h-4 w-4" />
        </div>
        <p className="flex-1 min-w-0 text-sm font-medium text-foreground">Claude's Memory</p>
        <div className="flex shrink-0 items-center gap-1">
          {status.dbPath && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0 text-muted-foreground"
              title="Locate database file"
              onClick={() => window.electronAPI?.showItemInFolder(status.dbPath!)}
              disabled={!!loading}
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0 text-muted-foreground"
            title="Disconnect memory database"
            onClick={handleDisconnect}
            disabled={!!loading}
          >
            <Unplug className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <p className="pl-11 text-xs text-muted-foreground">
        {loading ?? (
          <>
            {status.memoryCount.toLocaleString()}{' '}
            {status.memoryCount === 1 ? 'memory' : 'memories'}
            {' · '}
            {formatBytes(status.databaseSizeBytes)}
          </>
        )}
      </p>
      {error && <p className="text-xs text-destructive pl-11">{error}</p>}

      {/* Neural shimmer — violet-tinted pulse when Claude accesses memory via MCP */}
      {(shimmerKey ?? 0) > 0 && (
        <div
          key={shimmerKey}
          aria-hidden
          className="absolute inset-0 pointer-events-none animate-neural-shimmer"
          style={{
            background: 'linear-gradient(108deg, transparent 38%, rgba(139,92,246,0.07) 45%, rgba(167,139,250,0.16) 50%, rgba(139,92,246,0.07) 55%, transparent 62%)',
          }}
        />
      )}
    </div>
  );
}
