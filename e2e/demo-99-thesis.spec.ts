/**
 * Demo title card 99 — Vertrauen (closing thesis). The two theses
 * converge: built around you, and built to be distrusted — which is why
 * the data is safe. Recorded like a segment (desktop, 1920×1080); the
 * numeric prefix places it last in the master concat.
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
    background:linear-gradient(rgba(7,11,19,0.86),rgba(7,11,19,0.92)),url(data:image/jpeg;base64,${BG});
    background-size:cover;background-position:center;
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#fff;text-align:center;padding:0 9%;
    opacity:0;animation:fade 0.8s ease forwards;}
  @keyframes fade{to{opacity:1;}}
  .big{font-size:62px;font-weight:700;line-height:1.2;}
  .sub{font-size:28px;font-weight:500;color:#aebfd6;margin-top:20px;max-width:30ch;}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:18px;color:#7d92b0;
    margin-top:46px;max-width:62ch;line-height:1.6;}
  .hl{color:#6ea8fe;}
</style></head><body><div class="card">
  <div class="big">Für <span class="hl">Sie</span> gebaut.</div>
  <div class="sub">Sie passt sich an, wie Sie arbeiten – nicht umgekehrt.</div>
  <div class="mono">Gebaut, um misstraut zu werden: verschlüsselt · VPN-only · täglich gesichert und providerseitig gesperrt. Darum sicher.</div>
</div></body></html>`;

test.use({ storageState: { cookies: [], origins: [] } });

test('99 — Vertrauen', async ({ page }) => {
  await page.setContent(HTML);
  await page.waitForTimeout(6000);
});
