import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      // @huggingface/transformers and its ONNX runtime dependencies have native
      // bindings and complex internal module resolution that cannot be bundled.
      external: [
        '@huggingface/transformers',
        'onnxruntime-node',
        'onnxruntime-common',
        'onnxruntime-web',
        'chokidar',
      ],
    },
  },
});
