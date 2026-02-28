import { defineConfig } from 'vite';

// Store worker build config — externalises native SQLite modules that
// must be loaded at runtime via node-gyp bindings, not bundled by Vite.
export default defineConfig({
  build: {
    rollupOptions: {
      external: [
        'better-sqlite3',
        'sqlite-vec',
      ],
    },
  },
});
