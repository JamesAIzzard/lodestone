import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import ActionButton from '@/components/ActionButton';
import SiloCard from '@/components/SiloCard';
import MailAccountCard from '@/components/mail/MailAccountCard';
import AddSiloModal from '@/components/AddSiloModal';
import type { SiloStatus } from '../../shared/types';
import type { MailAccountStatus } from '../../backend/mail/account';

export default function SilosView() {
  const navigate = useNavigate();
  const [silos, setSilos] = useState<SiloStatus[]>([]);
  const [mailAccounts, setMailAccounts] = useState<MailAccountStatus[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [stoppingName, setStoppingName] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Shimmer keys — incrementing forces the animation to restart on each MCP call
  const [siloShimmerKeys, setSiloShimmerKeys] = useState<Record<string, number>>({});
  const silosRef = useRef<SiloStatus[]>([]);

  function fetchSources() {
    void Promise.all([
      window.electronAPI?.getSilos() ?? Promise.resolve([]),
      window.lodestone?.mail.list() ?? Promise.resolve([]),
    ]).then(([nextSilos, nextMailAccounts]) => {
      setSilos(nextSilos);
      setMailAccounts(nextMailAccounts);
      silosRef.current = nextSilos;
    });
  }

  const shimmerSilo = useCallback((name: string) => {
    setSiloShimmerKeys((prev) => ({ ...prev, [name]: (prev[name] ?? 0) + 1 }));
  }, []);

  useEffect(() => {
    fetchSources();
    // Re-fetch when state changes externally (e.g. tray stop/wake)
    const unsubSilos = window.electronAPI?.onSilosChanged(fetchSources);
    const unsubActivity = window.electronAPI?.onMcpActivity(({ channel, siloName }) => {
      if (channel === 'silo') {
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
    return () => {
      unsubSilos?.();
      unsubActivity?.();
    };
  }, [shimmerSilo]);

  // Poll while either the mailbox mirror or its ordinary silo index is active.
  useEffect(() => {
    const anyActive =
      mailAccounts.length > 0 ||
      silos.some((s) => s.watcherState === 'indexing' || s.watcherState === 'waiting');
    if (anyActive && !pollRef.current) {
      pollRef.current = setInterval(fetchSources, 2000);
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
  }, [mailAccounts, silos]);

  function handleRescan(silo: SiloStatus) {
    window.electronAPI?.rescanSilo(silo.config.name);
    fetchSources();
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
      fetchSources();
    } finally {
      if (isStop) setStoppingName(null);
    }
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-foreground">Silos</h1>
        <ActionButton
          icon={<Plus className="h-3.5 w-3.5" />}
          label="Add source"
          onClick={() => setAddOpen(true)}
        />
      </div>

      {silos.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No sources configured. Add a source to get started.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {silos.map((silo) => {
            const account = mailAccounts.find(
              (candidate) => candidate.siloName === silo.config.name,
            );
            return account && silo.config.managedBy?.startsWith('mail:') ? (
              <MailAccountCard
                key={silo.config.name}
                account={account}
                silo={silo}
                onChanged={fetchSources}
              />
            ) : (
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
            );
          })}
        </div>
      )}

      <AddSiloModal open={addOpen} onOpenChange={setAddOpen} onCreated={fetchSources} />
    </div>
  );
}
