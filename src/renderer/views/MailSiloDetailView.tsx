import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ChevronLeft,
  ExternalLink,
  Loader2,
  Mail,
  Trash2,
  Unplug,
} from 'lucide-react';

import type { MailAccountStatus } from '../../backend/mail/account';
import type { SiloStatus } from '../../shared/types';
import { SILO_COLOR_MAP } from '../../shared/silo-appearance';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import MailAccountSettings from '@/components/mail/MailAccountSettings';
import ReconnectMailAccount from '@/components/mail/ReconnectMailAccount';

export default function MailSiloDetailView() {
  const { hash } = useParams<{ hash: string }>();
  const navigate = useNavigate();
  const [account, setAccount] = useState<MailAccountStatus | null>(null);
  const [silo, setSilo] = useState<SiloStatus | null>(null);
  const [reconnectOpen, setReconnectOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function fetchSource() {
    void Promise.all([
      window.lodestone?.mail.list() ?? Promise.resolve([]),
      window.electronAPI?.getSilos() ?? Promise.resolve([]),
    ]).then(([accounts, silos]) => {
      const nextAccount = accounts.find((candidate) => candidate.accountHash === hash) ?? null;
      if (!nextAccount) {
        navigate('/');
        return;
      }
      setAccount(nextAccount);
      setSilo(silos.find((candidate) => candidate.config.name === nextAccount.siloName) ?? null);
    });
  }

  useEffect(() => {
    fetchSource();
    const timer = setInterval(fetchSource, 2_000);
    return () => clearInterval(timer);
  }, [hash]); // eslint-disable-line react-hooks/exhaustive-deps

  async function remove(retry = false) {
    if (!account) return;
    setRemoving(true);
    setError(null);
    try {
      const action = retry ? window.lodestone?.mail.retryRemove : window.lodestone?.mail.remove;
      const result = await action?.(account.accountHash);
      if (!result?.success) {
        setError(result?.error ?? 'Could not remove the account.');
        setRemoveOpen(false);
        fetchSource();
        return;
      }
      navigate('/');
    } catch (err) {
      setError(String(err));
      setRemoveOpen(false);
    } finally {
      setRemoving(false);
    }
  }

  if (!account || !silo) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const color = SILO_COLOR_MAP[silo.config.accentColor];
  const failedRemoval = account.removalFailedStep !== undefined;

  return (
    <div className="p-6">
      <button
        type="button"
        onClick={() => navigate('/')}
        className="mb-2 flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="h-3.5 w-3.5" /> Silos
      </button>

      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <Mail className={cn('h-5 w-5', color.text)} /> {silo.config.name}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{account.username}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">Read-only</Badge>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Mirrored" value={account.messageCount.toLocaleString()} />
        <Stat label="Indexed" value={silo.indexedFileCount.toLocaleString()} />
        <Stat label="Chunks" value={silo.chunkCount.toLocaleString()} />
        <Stat label="Folders" value={account.selectionSummary} />
      </div>

      <MailAccountSettings account={account} onSaved={fetchSource} />

      <section className="mb-6">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Connection
        </h2>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => setReconnectOpen(true)}>
            <Unplug className="h-3.5 w-3.5" /> Reconnect
          </Button>
          <span className="text-xs text-muted-foreground">
            Replace the saved credential if the mail provider rejects it.
          </span>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Danger Zone
        </h2>
        <div className="flex items-center gap-3">
          {failedRemoval ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void remove(true)}
              disabled={removing}
            >
              {removing && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Retry remove
            </Button>
          ) : (
            <Button variant="destructive" size="sm" onClick={() => setRemoveOpen(true)}>
              <Trash2 className="h-3.5 w-3.5" /> Remove mail silo
            </Button>
          )}
          <span className="text-xs text-muted-foreground">
            Remove the local mirror and search index without changing mail on the server.
          </span>
        </div>
      </section>

      {(account.lastError || error) && (
        <p className="flex items-start gap-1.5 text-xs text-red-400">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          {error ?? `Mail synchronisation failed (${account.lastError}).`}
        </p>
      )}

      <ReconnectMailAccount
        account={account}
        open={reconnectOpen}
        onOpenChange={setReconnectOpen}
        onReconnected={fetchSource}
      />
      <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {account.displayName}?</DialogTitle>
            <DialogDescription>
              This removes Lodestone's local mirror. It does not delete or change mail on the
              server.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-3 text-sm text-muted-foreground">
            <p>
              Mirrored messages, the manifest, search index, encrypted credential and account
              configuration will be deleted locally.
            </p>
            {account.credentialKind === 'oauth' && (
              <button
                type="button"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                onClick={() =>
                  window.electronAPI?.openExternal('https://myaccount.microsoft.com/permissions')
                }
              >
                Review Microsoft account permissions <ExternalLink className="h-3 w-3" />
              </button>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRemoveOpen(false)}
              disabled={removing}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void remove()}
              disabled={removing}
            >
              {removing && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Remove local mirror
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-sm font-medium">{value}</p>
    </div>
  );
}
