import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';

import type { MailAccountStatus } from '../../../backend/mail/account';
import type { Folder } from '../../../backend/mail/types';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import {
  dateInputToReceivedAfter,
  defaultFolderSelection,
  folderSelectionLocked,
  receivedAfterToDateInput,
} from './mail-ui';

interface MailAccountSettingsProps {
  account: MailAccountStatus;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export default function MailAccountSettings({
  account,
  open,
  onOpenChange,
  onSaved,
}: MailAccountSettingsProps) {
  const [siloName, setSiloName] = useState(account.siloName);
  const [syncInterval, setSyncInterval] = useState(String(account.syncIntervalSeconds));
  const [selectionMode, setSelectionMode] = useState(account.selectionMode);
  const [selectedFolders, setSelectedFolders] = useState<string[]>([]);
  const [allHistory, setAllHistory] = useState(account.receivedAfter === 'unlimited');
  const [receivedAfter, setReceivedAfter] = useState(
    receivedAfterToDateInput(account.receivedAfter),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSiloName(account.siloName);
    setSyncInterval(String(account.syncIntervalSeconds));
    setSelectionMode(account.selectionMode);
    setSelectedFolders(
      account.selectionMode === 'default'
        ? defaultFolderSelection(account.folders, account.isGmail)
        : account.selectedFolders,
    );
    setAllHistory(account.receivedAfter === 'unlimited');
    setReceivedAfter(receivedAfterToDateInput(account.receivedAfter));
    setError(null);
  }, [account, open]);

  const nextReceivedAfter = allHistory ? 'unlimited' : dateInputToReceivedAfter(receivedAfter);
  const selectionChanged = useMemo(
    () =>
      nextReceivedAfter !== account.receivedAfter ||
      selectionMode !== account.selectionMode ||
      JSON.stringify(selectionMode === 'explicit' ? selectedFolders : []) !==
        JSON.stringify(account.selectedFolders),
    [account, nextReceivedAfter, selectedFolders, selectionMode],
  );

  function toggleFolder(folder: Folder) {
    if (folderSelectionLocked(folder, account.isGmail)) return;
    setSelectionMode('explicit');
    setSelectedFolders((current) =>
      current.includes(folder.folderKey)
        ? current.filter((key) => key !== folder.folderKey)
        : [...current, folder.folderKey],
    );
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const result = await window.lodestone?.mail.updateSettings({
        hash: account.accountHash,
        patch: {
          silo_name: siloName.trim(),
          sync_interval_seconds: Number(syncInterval),
          received_after: nextReceivedAfter,
          selection_mode: account.isGmail ? 'default' : selectionMode,
          selected_folders: selectionMode === 'explicit' && !account.isGmail ? selectedFolders : [],
        },
      });
      if (!result?.success) {
        setError(result?.error ?? 'Could not save mail settings.');
        return;
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mail account settings</DialogTitle>
          <DialogDescription>{account.displayName}</DialogDescription>
        </DialogHeader>
        <div className="mt-4 space-y-4">
          <Field label="Silo name" value={siloName} onChange={setSiloName} />
          <Field
            label="Sync interval (seconds)"
            value={syncInterval}
            onChange={setSyncInterval}
            type="number"
            min={1}
          />
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Folders to mirror</span>
              {!account.isGmail && selectionMode === 'explicit' && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSelectionMode('default');
                    setSelectedFolders(defaultFolderSelection(account.folders, false));
                  }}
                >
                  Use default selection
                </Button>
              )}
            </div>
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-2">
              {account.folders.map((folder) => {
                const locked = folderSelectionLocked(folder, account.isGmail);
                return (
                  <label
                    key={folder.folderKey}
                    className="flex items-center gap-2 rounded px-2 py-1 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={selectedFolders.includes(folder.folderKey)}
                      disabled={locked}
                      onChange={() => toggleFolder(folder)}
                    />
                    <span className={locked ? 'text-muted-foreground' : undefined}>
                      {folder.path}
                    </span>
                  </label>
                );
              })}
            </div>
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
          {selectionChanged && (
            <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
              <span>
                The mailbox will be unavailable to search until reconciliation and indexing
                complete.
              </span>
            </div>
          )}
        </div>
        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={save}
            disabled={
              saving ||
              !siloName.trim() ||
              Number(syncInterval) < 1 ||
              selectedFolders.length === 0 ||
              (!allHistory && !receivedAfter)
            }
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save
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
  min,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  min?: number;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm text-muted-foreground">{label}</span>
      <input
        type={type}
        min={min}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
    </label>
  );
}
