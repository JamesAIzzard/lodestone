import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { rebuild } from '@electron/rebuild';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// Modules that Vite leaves as external require() calls.  These need to be
// present in the packaged app's node_modules/ so they resolve at runtime.
// The Vite plugin only copies .vite/ build output — it does NOT ship
// node_modules, so we install these in the afterCopy hook below.
const EXTERNAL_MODULES = [
  'better-sqlite3',
  'sqlite-vec',
  '@huggingface/transformers',
  'onnxruntime-node',
  'onnxruntime-common',
  'onnxruntime-web',
  'chokidar',
  'web-tree-sitter',
  'tree-sitter-wasms',
];

const config: ForgeConfig = {
  packagerConfig: {
    extraResource: ['mcp-wrapper.js'],
    asar: {
      // AutoUnpackNativesPlugin handles .node files.  We additionally need
      // .dll/.dylib/.so for sqlite-vec and .wasm for tree-sitter — these are
      // loaded by native code (SQLite loadExtension / WASM runtimes) that
      // can't read from inside an ASAR archive.
      unpack: '**/*.{dll,dylib,so,wasm}',
    },
    // This hook fires AFTER the Vite plugin has copied .vite/ and
    // package.json to the build directory — so package.json is guaranteed
    // to exist.  We install the external deps and then rebuild native
    // modules against Electron's ABI (npm installs them for Node.js ABI).
    afterCopy: [
      (buildPath: string, electronVersion: string, platform: string, arch: string, callback: (err?: Error) => void) => {
        (async () => {
          const pkgPath = path.join(buildPath, 'package.json');
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

          const filteredDeps: Record<string, string> = {};
          for (const mod of EXTERNAL_MODULES) {
            if (pkg.dependencies?.[mod]) {
              filteredDeps[mod] = pkg.dependencies[mod];
            }
          }

          // Rewrite package.json with only the external deps so npm doesn't
          // install everything Vite already bundled.
          const minimalPkg = {
            name: pkg.name,
            productName: pkg.productName,
            version: pkg.version,
            description: pkg.description,
            author: pkg.author,
            license: pkg.license,
            main: pkg.main,
            dependencies: filteredDeps,
          };

          fs.writeFileSync(pkgPath, JSON.stringify(minimalPkg, null, 2));

          console.log(`\n[forge] Installing ${Object.keys(filteredDeps).length} external native modules...`);
          execSync('npm install --omit=dev', {
            cwd: buildPath,
            stdio: 'inherit',
          });

          // Rebuild native .node binaries against Electron's ABI.
          // npm installed them for Node.js ABI, but Electron uses a
          // different NODE_MODULE_VERSION.
          console.log(`\n[forge] Rebuilding native modules for Electron ${electronVersion}...`);
          await rebuild({
            buildPath,
            electronVersion,
            arch,
          });

          callback();
        })().catch(callback);
      },
    ],
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        {
          entry: 'src/backend/embedding-worker.ts',
          config: 'vite.worker.config.ts',
          target: 'main',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
