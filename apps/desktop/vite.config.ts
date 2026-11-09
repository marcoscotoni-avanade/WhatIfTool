import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: Object.fromEntries(['domain', 'scheduling', 'risk', 'scenarios', 'persistence']
      .map(name => [`@planner/${name}`, fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url))])),
  },
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  build: {
    outDir: 'dist', emptyOutDir: true, target: 'es2022',
    rollupOptions: { output: { manualChunks: {
      elk: ['elkjs/lib/elk.bundled.js'], grid: ['ag-grid-community', 'ag-grid-react'],
      graph: ['@xyflow/react'], sqlite: ['sql.js'],
    } } },
  },
  worker: { format: 'es' },
});
