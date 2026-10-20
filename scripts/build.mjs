import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  format: 'esm',
  target: 'es2022',
  external: ['react', 'react/jsx-runtime'],
  sourcemap: true,
})
await build({
  entryPoints: ['src/plugin.tsx'], outfile: 'desktop/plugin.js', bundle: true,
  format: 'esm', target: 'es2022', jsx: 'automatic',
  external: ['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  define: { __PLUGIN_CSS__: JSON.stringify(await readFile('src/threads.css', 'utf8')) },
})
