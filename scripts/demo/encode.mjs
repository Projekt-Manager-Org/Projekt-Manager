#!/usr/bin/env node
/**
 * Demo post-processing — turn Playwright's raw `video.webm` recordings
 * into shareable MP4s, and (optionally) stitch same-resolution clips
 * into a single reel.
 *
 * Captions are burned into the recording by the demo overlay, so there
 * is no sidecar to emit here.
 *
 * Pipeline:
 *   1. Walk `test-results/` for every `video.webm`.
 *   2. Transcode each to a sibling `demo.mp4` (H.264 + faststart — plays
 *      everywhere, seeks instantly).
 *   3. With `--reel`, concatenate the produced MP4s into one reel per
 *      resolution group (concat needs matching dimensions), written to
 *      `test-results/demo-reel-<WxH>.mp4`.
 *
 * Usage:
 *   node scripts/demo/encode.mjs            # transcode
 *   node scripts/demo/encode.mjs --reel     # + stitch reels
 *
 * Requires `ffmpeg` and `ffprobe` on PATH.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const args = process.argv.slice(2);
const makeReel = args.includes('--reel');
const resultsDir = path.resolve(repoRoot, 'test-results');

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function requireTool(tool) {
  try {
    execFileSync(tool, ['-version'], { stdio: 'ignore' });
  } catch {
    fail(`${tool} not found on PATH — install ffmpeg (provides ffmpeg + ffprobe).`);
  }
}

/** Recursively collect every `video.webm` under `dir`. */
function findVideos(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findVideos(full));
    else if (entry.name === 'video.webm') out.push(full);
  }
  return out;
}

/** `WIDTHxHEIGHT` of the first video stream. */
function dimensions(mp4) {
  const out = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=p=0:s=x',
      mp4,
    ],
    { encoding: 'utf8' },
  ).trim();
  return out;
}

requireTool('ffmpeg');
requireTool('ffprobe');

const videos = findVideos(resultsDir);
if (videos.length === 0) {
  fail(
    `No video.webm under ${path.relative(repoRoot, resultsDir)}/ — run the demo first:\n` +
      `  PLAYWRIGHT_RUN_DEMO=1 npx playwright test --project=demo --project=demo-mobile`,
  );
}

console.log(`Found ${videos.length} recording(s).`);
const produced = [];

for (const webm of videos) {
  const dir = path.dirname(webm);
  const mp4 = path.join(dir, 'demo.mp4');
  console.log(`→ ${path.relative(repoRoot, mp4)}`);
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-i',
      webm,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      // H.264 + yuv420p needs even dimensions; phone viewports can be odd
      // (Pixel 7 is 412×839), so round each axis down to the nearest even
      // pixel — at most a 1 px trim, imperceptible.
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-movflags',
      '+faststart',
      mp4,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );

  produced.push(mp4);
}

if (makeReel && produced.length > 0) {
  // Concat needs identical dimensions/codec; group by resolution.
  const groups = new Map();
  for (const mp4 of produced) {
    const dim = dimensions(mp4);
    if (!groups.has(dim)) groups.set(dim, []);
    groups.get(dim).push(mp4);
  }

  for (const [dim, clips] of groups) {
    if (clips.length < 2) {
      console.log(`(skip reel for ${dim}: only ${clips.length} clip)`);
      continue;
    }
    clips.sort();
    const listFile = path.join(resultsDir, `reel-${dim}.txt`);
    fs.writeFileSync(listFile, clips.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join('\n'));
    const reel = path.join(resultsDir, `demo-reel-${dim}.mp4`);
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listFile,
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        reel,
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    fs.rmSync(listFile, { force: true });
    console.log(`★ ${path.relative(repoRoot, reel)} (${clips.length} clips)`);
  }
}

console.log('Done.');
