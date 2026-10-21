/**
 * EN 16931 CII business-rule validation for tests (AC-293). Runs the
 * vendored CEN Schematron XSLT (`src/test/en16931/`) through SaxonJS.
 * Test-only: SaxonJS is proprietary and never ships in the runtime
 * (ADR-0026 §E-invoice format).
 *
 * `compileEn16931Rules()` compiles the XSLT to SEF once (a few seconds);
 * `validateEn16931()` then takes tens of milliseconds per document.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const SaxonJS = require('saxon-js') as {
  transform(
    options: { stylesheetText: string; sourceText: string; destination: 'serialized' },
    mode: 'sync',
  ): { principalResult: string };
};

const XSLT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'en16931',
  'EN16931-CII-validation.xslt',
);

export interface SchematronFinding {
  id: string;
  flag: string;
  text: string;
}

/** Compile the CEN rules to SEF; the returned text feeds `validateEn16931`. */
export function compileEn16931Rules(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'en16931-'));
  try {
    const sef = path.join(dir, 'cii.sef.json');
    execFileSync(
      process.execPath,
      [
        require.resolve('xslt3/xslt3.js'),
        `-xsl:${XSLT}`,
        `-export:${sef}`,
        '-nogo',
        '-relocate:on',
      ],
      { stdio: 'pipe' },
    );
    return readFileSync(sef, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every failed assert and successful report in the SVRL output. */
export function validateEn16931(sef: string, xml: string): SchematronFinding[] {
  const svrl = SaxonJS.transform(
    { stylesheetText: sef, sourceText: xml, destination: 'serialized' },
    'sync',
  ).principalResult;
  // No fired rule means the document matched no rule context (wrong root
  // or namespace) — an empty result would then pass vacuously.
  if (!svrl.includes('<svrl:fired-rule')) {
    throw new Error('validateEn16931: no EN 16931 rule fired — not a CII invoice?');
  }
  const findings: SchematronFinding[] = [];
  const re =
    /<svrl:(?:failed-assert|successful-report)\b([^>]*)>([\s\S]*?)<\/svrl:(?:failed-assert|successful-report)>/g;
  for (const m of svrl.matchAll(re)) {
    const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(m[1]!)?.[1] ?? '';
    const text = /<svrl:text>([\s\S]*?)<\/svrl:text>/.exec(m[2]!)?.[1]?.trim() ?? '';
    findings.push({ id: attr('id'), flag: attr('flag'), text });
  }
  return findings;
}
