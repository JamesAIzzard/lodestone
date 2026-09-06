import type { Manifest } from './manifest';
import {
  cleanTmp,
  deleteMirrorFile,
  listMirrorFiles,
  mirrorFileExists,
  type MirrorDirs,
} from './mirror-files';

export async function repairManifest(manifest: Manifest, dirs: MirrorDirs): Promise<void> {
  await cleanTmp(dirs);
  for (const message of manifest.messages()) {
    if (!(await mirrorFileExists(dirs, message.fileName)))
      manifest.deleteMessage(message.messageKey);
  }

  const recordedFiles = new Set(manifest.messages().map((message) => message.fileName));
  for (const fileName of await listMirrorFiles(dirs)) {
    if (!recordedFiles.has(fileName)) await deleteMirrorFile(dirs, fileName);
  }
}
