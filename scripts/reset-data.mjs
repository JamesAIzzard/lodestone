#!/usr/bin/env node

/**
 * Wipes all Lodestone user data (config, silo databases, model cache).
 * Usage: npm run reset-data
 *
 * Safe for development — only touches %APPDATA%/Lodestone.
 */

import fs from 'node:fs';
import path from 'node:path';

const appData = process.env.APPDATA ?? process.env.HOME;
const dataDir = path.join(appData, 'Lodestone');

if (!fs.existsSync(dataDir)) {
  console.log('Nothing to reset — %APPDATA%/Lodestone does not exist.');
  process.exit(0);
}

const targets = ['config.toml', 'silos', 'model-cache'];

let removed = 0;
for (const name of targets) {
  const target = path.join(dataDir, name);
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`  removed: ${name}`);
    removed++;
  }
}

if (removed === 0) {
  console.log('Nothing to reset — no config, silos, or model cache found.');
} else {
  console.log(`\nDone. Removed ${removed} item(s). Restart the app to go through onboarding again.`);
}
