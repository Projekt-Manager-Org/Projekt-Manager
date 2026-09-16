/**
 * Rasterizes the SVG sources in public/ into the PNG icons the PWA
 * manifest declares (`ICONS` in src/config/pwaManifest.ts). Run
 * whenever the source SVGs change, and commit the output — nothing
 * regenerates these at build time.
 *
 * Usage: npm run gen:pwa-icons
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const outDir = path.join(publicDir, 'icons');

const targets = [
  { src: 'favicon.svg', size: 192, out: 'icon-192.png' },
  { src: 'favicon.svg', size: 512, out: 'icon-512.png' },
  { src: 'favicon-maskable.svg', size: 512, out: 'icon-maskable-512.png' },
];

await mkdir(outDir, { recursive: true });

for (const { src, size, out } of targets) {
  const svg = await readFile(path.join(publicDir, src));
  const png = await sharp(svg, { density: 384 })
    .resize(size, size, { fit: 'contain' })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(path.join(outDir, out), png);
  console.log(`wrote public/icons/${out} (${size}x${size})`);
}
