import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { openManifest, type Manifest } from './manifest';

describe('mail manifest', () => {
  let manifest: Manifest | undefined;
  let root: string | undefined;

  afterEach(() => {
    manifest?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('persists state and relational records across reopen', () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'lodestone-manifest-'));
    const filePath = path.join(root, 'manifest.sqlite');
    manifest = openManifest(filePath);
    manifest.setState('sync_state', 'idle');
    manifest.upsertFolder({
      folderKey: 'inbox',
      path: 'Inbox',
      role: 'inbox',
      selected: true,
      uidValidity: 7,
    });
    manifest.upsertMembership({
      messageKey: 'message',
      folderKey: 'inbox',
      seen: true,
      flagged: false,
      seenInRound: 1,
    });
    manifest.insertMessage({
      messageKey: 'message',
      fileName: 'message.md',
      receivedAt: '2026-09-06T09:00:00.000Z',
      labels: null,
      contentHash: 'hash',
      fetchedAt: '2026-09-06T09:00:00.000Z',
    });
    manifest.close();

    manifest = openManifest(filePath);
    expect(manifest.getState('sync_state')).toBe('idle');
    expect(manifest.folderUidValidity('inbox')).toBe(7);
    expect(manifest.message('message')?.fileName).toBe('message.md');
    expect(manifest.membershipsForMessage('message')[0].path).toBe('Inbox');
  });
});
