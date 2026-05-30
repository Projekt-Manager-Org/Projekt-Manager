#!/usr/bin/env node
/**
 * Demo post-processing — turn Playwright's raw `video.webm` recordings
 * into a shareable film, a README hero loop, and (optionally) per-clip
 * MP4s.
 *
 * Captions, persona chips, and the data-reveal cards are burned into the
 * recording by the demo overlay, so there is no sidecar to emit here.
 *
 * The master is built in ONE ffmpeg pass — every source clip is normalized
 * onto the 1920×1080 canvas and concatenated inside a single filtergraph,
 * then encoded once. The old pipeline re-encoded three times (webm→mp4,
 * →norm, →concat); each lossy generation smeared text and bred mosquito
 * noise. One decode → one filter → one high-quality H.264 encode keeps the
 * type crisp; Vimeo re-encodes on its side, so a generous master bitrate
 * is exactly what we want to hand it.
 *
 * Modes:
 *   node scripts/demo/encode.mjs            # transcode each clip → demo.mp4
 *   node scripts/demo/encode.mjs --reel     # + stitch same-res reels
 *   node scripts/demo/encode.mjs --master   # one 16:9 master (single pass)
 *   node scripts/demo/encode.mjs --hero     # README hero loop (animated webp)
 *
 * --hero options (override the baked defaults for quick iteration). The
 * defaults reproduce the committed `assets/demo-hero.webp`: the Daten
 * reveal arc (frosted board → fact cards → closing thesis), large and
 * readable — deliberately NOT the dense kanban, whose text is unreadable
 * once downscaled.
 *   --hero-clip=<substr>  source clip whose path contains this (default: daten)
 *   --hero-ss=<sec>       start offset into that clip
 *   --hero-dur=<sec>      loop duration
 *   --hero-width=<px>     output width (height auto, even)
 *   --hero-fps=<n>        frames per second (lower = smaller file)
 *   --hero-q=<0-100>      libwebp quality (higher = better + bigger)
 *   --hero-static         emit a single crisp frame instead of a loop
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
const makeHero = args.includes('--hero');
const resultsDir = path.resolve(repoRoot, 'test-results');

/** Read a `--flag=value` override, or `fallback` if absent. */
function argVal(name, fallback) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

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

/** Recursively collect every file named `name` under `dir`, sorted. */
function findNamed(dir, name) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findNamed(full, name));
    else if (entry.name === name) out.push(full);
  }
  return out.sort();
}

const findVideos = (dir) => findNamed(dir, 'video.webm');
const findMp4s = (dir) => findNamed(dir, 'demo.mp4');

/** `WIDTHxHEIGHT` of the first video stream. */
function dimensions(file) {
  return execFileSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file],
    { encoding: 'utf8' },
  ).trim();
}

/** Run ffmpeg quietly (errors only), streaming its stderr on failure. */
function ff(ffArgs) {
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...ffArgs], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

const CW = 1920;
const CH = 1080;
// App's dark navy — desktop letterbox bars blend into the chrome.
const PAD_COLOR = '0x0e1525';

/**
 * Per-clip normalization branch for the master filtergraph. Desktop clips
 * scale+pad into the canvas; the phone clip composites onto a blurred,
 * darkened jobsite backdrop with a thin white bezel, reading as a phone
 * held on-site. `bgInput` is the ffmpeg input index of the backdrop image.
 * Every branch ends at 1920×1080 / 30fps / yuv420p / SAR 1:1 so the concat
 * filter accepts them without a parameter-mismatch reject.
 */
function normBranch(i, portrait, bgInput) {
  if (portrait) {
    return [
      `[${bgInput}:v]scale=${CW}:${CH}:force_original_aspect_ratio=increase,crop=${CW}:${CH},` +
        `boxblur=18:2,eq=brightness=-0.25,setsar=1[bg${i}]`,
      `[${i}:v]scale=-2:960,pad=iw+10:ih+10:5:5:color=white[ph${i}]`,
      // overlay's default eof_action=repeat holds the single backdrop frame
      // for the whole phone clip, so the still bg lasts the segment.
      `[bg${i}][ph${i}]overlay=(W-w)/2:(H-h)/2,fps=30,format=yuv420p,setsar=1[v${i}]`,
    ];
  }
  return [
    `[${i}:v]scale=${CW}:${CH}:force_original_aspect_ratio=decrease,` +
      `pad=${CW}:${CH}:(ow-iw)/2:(oh-ih)/2:color=${PAD_COLOR},fps=30,format=yuv420p,setsar=1[v${i}]`,
  ];
}

/** Build the single-pass 1920×1080 master from `clips` (narrative order). */
function buildMaster(clips) {
  const backdrop = path.resolve(repoRoot, 'scripts', 'demo', 'assets', 'phone-backdrop.jpg');
  if (!fs.existsSync(backdrop)) fail(`Phone backdrop missing: ${path.relative(repoRoot, backdrop)}`);

  const shapes = clips.map((clip) => {
    const [w, h] = dimensions(clip).split('x').map(Number);
    return { clip, portrait: h > w };
  });

  // One backdrop input shared by the (single) phone clip. A second phone
  // clip would consume the same filter output twice — illegal without a
  // `split`. Guard loudly rather than emit a broken graph.
  if (shapes.filter((s) => s.portrait).length > 1) {
    fail('buildMaster: more than one phone clip — add a backdrop split branch first.');
  }

  const bgInput = clips.length; // backdrop is appended after all clips
  const inputs = clips.flatMap((c) => ['-i', c]);
  inputs.push('-i', backdrop);

  const branches = [];
  const concatLabels = [];
  shapes.forEach(({ portrait }, i) => {
    branches.push(...normBranch(i, portrait, bgInput));
    concatLabels.push(`[v${i}]`);
  });
  const filter =
    branches.join(';') + ';' + concatLabels.join('') + `concat=n=${clips.length}:v=1[v]`;

  const master = path.join(resultsDir, 'demo-master.mp4');
  console.log(`Building master from ${clips.length} segment(s) → ${CW}×${CH} (single pass).`);
  shapes.forEach(({ clip, portrait }) =>
    console.log(`  · ${portrait ? 'phone ' : 'screen'} ${path.relative(repoRoot, clip)}`),
  );
  ff([
    ...inputs,
    '-filter_complex',
    filter,
    '-map',
    '[v]',
    '-c:v',
    'libx264',
    '-crf',
    '17',
    '-preset',
    'slow',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-an',
    master,
  ]);
  console.log(`★ ${path.relative(repoRoot, master)} (${clips.length} segments)`);
  return master;
}

