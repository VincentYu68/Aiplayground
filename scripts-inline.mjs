// Bundle a Vite build into one self-contained page for artifact hosting.
//
// Composed explicitly rather than by rewriting the built HTML: the bundle
// contains HTML strings of its own (the printable manual generator emits
// <style> and <body>), so any regex run over the combined document matches
// inside the script and corrupts the output.

import fs from 'node:fs';
import path from 'node:path';

const dist = process.argv[2];
const outFile = process.argv[3];
if (!dist || !outFile) {
  console.error('usage: node scripts-inline.mjs <distDir> <outFile>');
  process.exit(1);
}

const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const asset = (href) => fs.readFileSync(path.join(dist, href.replace(/^[./]+/, '')), 'utf8');

const title = (html.match(/<title>([\s\S]*?)<\/title>/) || [, 'Brickify'])[1];
const cssHrefs = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
const jsSrcs = [...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)].map((m) => m[1]);

if (jsSrcs.length !== 1) throw new Error(`expected exactly one module script, got ${jsSrcs.length}`);

const css = cssHrefs.map(asset).join('\n');
let js = asset(jsSrcs[0]);

// A literal </script> anywhere in the bundle would close the tag early.
js = js.replace(/<\/script>/gi, '<\\/script>');

const page = `<title>${title}</title>
<style>
${css}
</style>
<div id="root"></div>
<script type="module">
${js}
</script>
`;

fs.writeFileSync(outFile, page);

// Guard against anything that would need a network fetch: the artifact host
// blocks every external request, so a missed asset is a blank page.
const external = page.match(/(?:src|href)="(?!data:|#)[^"]*\.(?:js|css|png|jpe?g|svg|woff2?)"/g);
if (external) throw new Error(`page still references external assets: ${external.join(', ')}`);

console.log(`${outFile}: ${(Buffer.byteLength(page) / 1024 / 1024).toFixed(2)} MB`);
