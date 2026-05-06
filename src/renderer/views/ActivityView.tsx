import { useState, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';
import ActivityFeed from '@/components/ActivityFeed';
import { CellDropdown, InlineDropdown } from '@/components/Dropdown';
import type { SiloStatus } from '../../shared/types';

export default function ActivityView() {
  const [silos, setSilos] = useState<SiloStatus[]>([]);
  const [siloFilter, setSiloFilter] = useState('all');

  useEffect(() => {
    window.electronAPI?.getSilos().then(setSilos);
  }, []);

  return (
    <div className="p-6">
      <h1 className="mb-6 text-lg font-semibold text-foreground">Activity</h1>

      {/* Silo dropdown — only shown on the top-level activity view */}
      <div className="mb-4">
        <CellDropdown
          trigger={(toggle) => (
            <button
              onClick={toggle}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs text-foreground hover:bg-accent/30 transition-colors"
            >
              {siloFilter === 'all' ? 'All Silos' : siloFilter}
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            </button>
          )}
        >
          {(close) => (
            <InlineDropdown
              options={[
                { value: 'all', label: 'All Silos' },
                ...silos.map((s) => ({ value: s.config.name, label: s.config.name })),
              ]}
              onSelect={(v) => {
                setSiloFilter(v);
              }}
              onClose={close}
            />
          )}
        </CellDropdown>
      </div>

      <ActivityFeed siloName={siloFilter === 'all' ? undefined : siloFilter} limit={200} />
    </div>
  );
}
