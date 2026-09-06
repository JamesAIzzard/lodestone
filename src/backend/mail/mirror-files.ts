import { constants } from 'node:fs';
import { access, mkdir, open, readdir, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface MirrorDirs {
  mirror: string;
  tmp: string;
}

export async function ensureDirs(dirs: MirrorDirs): Promise<void> {
  await Promise.all([
    mkdir(dirs.mirror, { recursive: true }),
    mkdir(dirs.tmp, { recursive: true }),
  ]);
}

export async function writeMirrorFile(
  dirs: MirrorDirs,
  fileName: string,
  content: string,
): Promise<void> {
  await ensureDirs(dirs);
  const temporaryPath = path.join(dirs.tmp, `${fileName}.${randomUUID()}`);
  const handle = await open(temporaryPath, 'wx');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await renameWithRetry(temporaryPath, path.join(dirs.mirror, fileName));
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function deleteMirrorFile(dirs: MirrorDirs, fileName: string): Promise<void> {
  try {
    await unlink(path.join(dirs.mirror, fileName));
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
}

export async function cleanTmp(dirs: MirrorDirs): Promise<void> {
  await ensureDirs(dirs);
  const names = await readdir(dirs.tmp);
  await Promise.all(
    names.map((name) => rm(path.join(dirs.tmp, name), { recursive: true, force: true })),
  );
}

export async function mirrorFileExists(dirs: MirrorDirs, fileName: string): Promise<boolean> {
  try {
    await access(path.join(dirs.mirror, fileName), constants.F_OK);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

export async function listMirrorFiles(dirs: MirrorDirs): Promise<string[]> {
  await ensureDirs(dirs);
  return readdir(dirs.mirror);
}

async function renameWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (attempt >= 2 || (!isNodeError(error, 'EPERM') && !isNodeError(error, 'EBUSY'))) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
