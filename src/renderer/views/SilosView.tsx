import { useState, useEffect, useRef } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import SiloCard from '@/components/SiloCard';
import SiloDetailModal from '@/components/SiloDetailModal';
import AddSiloModal from '@/components/AddSiloModal';
import type { SiloStatus } from '../../shared/types';

export default function SilosView() {
  const [silos, setSilos] = useState<SiloStatus[]>([]);
  const [selectedSilo, setSelectedSilo] = useState<SiloStatus | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function fetchSilos() {
    window.electronAPI?.getSilos().then(setSilos);
  }

  useEffect(() => {
    fetchSilos();
  }, []);

  // Poll while any silo is indexing
  useEffect(() => {
    const anyIndexing = silos.some((s) => s.watcherState === 'indexing');
    if (anyIndexing && !pollRef.current) {
      pollRef.current = setInterval(fetchSilos, 2000);
    } else if (!anyIndexing && pollRef.current) {
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

  function handleCardClick(silo: SiloStatus) {
    setSelectedSilo(silo);
    setDetailOpen(true);
  }

  return (
    <div className="p-6">
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
              onClick={() => handleCardClick(silo)}
            />
          ))}
        </div>
      )}

      <SiloDetailModal
        silo={selectedSilo}
        open={detailOpen}
        onOpenChange={setDetailOpen}
      />

      <AddSiloModal open={addOpen} onOpenChange={setAddOpen} onCreated={fetchSilos} />
    </div>
  );
}
