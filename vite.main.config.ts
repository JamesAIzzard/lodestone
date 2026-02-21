import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      // Modules that must NOT be bundled:
      //   - @huggingface/transformers + ONNX: native bindings, complex module resolution
      //   - chokidar: native file-watching (uses fs events)
      //   - web-tree-sitter: ships a companion tree-sitter.wasm file that Emscripten
      //     locates relative to the JS module. If bundled, the WASM path breaks.
      external: [
        '@huggingface/transformers',
        'onnxruntime-node',
        'onnxruntime-common',
        'onnxruntime-web',
        'chokidar',
        'web-tree-sitter',
      ],
    },
  },
});
