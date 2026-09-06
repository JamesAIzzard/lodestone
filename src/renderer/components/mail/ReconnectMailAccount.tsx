import { useEffect, useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';

import type { MailAccountStatus } from '../../../backend/mail/account';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

interface ReconnectMailAccountProps {
  account: MailAccountStatus;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReconnected: () => void;
}

export default function ReconnectMailAccount({
  account,
  open,
  onOpenChange,
  onReconnected,
}: ReconnectMailAccountProps) {
  const [password, setPassword] = useState('');
  const [callbackUrl, setCallbackUrl] = useState('');
  const [oauthStarted, setOauthStarted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setPassword('');
      setCallbackUrl('');
      setOauthStarted(false);
      setError(null);
    }
  }, [open]);

  async function beginOAuth() {
    setBusy(true);
    setError(null);
    try {
      await window.lodestone?.mail.beginOAuth({
        clientId: account.oauthClientId ?? '',
        loginHint: account.username,
      });
      setOauthStarted(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function reconnect() {
    setBusy(true);
    setError(null);
    try {
      const result = await window.lodestone?.mail.reconnect({
        hash: account.accountHash,
        credential:
          account.credentialKind === 'password'
            ? { kind: 'password', password }
            : { kind: 'oauth', callbackUrl },
      });
      if (!result?.success) {
        setError(result?.error ?? 'Could not reconnect the account.');
        return;
      }
      onOpenChange(false);
      onReconnected();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reconnect mail account</DialogTitle>
          <DialogDescription>{account.displayName}</DialogDescription>
        </DialogHeader>
        <div className="mt-4 space-y-4">
          {account.credentialKind === 'password' ? (
            <Field
              label="Password or app password"
              value={password}
              onChange={setPassword}
              type="password"
            />
          ) : (
            <>
              <label className="block">
                <span className="mb-1.5 block text-sm text-muted-foreground">OAuth client ID</span>
                <input
                  value={account.oauthClientId ?? ''}
                  readOnly
                  className="w-full rounded-md border border-input bg-muted/20 px-3 py-2 text-sm text-muted-foreground"
                />
              </label>
              <Button variant="outline" size="sm" onClick={beginOAuth} disabled={busy}>
                <ExternalLink className="h-3.5 w-3.5" /> Sign in
              </Button>
              {oauthStarted && (
                <>
                  <p className="text-xs text-muted-foreground">
                    Your browser will show a page that fails to load at{' '}
                    <code>https://localhost/…</code>. Copy the full address from the address bar and
                    paste it here.
                  </p>
                  <Field label="Redirected address" value={callbackUrl} onChange={setCallbackUrl} />
                </>
              )}
            </>
          )}
        </div>
        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={reconnect}
            disabled={busy || (account.credentialKind === 'password' ? !password : !callbackUrl)}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Reconnect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm text-muted-foreground">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
    </label>
  );
}
