import { defineConfig } from 'vite';

// Worker thread build config — mirrors vite.main.config.ts externals
// since the worker runs in the same Node.js context and needs the
// same native/complex dependencies left unbundled.
export default defineConfig({
  build: {
    rollupOptions: {
      external: [
        '@huggingface/transformers',
        'onnxruntime-node',
        'onnxruntime-common',
        'onnxruntime-web',
      ],
    },
  },
});
