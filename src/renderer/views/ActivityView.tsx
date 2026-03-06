import { useState, useEffect } from 'react';
import ActivityFeed from '@/components/ActivityFeed';
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
        <select
          value={siloFilter}
          onChange={(e) => setSiloFilter(e.target.value)}
          className="h-8 rounded-md border border-input bg-background px-3 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="all">All Silos</option>
          {silos.map((s) => (
            <option key={s.config.name} value={s.config.name}>
              {s.config.name}
            </option>
          ))}
        </select>
      </div>

      <ActivityFeed
        siloName={siloFilter === 'all' ? undefined : siloFilter}
        limit={200}
      />
    </div>
  );
}
