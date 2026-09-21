import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// The bank is built once and served by its own Node server, which injects the lab's
// runtime configuration into index.html. No dev server is involved in verification.
export default defineConfig({
  root: here,
  plugins: [react()],
  build: { outDir: resolve(here, 'dist'), emptyOutDir: true, sourcemap: false }
});
