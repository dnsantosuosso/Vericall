// Build script for the VeriCall Chrome extension.
// Bundles the TypeScript entry points with esbuild and copies static assets
// into dist/, which is the folder you load as an "unpacked extension" in Chrome.
import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outdir = join(__dirname, 'dist');
const watch = process.argv.includes('--watch');

// Each entry point is bundled into a single self-contained IIFE file so it can
// be loaded directly by Chrome (no runtime module resolution needed).
const entryPoints = {
  background: 'extension/background.ts',
  contentScript: 'extension/contentScript.ts',
  popup: 'extension/popup/popup.ts',
};

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints,
  outdir,
  bundle: true,
  format: 'iife',
  target: ['chrome110'],
  sourcemap: true,
  logLevel: 'info',
  // The relay server URL can be overridden at build time for remote demos.
  define: {
    'process.env.VERICALL_RELAY_URL': JSON.stringify(
      process.env.VERICALL_RELAY_URL ?? 'ws://localhost:8787',
    ),
  },
};

async function copyStatic() {
  await cp('extension/manifest.json', join(outdir, 'manifest.json'));
  await cp('extension/popup/popup.html', join(outdir, 'popup.html'));
  await cp('extension/popup/popup.css', join(outdir, 'popup.css'));
  await cp('extension/icons', join(outdir, 'icons'), { recursive: true });
}

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  await copyStatic();
  console.log('[build] watching for changes…');
} else {
  await esbuild.build(options);
  await copyStatic();
  console.log('[build] done → dist/');
}
