import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({entryPoints:['src/main/gif-worker.ts'],outfile:'dist/gif-worker.cjs',bundle:true,platform:'node',format:'cjs'});
await build({ entryPoints: ['src/main/index.ts'], outfile: 'dist/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], sourcemap: true });
await build({ entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
await build({ entryPoints: ['src/renderer/control.tsx','src/renderer/overlay.ts','src/renderer/card.ts'], outdir: 'dist', bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', jsxImportSource: 'preact', sourcemap: true });
for (const name of ['control.html', 'overlay.html', 'card.html', 'theme.css']) await copyFile(`src/renderer/${name}`, `dist/${name}`);
console.log('Desktop build complete');
