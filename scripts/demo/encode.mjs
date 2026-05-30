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
 *   4. With `--master`, normalize every clip onto a uniform 1920×1080
 *      canvas — desktop padded with the app's dark navy, phone clips
 *      composited onto a blurred construction backdrop — and concatenate
 *      them in segment order into `test-results/demo-master.mp4`.
 *
 * Usage:
 *   node scripts/demo/encode.mjs            # transcode
 *   node scripts/demo/encode.mjs --reel     # + stitch same-res reels
 *   node scripts/demo/encode.mjs --master   # + stitch one 16:9 master
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
const makeMaster = args.includes('--master');
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

/** Run ffmpeg quietly (errors only), streaming its stderr on failure. */
function ff(ffArgs) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...ffArgs], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

/** Recursively collect every transcoded `demo.mp4` under `dir`. */
function findMp4s(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findMp4s(full));
    else if (entry.name === 'demo.mp4') out.push(full);
  }
  return out;
}

requireTool('ffmpeg');
requireTool('ffprobe');

const videos = findVideos(resultsDir);
if (videos.length === 0) {
  // `--master` may re-stitch already-transcoded clips without a fresh record.
  const existing = makeMaster ? findMp4s(resultsDir) : [];
  if (existing.length === 0) {
    fail(
      `No video.webm under ${path.relative(repoRoot, resultsDir)}/ — run the demo first:\n` +
        `  PLAYWRIGHT_RUN_DEMO=1 npx playwright test --project=demo --project=demo-mobile`,
    );
  }
  console.log('No new recordings — mastering existing demo.mp4 clips.');
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
      '-hide_banner',
      '-loglevel',
      'error',
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

if (makeMaster) {
  // Segments are recorded at mixed resolutions (16:9 desktop, portrait phone);
  // a single seamless master needs every clip on one canvas. Desktop clips
  // scale+pad into 1920×1080; phone clips sit on a blurred construction
  // backdrop. Order is lexical — segment specs carry zero-padded numeric
  // prefixes (demo-01…demo-06), so path order is narrative order.
  const clips = (produced.length > 0 ? [...produced] : findMp4s(resultsDir)).sort();
  if (clips.length === 0) fail('No demo.mp4 clips to master.');

  const backdrop = path.resolve(repoRoot, 'scripts', 'demo', 'assets', 'phone-backdrop.jpg');
  if (!fs.existsSync(backdrop)) {
    fail(`Phone backdrop missing: ${path.relative(repoRoot, backdrop)}`);
  }

  const CW = 1920;
  const CH = 1080;
  console.log(`Building master from ${clips.length} segment(s) → ${CW}×${CH}.`);

  const norms = clips.map((clip, i) => {
    const [w, h] = dimensions(clip).split('x').map(Number);
    const portrait = h > w;
    const out = path.join(resultsDir, `master-norm-${String(i).padStart(2, '0')}.mp4`);
    console.log(`  · ${portrait ? 'phone ' : 'screen'} ${path.relative(repoRoot, clip)}`);
    if (portrait) {
      ff([
        '-y',
        '-i',
        clip,
        '-i',
        backdrop,
        '-filter_complex',
        `[1:v]scale=${CW}:${CH}:force_original_aspect_ratio=increase,crop=${CW}:${CH},` +
          `boxblur=18:2,eq=brightness=-0.25[bg];` +
          `[0:v]scale=-2:960,pad=iw+10:ih+10:5:5:color=white[ph];` +
          `[bg][ph]overlay=(W-w)/2:(H-h)/2,fps=30,format=yuv420p,setsar=1[v]`,
        '-map',
        '[v]',
        '-c:v',
        'libx264',
        '-crf',
        '20',
        '-preset',
        'veryfast',
        '-an',
        out,
      ]);
    } else {
      ff([
        '-y',
        '-i',
        clip,
        '-vf',
        `scale=${CW}:${CH}:force_original_aspect_ratio=decrease,` +
          `pad=${CW}:${CH}:(ow-iw)/2:(oh-ih)/2:color=0x0e1525,fps=30,format=yuv420p,setsar=1`,
        '-c:v',
        'libx264',
        '-crf',
        '20',
        '-preset',
        'veryfast',
        '-an',
        out,
      ]);
    }
    return out;
  });

  // Re-assert SAR on every input before concat — scale's aspect handling can
  // leave a near-1:1 SAR that the concat filter rejects as a parameter mismatch.
  const master = path.join(resultsDir, 'demo-master.mp4');
  const labels = norms.map((_, i) => `[${i}:v]setsar=1[v${i}]`).join(';');
  const chain = norms.map((_, i) => `[v${i}]`).join('') + `concat=n=${norms.length}:v=1[v]`;
  ff([
    '-y',
    ...norms.flatMap((n) => ['-i', n]),
    '-filter_complex',
    `${labels};${chain}`,
    '-map',
    '[v]',
    '-c:v',
    'libx264',
    '-crf',
    '20',
    '-preset',
    'veryfast',
    '-movflags',
    '+faststart',
    '-an',
    master,
  ]);
  norms.forEach((n) => fs.rmSync(n, { force: true }));
  console.log(`★ ${path.relative(repoRoot, master)} (${clips.length} segments)`);
}

console.log('Done.');
