import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import SiloCard from '@/components/SiloCard';
import SiloDetailModal from '@/components/SiloDetailModal';
import AddSiloModal from '@/components/AddSiloModal';
import { mockSilos } from '../../shared/mock-data';
import type { SiloStatus } from '../../shared/types';

export default function SilosView() {
  const [selectedSilo, setSelectedSilo] = useState<SiloStatus | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

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

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {mockSilos.map((silo) => (
          <SiloCard
            key={silo.config.name}
            silo={silo}
            onClick={() => handleCardClick(silo)}
          />
        ))}
      </div>

      <SiloDetailModal
        silo={selectedSilo}
        open={detailOpen}
        onOpenChange={setDetailOpen}
      />

      <AddSiloModal open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}
