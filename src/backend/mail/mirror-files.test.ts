import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanTmp,
  deleteMirrorFile,
  ensureDirs,
  writeMirrorFile,
  type MirrorDirs,
} from './mirror-files';

describe('mirror file operations', () => {
  let root: string;
  let dirs: MirrorDirs;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'lodestone-mirror-files-'));
    dirs = { mirror: path.join(root, 'mirror'), tmp: path.join(root, 'tmp') };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('atomically creates and replaces a mirror file without leaving temporary files', async () => {
    await writeMirrorFile(dirs, 'message.md', 'first');
    await writeMirrorFile(dirs, 'message.md', 'second');

    expect(await readFile(path.join(dirs.mirror, 'message.md'), 'utf8')).toBe('second');
    expect(await readdir(dirs.tmp)).toEqual([]);
  });

  it('cleans temporary entries and deletes mirror files idempotently', async () => {
    await ensureDirs(dirs);
    await writeFile(path.join(dirs.tmp, 'leftover'), 'partial');
    await cleanTmp(dirs);
    expect(await readdir(dirs.tmp)).toEqual([]);

    await deleteMirrorFile(dirs, 'missing.md');
    await writeMirrorFile(dirs, 'message.md', 'content');
    await deleteMirrorFile(dirs, 'message.md');
    await deleteMirrorFile(dirs, 'message.md');
    expect(await readdir(dirs.mirror)).toEqual([]);
  });
});
