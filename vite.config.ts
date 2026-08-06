import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  // onnxruntime's default entry point inlines a 27MB WebGPU-capable binary into
  // the bundle. This condition selects the build that loads its .wasm as a
  // separate file, which is what we want: we serve a single 13MB runtime from
  // public/ort/ and the browser caches it independently of the app code.
  resolve: {
    conditions: ['onnxruntime-web-use-extern-wasm'],
  },
  optimizeDeps: {
    esbuildOptions: {
      conditions: ['onnxruntime-web-use-extern-wasm'],
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
  worker: {
    format: 'es',
  },
});
