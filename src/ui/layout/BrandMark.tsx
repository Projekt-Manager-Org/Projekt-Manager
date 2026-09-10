/**
 * The installation's brand mark (issue #189).
 *
 * Two rendering modes, picked by whether the deployment configured a
 * logo asset (`BRANDING.mark.logo`, ADR-0001 — customer specifics are
 * configuration, not business data):
 *
 *   - **Configured** — the logo image, visible at every viewport width.
 *     A company that supplied its own mark wants it on screen next to
 *     the wordmark, not only on the mobile breakpoint.
 *   - **Unconfigured** — the generic three-bar SVG painted from
 *     `BRANDING.mark.bg` / `.bars`, which stays hidden above the
 *     wordmark breakpoint exactly as it did before this component
 *     existed. This is what the repo ships: the pilot company's asset
 *     is private and lives only in its own deployment.
 *
 * A configured-but-unloadable asset falls back to the generic mark
 * rather than leaving a broken image in the header of every page — a
 * deployment typo should degrade, not deface. The server side of the
 * same asset takes the matching stance: invoice issuance renders
 * without a logo rather than aborting (`invoice/logoAsset.ts`).
 */

import { useState } from 'react';
import { BRANDING } from '@/config/brandingConfig';
import styles from './BrandMark.module.css';

export function BrandMark() {
  // Flips on the <img>'s error event. Not reset on re-render: within a
  // session the asset either resolves or it does not, and retrying on
  // every render would re-request a 404 for the life of the page.
  const [assetFailed, setAssetFailed] = useState(false);
  const logo = BRANDING.mark.logo;

  if (logo && !assetFailed) {
    return (
      <img
        className={styles.logo}
        src={logo}
        alt=""
        aria-hidden="true"
        data-testid="brand-mark-logo"
        onError={() => setAssetFailed(true)}
      />
    );
  }

  return (
    <svg
      className={styles.fallbackMark}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
      data-testid="brand-mark-fallback"
    >
      <rect width="32" height="32" rx="6" fill={BRANDING.mark.bg} />
      <rect x="4" y="6" width="6" height="20" rx="2" fill={BRANDING.mark.bars[0]} opacity="0.9" />
      <rect x="13" y="10" width="6" height="16" rx="2" fill={BRANDING.mark.bars[1]} opacity="0.9" />
      <rect x="22" y="8" width="6" height="18" rx="2" fill={BRANDING.mark.bars[2]} opacity="0.9" />
    </svg>
  );
}
