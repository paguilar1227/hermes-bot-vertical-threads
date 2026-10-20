import { build } from 'esbuild'
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  format: 'esm',
  target: 'es2022',
  external: ['react', 'react/jsx-runtime'],
  sourcemap: true,
})
