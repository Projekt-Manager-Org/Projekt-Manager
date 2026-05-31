/**
 * Demo title card 00 — Auftakt (cold open). The human hook before the
 * walkthrough: you have work to do; the software bends to you. A styled
 * full-screen card over a darkened jobsite backdrop, recorded like a
 * segment (desktop, 1920×1080) so the master concat picks it up first by
 * its numeric prefix.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BG = fs
  .readFileSync(path.resolve(__dirname, '..', 'scripts', 'demo', 'assets', 'phone-backdrop.jpg'))
  .toString('base64');

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#070b13;}
  .card{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
    background:linear-gradient(rgba(7,11,19,0.84),rgba(7,11,19,0.90)),url(data:image/jpeg;base64,${BG});
    background-size:cover;background-position:center;
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#fff;text-align:center;padding:0 9%;
    opacity:0;animation:fade 0.8s ease forwards;}
  @keyframes fade{to{opacity:1;}}
  .lead{font-size:30px;font-weight:500;color:#aebfd6;margin-bottom:22px;letter-spacing:0.3px;}
  .big{font-size:60px;font-weight:700;line-height:1.22;max-width:20ch;}
  .hl{color:#6ea8fe;}
</style></head><body><div class="card">
  <div class="lead">»Ich habe zu arbeiten.«</div>
  <div class="big">Darum passt sich die Software an <span class="hl">Sie</span> an.</div>
</div></body></html>`;

test.use({ storageState: { cookies: [], origins: [] } });

test('00 — Auftakt', async ({ page }) => {
  await page.setContent(HTML);
  await page.waitForTimeout(5000);
});
