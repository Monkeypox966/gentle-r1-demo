import { defineConfig } from 'vite';

export default defineConfig({
  base: '/gentle-r1-demo/',
  assetsInclude: ['**/*.wasm'],
  optimizeDeps: { exclude: ['@mujoco/mujoco', 'onnxruntime-web'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 1800 },
  server: { host: '127.0.0.1' },
});
