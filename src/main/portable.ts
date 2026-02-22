/**
 * Portable / first-run data directory resolution.
 *
 * On first launch with no existing data, shows a native dialog letting the
 * user choose where Lodestone stores its data.
 *
 * Supports a "portable" mode where the data lives next to (or near) the
 * executable — useful when running without admin rights or from a USB drive.
 *
 * Resolution order (packaged builds only):
 *  1. `<exeDir>/lodestone-data-path.txt`   — custom path pointer (portable zip)
 *  2. `<exeDir>/../lodestone-data-path.txt` — custom path pointer (Squirrel install)
 *  3. `<exeDir>/data/`  exists with config.toml — auto-portable folder next to exe
 *  4. `<exeDir>/../data/` exists with config.toml — auto-portable (Squirrel parent dir)
 *  5. AppData config exists → use AppData (normal installed mode)
 *  6. None of the above → first-run setup dialog
 *
 * In dev mode (app.isPackaged === false) the resolution is always skipped
 * and normal AppData is used.
 */

import { app, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

const POINTER_FILENAME = 'lodestone-data-path.txt';
const AUTO_PORTABLE_DIRNAME = 'data';

// ── Helpers ──────────────────────────────────────────────────────────────────

function readPointerFile(pointerPath: string): string | null {
  try {
    const resolved = path.resolve(pointerPath);
    if (!fs.existsSync(resolved)) return null;
    const content = fs.readFileSync(resolved, 'utf-8').trim();
    if (content && fs.existsSync(content)) return content;
  } catch {
    // ignore read errors
  }
  return null;
}

function writePointerFile(dataDir: string): void {
  const exeDir = path.dirname(app.getPath('exe'));
  // Try next to exe first; fall back to parent (handles Squirrel's versioned folder).
  const candidates = [
    path.join(exeDir, POINTER_FILENAME),
    path.join(exeDir, '..', POINTER_FILENAME),
  ];

  for (const pointerPath of candidates) {
    try {
      fs.writeFileSync(path.resolve(pointerPath), dataDir, 'utf-8');
      console.log(`[portable] Wrote data dir pointer → ${path.resolve(pointerPath)}`);
      return;
    } catch (err) {
      console.warn(`[portable] Could not write pointer to ${pointerPath}:`, err);
    }
  }
}

/**
 * Suggest a sensible default data directory for first-run setup.
 * For Squirrel installs the exe lives inside an `app-X.Y.Z` versioned folder;
 * we suggest the *parent* so the data dir survives app updates.
 */
function suggestDefaultDataDir(): string {
  const exeDir = path.dirname(app.getPath('exe'));
  const exeDirName = path.basename(exeDir);
  const parentDir = path.resolve(path.join(exeDir, '..'));

  if (/^app-\d/.test(exeDirName)) {
    // Squirrel install layout: exe is in app-X.Y.Z/, parent is the stable root
    return path.join(parentDir, AUTO_PORTABLE_DIRNAME);
  }

  return path.join(exeDir, AUTO_PORTABLE_DIRNAME);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Determine the data directory to use, without showing any dialogs.
 * Returns null if no existing data directory is found (first run or
 * falling back to AppData).
 * Must only be called from a packaged build.
 */
export function detectExistingDataDir(): string | null {
  if (!app.isPackaged) return null;

  const exeDir = path.dirname(app.getPath('exe'));
  const parentDir = path.resolve(path.join(exeDir, '..'));

  // 1 & 2: Pointer files (custom / arbitrary paths)
  for (const dir of [exeDir, parentDir]) {
    const result = readPointerFile(path.join(dir, POINTER_FILENAME));
    if (result) {
      console.log(`[portable] Found pointer file → ${result}`);
      return result;
    }
  }

  // 3 & 4: Auto-portable `data/` folder (created by previous first-run "next to app" choice)
  for (const dir of [exeDir, parentDir]) {
    const dataDir = path.join(dir, AUTO_PORTABLE_DIRNAME);
    if (fs.existsSync(path.join(dataDir, 'config.toml'))) {
      console.log(`[portable] Found auto-portable data dir → ${dataDir}`);
      return dataDir;
    }
  }

  return null;
}

/**
 * Show the first-run data directory setup dialog.
 * Returns the chosen (and created) data directory path.
 *
 * The caller is responsible for calling `app.setPath('userData', result)`
 * if the result differs from the current userData path.
 */
export async function runFirstRunSetup(): Promise<string> {
  const suggested = suggestDefaultDataDir();
  const appData = app.getPath('userData');

  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: 'Welcome to Lodestone',
    message: 'Choose where Lodestone stores its data',
    detail:
      `Lodestone needs a folder to store its configuration, search databases, ` +
      `and model cache.\n\n` +
      `Next to this app (portable):\n  ${suggested}\n\n` +
      `System folder:\n  ${appData}\n\n` +
      `Choose "Next to app" if you're running without admin rights or want to ` +
      `keep everything in one place.`,
    buttons: ['Next to app', 'System folder', 'Choose folder…'],
    defaultId: 0,
    cancelId: 1,
  });

  if (response === 0) {
    // "Next to app" — create data/ folder; no pointer needed (auto-detected on restart)
    fs.mkdirSync(suggested, { recursive: true });
    console.log(`[portable] First run → data dir set to ${suggested}`);
    return suggested;
  }

  if (response === 1) {
    // "System folder" — use AppData, no extra files written
    console.log(`[portable] First run → using AppData: ${appData}`);
    return appData;
  }

  // response === 2: "Choose folder…"
  const pickResult = await dialog.showOpenDialog({
    title: 'Choose Lodestone Data Folder',
    defaultPath: suggested,
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Use This Folder',
  });

  if (!pickResult.canceled && pickResult.filePaths.length > 0) {
    const chosen = pickResult.filePaths[0];
    fs.mkdirSync(chosen, { recursive: true });
    // Only write a pointer for paths that aren't the auto-detectable `data/` location
    if (path.resolve(chosen) !== path.resolve(suggested)) {
      writePointerFile(chosen);
    }
    console.log(`[portable] First run → custom data dir: ${chosen}`);
    return chosen;
  }

  // User cancelled folder picker — fall back to "next to app"
  fs.mkdirSync(suggested, { recursive: true });
  console.log(`[portable] First run → cancelled picker, falling back to ${suggested}`);
  return suggested;
}
