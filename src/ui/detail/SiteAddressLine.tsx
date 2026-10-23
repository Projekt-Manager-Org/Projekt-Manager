/**
 * Read-only `Baustelle:` line — shared between the quick-glance Project
 * Detail Panel ([workflow-views.md §8.4]) and the Project Detail Page
 * ([project-detail.md §8.15.2]). Both surfaces MUST render this line
 * identically; the component is the single source of truth.
 *
 * Render rules (AC-489, AC-490, AC-491, AC-283):
 *   - `project.siteAddress` non-null → `street, zip city` from
 *     `project.siteAddress`. No fallback hint.
 *   - `project.siteAddress` null + `customer.address` present →
 *     customer's `street, zip city` followed by inline German hint
 *     `(Kundenadresse)`.
 *   - Both absent → `Keine Adresse`. No map link.
 *
 * The map link is rendered exactly once on whichever address is
 * displayed; it is omitted when neither address is present.
 */

import { STRINGS } from '@/config/strings';
import type { Address, Project } from '@/domain/types';
import panelStyles from './ProjectDetailPanel.module.css';
import pageStyles from './ProjectDetail.module.css';

type Variant = 'panel' | 'page';

interface Props {
  project: Project;
  /**
   * Surface picker — drives the wrapper testid AND which CSS-module
   * classnames the line uses (panel = `.section/.sectionLabel/...`,
   * page = `.coreField/.coreLabel/...`). The DOM/text contents are
   * identical across surfaces by construction.
   */
  variant: Variant;
}

interface SurfaceClasses {
  wrapper: string;
  label: string;
  value: string;
  link: string;
  hint?: string;
}

const PANEL_CLASSES: SurfaceClasses = {
  wrapper: panelStyles.section,
  label: panelStyles.sectionLabel,
  value: panelStyles.fieldValue,
  link: panelStyles.link,
};

const PAGE_CLASSES: SurfaceClasses = {
  wrapper: pageStyles.coreField,
  label: pageStyles.coreLabel,
  value: pageStyles.coreValue,
  // The page already inlines anchor styling alongside `.coreValue`
  // text without a dedicated class — keep that pattern by using an
  // empty class string for the link on this surface.
  link: '',
};

const TEST_IDS: Record<Variant, string> = {
  panel: 'detail-site-address',
  page: 'project-detail-site-address',
};

function mapsUrlFor(address: Address): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    `${address.street} ${address.zip} ${address.city}`,
  )}`;
}

export function SiteAddressLine({ project, variant }: Props) {
  const classes = variant === 'panel' ? PANEL_CLASSES : PAGE_CLASSES;
  const testId = TEST_IDS[variant];

  const site = project.siteAddress;
  const customerAddress = project.customer?.address ?? null;

  // Pick the address actually shown — siteAddress wins when present;
  // otherwise the customer's billing address stands in as a fallback.
  const shown: Address | null = site ?? customerAddress;
  const isFallback = site === null && customerAddress !== null;

  if (!shown) {
    return (
      <div className={classes.wrapper} data-testid={testId}>
        <div className={classes.label}>{STRINGS.projects.siteAddressLabel}</div>
        <div className={classes.value}>{STRINGS.projects.siteAddressNone}</div>
      </div>
    );
  }

  const mapsUrl = mapsUrlFor(shown);

  return (
    <div className={classes.wrapper} data-testid={testId}>
      <div className={classes.label}>{STRINGS.projects.siteAddressLabel}</div>
      <div className={classes.value}>
        {shown.street}, {shown.zip} {shown.city}
        {isFallback && <> {STRINGS.projects.siteAddressFallbackHint}</>}{' '}
        <a className={classes.link} href={mapsUrl} target="_blank" rel="noopener noreferrer">
          {STRINGS.ui.openMaps}
        </a>
      </div>
    </div>
  );
}
