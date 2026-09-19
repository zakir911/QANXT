import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

/**
 * Bundles each extension entry point separately.
 *
 * MV3 runs the service worker, the content script and the popup in different contexts with
 * different globals, so they cannot share a bundle. Each is built standalone, and the code
 * they genuinely share lives in modules imported by both.
 */
await mkdir('dist', { recursive: true });

const common = {
  bundle: true,
  format: 'esm',
  target: 'chrome116',
  sourcemap: true,
  logLevel: 'info'
};

await Promise.all([
  build({ ...common, entryPoints: ['src/background.ts'], outfile: 'dist/background.js' }),
  // The content script runs in the page and cannot be a module, so it is built as IIFE.
  build({ ...common, entryPoints: ['src/content.ts'], outfile: 'dist/content.js', format: 'iife' }),
  build({ ...common, entryPoints: ['src/popup.ts'], outfile: 'dist/popup.js' })
]);

console.log('Extension bundles written to dist/.');
