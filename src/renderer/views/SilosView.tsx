import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import SiloCard from '@/components/SiloCard';
import AddSiloModal from '@/components/AddSiloModal';
import MemoryCard from '@/components/MemoryCard';
import type { SiloStatus, MemoryStatus } from '../../shared/types';

export default function SilosView() {
  const navigate = useNavigate();
  const [silos, setSilos] = useState<SiloStatus[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [stoppingName, setStoppingName] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [memoryStatus, setMemoryStatus] = useState<MemoryStatus>({
    connected: false, dbPath: null, memoryCount: 0, databaseSizeBytes: 0,
  });

  // Shimmer keys — incrementing forces the animation to restart on each MCP call
  const [siloShimmerKeys, setSiloShimmerKeys] = useState<Record<string, number>>({});
  const [memoryShimmerKey, setMemoryShimmerKey] = useState(0);
  const silosRef = useRef<SiloStatus[]>([]);

  function fetchSilos() {
    window.electronAPI?.getSilos().then((s) => {
      setSilos(s);
      silosRef.current = s;
    });
  }

  function fetchMemoryStatus() {
    window.electronAPI?.getMemoryStatus().then(setMemoryStatus);
  }

  const shimmerSilo = useCallback((name: string) => {
    setSiloShimmerKeys((prev) => ({ ...prev, [name]: (prev[name] ?? 0) + 1 }));
  }, []);

  useEffect(() => {
    fetchSilos();
    fetchMemoryStatus();
    // Re-fetch when state changes externally (e.g. tray stop/wake)
    const unsubSilos = window.electronAPI?.onSilosChanged(fetchSilos);
    const unsubMemory = window.electronAPI?.onMemoriesChanged(fetchMemoryStatus);
    const unsubActivity = window.electronAPI?.onMcpActivity(({ channel, siloName }) => {
      if (channel === 'memory') {
        setMemoryShimmerKey((k) => k + 1);
      } else {
        if (siloName) {
          shimmerSilo(siloName);
        } else {
          // No specific silo targeted — shimmer all non-stopped silos
          silosRef.current
            .filter((s) => s.watcherState !== 'stopped')
            .forEach((s) => shimmerSilo(s.config.name));
        }
      }
    });
    return () => { unsubSilos?.(); unsubMemory?.(); unsubActivity?.(); };
  }, [shimmerSilo]);

  // Poll while any silo is indexing or waiting
  useEffect(() => {
    const anyActive = silos.some((s) =>
      s.watcherState === 'indexing' || s.watcherState === 'waiting'
    );
    if (anyActive && !pollRef.current) {
      pollRef.current = setInterval(fetchSilos, 2000);
    } else if (!anyActive && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [silos]);

  function handleRescan(silo: SiloStatus) {
    window.electronAPI?.rescanSilo(silo.config.name);
    fetchSilos();
  }

  function handleSearchInSilo(silo: SiloStatus) {
    navigate(`/search?silo=${encodeURIComponent(silo.config.name)}`);
  }

  async function handleStopToggle(silo: SiloStatus) {
    const isStop = silo.watcherState !== 'stopped';
    if (isStop) setStoppingName(silo.config.name);
    try {
      if (silo.watcherState === 'stopped') {
        await window.electronAPI?.wakeSilo(silo.config.name);
      } else {
        await window.electronAPI?.stopSilo(silo.config.name);
      }
      fetchSilos();
    } finally {
      if (isStop) setStoppingName(null);
    }
  }

  return (
    <div className="p-6">
      <MemoryCard
        status={memoryStatus}
        onDone={fetchMemoryStatus}
        shimmerKey={memoryShimmerKey}
      />
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-foreground">Silos</h1>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="h-3.5 w-3.5" />
          Add Silo
        </Button>
      </div>

      {silos.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No silos configured. Add a silo to get started.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {silos.map((silo) => (
            <SiloCard
              key={silo.config.name}
              silo={silo}
              onClick={() => navigate(`/silos/${silo.config.name}`)}
              onStopToggle={() => handleStopToggle(silo)}
              isStopping={stoppingName === silo.config.name}
              onRescan={() => handleRescan(silo)}
              onSearchInSilo={() => handleSearchInSilo(silo)}
              shimmerKey={siloShimmerKeys[silo.config.name] ?? 0}
            />
          ))}
        </div>
      )}

      <AddSiloModal open={addOpen} onOpenChange={setAddOpen} onCreated={fetchSilos} />
    </div>
  );
}
