import { useEffect, useMemo, useState } from 'react';
import { Check, ExternalLink, Loader2, Mail, Plus } from 'lucide-react';

import type { MailCredentialInput } from '../../../shared/electron-api';
import {
  autoAssignColor,
  DEFAULT_SILO_ICON,
  type SiloColor,
  type SiloIconName,
} from '../../../shared/silo-appearance';
import type { Folder } from '../../../backend/mail/types';
import SiloAppearancePicker from '../SiloAppearancePicker';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { cn } from '@/lib/utils';
import {
  dateInputToReceivedAfter,
  defaultFolderSelection,
  defaultReceivedAfter,
  defaultSiloName,
  folderSelectionLocked,
  inferredDisplayName,
  MAIL_STORAGE_SUMMARY,
} from './mail-ui';

const MICROSOFT_CLIENT_ID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';
const STEPS = ['Server', 'Credential', 'Selection', 'Name and summary'] as const;

type CredentialKind = 'password' | 'oauth';
type Provider = 'custom' | 'microsoft' | 'gmail';

interface AddMailAccountWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
}

export default function AddMailAccountWizard({
  open,
  onOpenChange,
  onCreated,
}: AddMailAccountWizardProps) {
  const [step, setStep] = useState(0);
  const [provider, setProvider] = useState<Provider>('custom');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(993);
  const [username, setUsername] = useState('');
  const [credentialKind, setCredentialKind] = useState<CredentialKind>('password');
  const [password, setPassword] = useState('');
  const [clientId, setClientId] = useState(MICROSOFT_CLIENT_ID);
  const [callbackUrl, setCallbackUrl] = useState('');
  const [oauthStarted, setOauthStarted] = useState(false);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [testedIdentity, setTestedIdentity] = useState<{
    host: string;
    port: number;
    username: string;
  } | null>(null);
  const [selectedFolders, setSelectedFolders] = useState<string[]>([]);
  const [selectionMode, setSelectionMode] = useState<'default' | 'explicit'>('default');
  const [receivedAfter, setReceivedAfter] = useState(() => defaultReceivedAfter());
  const [allHistory, setAllHistory] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [siloName, setSiloName] = useState('');
  const [siloNameEdited, setSiloNameEdited] = useState(false);
  const [siloColor, setSiloColor] = useState<SiloColor>(() => autoAssignColor(0));
  const [siloIcon, setSiloIcon] = useState<SiloIconName>(DEFAULT_SILO_ICON);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isGmail = provider === 'gmail' || folders.some((folder) => folder.role === 'all');
  const credential: MailCredentialInput =
    credentialKind === 'password' ? { kind: 'password', password } : { kind: 'oauth', callbackUrl };

  useEffect(() => {
    if (!open) return;
    window.electronAPI?.getSilos().then((silos) => setSiloColor(autoAssignColor(silos.length)));
  }, [open]);

  useEffect(() => {
    if (displayName && !siloNameEdited) setSiloName(defaultSiloName(displayName));
  }, [displayName, siloNameEdited]);

  const canContinue = useMemo(() => {
    if (step === 0) return host.trim() !== '' && port > 0 && username.trim() !== '';
    if (step === 1) return false;
    if (step === 2) return selectedFolders.length > 0 && (allHistory || receivedAfter !== '');
    return displayName.trim() !== '' && siloName.trim() !== '';
  }, [
    allHistory,
    displayName,
    host,
    port,
    receivedAfter,
    selectedFolders.length,
    siloName,
    step,
    username,
  ]);

  function reset() {
    setStep(0);
    setProvider('custom');
    setHost('');
    setPort(993);
    setUsername('');
    setCredentialKind('password');
    setPassword('');
    setClientId(MICROSOFT_CLIENT_ID);
    setCallbackUrl('');
    setOauthStarted(false);
    setFolders([]);
    setTestedIdentity(null);
    setSelectedFolders([]);
    setSelectionMode('default');
    setReceivedAfter(defaultReceivedAfter());
    setAllHistory(false);
    setDisplayName('');
    setSiloName('');
    setSiloNameEdited(false);
    setSiloIcon(DEFAULT_SILO_ICON);
    setBusy(false);
    setError(null);
  }

  function close(nextOpen: boolean) {
    if (!nextOpen && busy) return;
    if (!nextOpen) {
      const identity = testedIdentity ?? {
        host: host.trim(),
        port,
        username: username.trim(),
      };
      if (identity.host && identity.username) {
        void window.lodestone?.mail.cancelSetup({
          host: identity.host,
          port: identity.port,
          username: identity.username,
        });
      }
      reset();
    }
    onOpenChange(nextOpen);
  }

  function applyPreset(next: Provider) {
    setProvider(next);
    setPort(993);
    if (next === 'microsoft') {
      setHost('outlook.office365.com');
      setCredentialKind('oauth');
      setClientId(MICROSOFT_CLIENT_ID);
    } else if (next === 'gmail') {
      setHost('imap.gmail.com');
      setCredentialKind('password');
    }
  }

  async function beginOAuth() {
    setBusy(true);
    setError(null);
    try {
      await window.lodestone?.mail.beginOAuth({
        clientId: clientId.trim(),
        loginHint: username.trim(),
      });
      setOauthStarted(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    setBusy(true);
    setError(null);
    try {
      const result = await window.lodestone?.mail.testConnection({
        host: host.trim(),
        port,
        username: username.trim(),
        auth:
          credentialKind === 'oauth' ? { ...credential, clientId: clientId.trim() } : credential,
      });
      if (!result?.ok || !result.folders) {
        setError(result?.error ?? 'Connection failed.');
        return;
      }
      const gmail = provider === 'gmail' || result.folders.some((folder) => folder.role === 'all');
      setFolders(result.folders);
      setTestedIdentity({ host: host.trim(), port, username: username.trim() });
      setSelectedFolders(defaultFolderSelection(result.folders, gmail));
      setSelectionMode('default');
      const inferred = inferredDisplayName(username);
      setDisplayName(inferred || username);
      setSiloName(defaultSiloName(inferred || username));
      setSiloNameEdited(false);
      setStep(2);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  function toggleFolder(folder: Folder) {
    if (folderSelectionLocked(folder, isGmail)) return;
    setSelectionMode('explicit');
    setSelectedFolders((current) =>
      current.includes(folder.folderKey)
        ? current.filter((key) => key !== folder.folderKey)
        : [...current, folder.folderKey],
    );
  }

  async function createAccount() {
    setBusy(true);
    setError(null);
    try {
      const result = await window.lodestone?.mail.create({
        config: {
          host: host.trim(),
          port,
          username: username.trim(),
          display_name: displayName.trim(),
          credential_kind: credentialKind,
          oauth_client_id: credentialKind === 'oauth' ? clientId.trim() : undefined,
          silo_name: siloName.trim(),
          received_after: allHistory ? 'unlimited' : dateInputToReceivedAfter(receivedAfter),
          selection_mode: isGmail ? 'default' : selectionMode,
          selected_folders: selectionMode === 'explicit' && !isGmail ? selectedFolders : [],
          sync_interval_seconds: 300,
        },
        credential,
        appearance: { accentColor: siloColor, iconName: siloIcon },
      });
      if (!result?.success) {
        setError(result?.error ?? 'Could not create the mail account.');
        return;
      }
      reset();
      onOpenChange(false);
      onCreated?.();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add email account</DialogTitle>
          <DialogDescription>
            Step {step + 1} of {STEPS.length}: {STEPS[step]}
          </DialogDescription>
        </DialogHeader>
        <div className="mt-2 flex gap-1">
          {STEPS.map((label, index) => (
            <div
              key={label}
              className={cn('h-1 flex-1 rounded-full', index <= step ? 'bg-primary' : 'bg-muted')}
            />
          ))}
        </div>

        <div className="mt-4 min-h-[220px]">
          {step === 0 && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {(
                  [
                    ['custom', 'Other IMAP'],
                    ['microsoft', 'Microsoft 365'],
                    ['gmail', 'Gmail'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => applyPreset(value)}
                    className={cn(
                      'rounded-md border px-3 py-2 text-left text-sm transition-colors',
                      provider === value
                        ? 'border-primary bg-primary/10'
                        : 'border-border hover:border-foreground/20',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <Field
                label="Server host"
                value={host}
                onChange={setHost}
                placeholder="imap.example.com"
              />
              <div className="grid grid-cols-[120px_1fr] gap-3">
                <Field
                  label="Port"
                  value={String(port)}
                  onChange={(value) => setPort(Number(value))}
                  type="number"
                />
                <Field
                  label="Username"
                  value={username}
                  onChange={setUsername}
                  placeholder="name@example.com"
                />
              </div>
              {provider === 'custom' && (
                <Choice
                  label="Credential"
                  value={credentialKind}
                  options={[
                    ['password', 'Password'],
                    ['oauth', 'OAuth'],
                  ]}
                  onChange={(value) => setCredentialKind(value as CredentialKind)}
                />
              )}
              {provider === 'gmail' && (
                <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-muted-foreground">
                  Gmail requires 2-step verification and an app password. Use the generated app
                  password below, not your normal Google password.
                </p>
              )}
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              {credentialKind === 'password' ? (
                <Field
                  label="Password or app password"
                  value={password}
                  onChange={setPassword}
                  type="password"
                  autoFocus
                />
              ) : (
                <>
                  <Field label="OAuth client ID" value={clientId} onChange={setClientId} />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={beginOAuth}
                    disabled={busy || !clientId.trim()}
                  >
                    <ExternalLink className="h-3.5 w-3.5" /> Sign in
                  </Button>
                  {oauthStarted && (
                    <div>
                      <p className="mb-2 text-xs text-muted-foreground">
                        Your browser will show a page that fails to load at{' '}
                        <code>https://localhost/…</code>. Copy the full address from the address bar
                        and paste it here.
                      </p>
                      <Field
                        label="Redirected address"
                        value={callbackUrl}
                        onChange={setCallbackUrl}
                        placeholder="https://localhost/?code=…&state=…"
                      />
                    </div>
                  )}
                </>
              )}
              <Button
                onClick={testConnection}
                disabled={busy || (credentialKind === 'password' ? !password : !callbackUrl)}
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4" />
                )}
                Test connection
              </Button>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div>
                <span className="mb-2 block text-sm text-muted-foreground">Folders to mirror</span>
                <div className="max-h-52 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                  {folders.map((folder) => {
                    const locked = folderSelectionLocked(folder, isGmail);
                    return (
                      <label
                        key={folder.folderKey}
                        className={cn(
                          'flex items-center gap-2 rounded px-2 py-1.5 text-sm',
                          locked && 'opacity-60',
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={selectedFolders.includes(folder.folderKey)}
                          disabled={locked}
                          onChange={() => toggleFolder(folder)}
                        />
                        <span>{folder.path}</span>
                        {locked && (
                          <span className="ml-auto text-[10px] text-muted-foreground">Locked</span>
                        )}
                      </label>
                    );
                  })}
                </div>
                {isGmail && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Gmail is mirrored once through All Mail.
                  </p>
                )}
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={allHistory}
                  onChange={(event) => setAllHistory(event.target.checked)}
                />
                All history
              </label>
              {!allHistory && (
                <Field
                  label="Messages received after"
                  value={receivedAfter}
                  onChange={setReceivedAfter}
                  type="date"
                />
              )}
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <Field label="Account name" value={displayName} onChange={setDisplayName} autoFocus />
              <Field
                label="Silo name"
                value={siloName}
                onChange={(value) => {
                  setSiloName(value);
                  setSiloNameEdited(true);
                }}
              />
              <SiloAppearancePicker
                color={siloColor}
                icon={siloIcon}
                onColorChange={setSiloColor}
                onIconChange={setSiloIcon}
              />
              <div className="flex gap-2 rounded-md border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                <Mail className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{MAIL_STORAGE_SUMMARY}</span>
              </div>
            </div>
          )}
        </div>

        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
        <DialogFooter>
          {step > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStep((current) => current - 1)}
              disabled={busy}
            >
              Back
            </Button>
          )}
          {step !== 1 && (
            <Button
              size="sm"
              onClick={() =>
                step === STEPS.length - 1 ? void createAccount() : setStep((current) => current + 1)
              }
              disabled={!canContinue || busy}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : step === STEPS.length - 1 ? (
                <Plus className="h-3.5 w-3.5" />
              ) : null}
              {step === STEPS.length - 1 ? 'Create' : 'Next'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface FieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  autoFocus?: boolean;
}

function Field({ label, value, onChange, placeholder, type = 'text', autoFocus }: FieldProps) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm text-muted-foreground">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring"
      />
    </label>
  );
}

function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<readonly [string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <span className="mb-1.5 block text-sm text-muted-foreground">{label}</span>
      <div className="flex gap-2">
        {options.map(([option, text]) => (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            className={cn(
              'rounded-md border px-3 py-2 text-sm',
              value === option ? 'border-primary bg-primary/10' : 'border-border',
            )}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
