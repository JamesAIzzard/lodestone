import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalisePolicyPath, executeEdit, type EditOperation, type WritePolicy } from './edit';

const READ_ONLY_ERROR = 'This path is inside a read-only silo and cannot be modified.';
const testDirs: string[] = [];

afterEach(() => {
  for (const dir of testDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTree(): { parent: string; root: string; child: string; writable: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-edit-policy-'));
  testDirs.push(parent);
  const root = path.join(parent, 'read-only');
  const child = path.join(root, 'nested');
  const writable = path.join(parent, 'writable');
  fs.mkdirSync(child, { recursive: true });
  fs.mkdirSync(writable);
  fs.writeFileSync(path.join(child, 'note.md'), 'original');
  return { parent, root, child, writable };
}

function operationTouching(kind: EditOperation['op'], target: string): EditOperation {
  switch (kind) {
    case 'str_replace':
      return { op: kind, filePath: target, oldStr: 'original', newStr: 'changed' };
    case 'insert_at_line':
      return { op: kind, filePath: target, line: 1, content: 'changed' };
    case 'overwrite':
      return { op: kind, filePath: target, content: 'changed' };
    case 'append':
      return { op: kind, filePath: target, content: 'changed' };
    case 'create':
      return { op: kind, directory: target, filename: 'created.md', content: 'created' };
    case 'mkdir':
      return { op: kind, directory: target, name: 'created' };
    case 'rename':
      return { op: kind, target, name: 'renamed.md' };
    case 'move':
      return {
        op: kind,
        target,
        destination: path.dirname(target),
        destinationType: 'directory',
      };
    case 'delete':
      return { op: kind, target };
  }
}

describe('read-only write policy', () => {
  const operationKinds: EditOperation['op'][] = [
    'str_replace',
    'insert_at_line',
    'overwrite',
    'append',
    'create',
    'mkdir',
    'rename',
    'move',
    'delete',
  ];

  for (const kind of operationKinds) {
    it(`rejects ${kind} at, below, and above a read-only root`, async () => {
      const { parent, root, child } = makeTree();
      const policy: WritePolicy = { readOnlyRoots: [canonicalisePolicyPath(root)] };

      for (const target of [root, child, parent]) {
        const result = await executeEdit(operationTouching(kind, target), 10, [parent], policy);
        expect(result).toEqual({ success: false, error: READ_ONLY_ERROR });
      }
    });
  }

  it('checks both the source and destination of a move', async () => {
    const { parent, root, writable } = makeTree();
    const policy: WritePolicy = { readOnlyRoots: [canonicalisePolicyPath(root)] };
    const protectedFile = path.join(root, 'nested', 'note.md');
    const writableFile = path.join(writable, 'note.md');
    fs.writeFileSync(writableFile, 'original');

    const fromProtected = await executeEdit(
      { op: 'move', target: protectedFile, destination: writable, destinationType: 'directory' },
      10,
      [parent],
      policy,
    );
    const intoProtected = await executeEdit(
      { op: 'move', target: writableFile, destination: root, destinationType: 'directory' },
      10,
      [parent],
      policy,
    );

    expect(fromProtected.error).toBe(READ_ONLY_ERROR);
    expect(intoProtected.error).toBe(READ_ONLY_ERROR);
  });

  it('does not let an overlapping writable silo unlock a protected path', async () => {
    const { parent, root } = makeTree();
    const file = path.join(root, 'nested', 'note.md');
    const result = await executeEdit(
      { op: 'overwrite', filePath: file, content: 'changed' },
      10,
      [parent, root],
      { readOnlyRoots: [canonicalisePolicyPath(root)] },
    );

    expect(result.error).toBe(READ_ONLY_ERROR);
    expect(fs.readFileSync(file, 'utf-8')).toBe('original');
  });

  it.skipIf(process.platform !== 'win32')(
    'rejects a junction which points into a protected root',
    async () => {
      const { parent, root, writable } = makeTree();
      const junction = path.join(writable, 'mail-link');
      fs.symlinkSync(root, junction, 'junction');

      const result = await executeEdit(
        { op: 'overwrite', filePath: path.join(junction, 'nested', 'note.md'), content: 'changed' },
        10,
        [parent],
        { readOnlyRoots: [canonicalisePolicyPath(root)] },
      );

      expect(result.error).toBe(READ_ONLY_ERROR);
    },
  );
});