/**
 * Build the README hero from a source clip window. Sourced from the raw
 * webm (no intermediate H.264) so the still is as crisp as the recording.
 * Animated by default; `--hero-static` emits a single frame. Output is
 * always `assets/demo-hero.webp` so the README `<img src>` is unchanged.
 */
function buildHero(clips) {
  const clipMatch = argVal('hero-clip', 'daten');
  const src = clips.find((p) => p.includes(clipMatch));
  if (!src) fail(`--hero: no source clip matching "${clipMatch}" under test-results/.`);

  const width = Number(argVal('hero-width', '1280'));
  const out = path.resolve(repoRoot, 'assets', 'demo-hero.webp');
  const isStatic = args.includes('--hero-static');

  if (isStatic) {
    // Land on the settled reveal (all cards + closing line) for a static poster.
    const ss = Number(argVal('hero-ss', '11.4'));
    console.log(`Hero (static): ${path.relative(repoRoot, src)} @ ${ss}s → ${width}px`);
    ff([
      '-ss',
      String(ss),
      '-i',
      src,
      '-frames:v',
      '1',
      '-vf',
      `scale=${width}:-2:flags=lanczos`,
      '-c:v',
      'libwebp',
      '-lossless',
      '0',
      '-q:v',
      argVal('hero-q', '90'),
      '-compression_level',
      '6',
      out,
    ]);
  } else {
    const ss = Number(argVal('hero-ss', '3.3'));
    const dur = Number(argVal('hero-dur', '8.3'));
    const fps = Number(argVal('hero-fps', '15'));
    console.log(
      `Hero (loop): ${path.relative(repoRoot, src)} @ ${ss}s +${dur}s · ${width}px · ${fps}fps`,
    );
    ff([
      '-ss',
      String(ss),
      '-t',
      String(dur),
      '-i',
      src,
      '-an',
      '-vf',
      `fps=${fps},scale=${width}:-2:flags=lanczos`,
      '-c:v',
      'libwebp_anim',
      '-lossless',
      '0',
      '-q:v',
      argVal('hero-q', '90'),
      '-compression_level',
      '6',
      '-loop',
      '0',
      out,
    ]);
  }

  const bytes = fs.statSync(out).size;
  const mb = (bytes / 1024 / 1024).toFixed(2);
  console.log(`★ ${path.relative(repoRoot, out)} (${mb} MB)`);
  // GitHub's camo image proxy gets unreliable for very large animations.
  if (!isStatic && bytes > 5 * 1024 * 1024) {
    console.warn(
      `⚠ hero is ${mb} MB — over ~5 MB GitHub may not animate it inline. ` +
        `Lower --hero-q / --hero-fps / --hero-width, or use --hero-static.`,
    );
  }
}

requireTool('ffmpeg');
requireTool('ffprobe');

const videos = findVideos(resultsDir);

// --master and --hero source the raw webm directly (least loss). Fall back
// to already-transcoded demo.mp4 only if no webm survives a fresh record.
const masterSources = videos.length > 0 ? videos : findMp4s(resultsDir);

if (makeHero) {
  if (masterSources.length === 0) {
    fail(
      `No recordings under ${path.relative(repoRoot, resultsDir)}/ — run the demo first:\n` +
        `  npm run demo:record`,
    );
  }
  buildHero(masterSources);
}

if (makeMaster) {
  if (masterSources.length === 0) fail('No clips to master — run `npm run demo:record` first.');
  buildMaster(masterSources);
}

// Per-clip transcode (default + --reel). Skipped when only mastering/hero,
// since those read the webm straight and the demo.mp4 siblings aren't needed.
const wantTranscode = !makeMaster && !makeHero ? true : makeReel;
let produced = [];
if (wantTranscode) {
  if (videos.length === 0) fail(`No video.webm under ${path.relative(repoRoot, resultsDir)}/.`);
  console.log(`Found ${videos.length} recording(s).`);
  for (const webm of videos) {
    const mp4 = path.join(path.dirname(webm), 'demo.mp4');
    console.log(`→ ${path.relative(repoRoot, mp4)}`);
    ff([
      '-i',
      webm,
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      // H.264 + yuv420p needs even dimensions; phone viewports can be odd
      // (Pixel 7 is 412×839), so round each axis down to the nearest even pixel.
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-movflags',
      '+faststart',
      mp4,
    ]);
    produced.push(mp4);
  }
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
    ff(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', reel]);
    fs.rmSync(listFile, { force: true });
    console.log(`★ ${path.relative(repoRoot, reel)} (${clips.length} clips)`);
  }
}

console.log('Done.');
