import { BRANDING } from '@/config/brandingConfig';
import { StorageUsageBadge } from './StorageUsageBadge';
import styles from './Footer.module.css';

export function Footer() {
  // Read on each render so tests can override via `vi.stubGlobal`
  // (set in beforeEach, undone in afterEach). At runtime in a built
  // bundle, vite's `define` has already inlined the literal — this is
  // a single property read into a string constant, costs nothing.
  //
  // Sliced defensively to 7 chars in case the bake-in ever ships a
  // longer value; the displayed form is always `v<7-char-sha>` (matches
  // `git rev-parse --short=7`). Empty string -> chip not rendered.
  const sha = __APP_GIT_SHA__.slice(0, 7);

  return (
    <footer className={styles.footer}>
      {sha && (
        <span className={styles.version} data-testid="footer-app-version">
          v{sha}
        </span>
      )}
      <span className={styles.brand}>{BRANDING.footerText}</span>
      <StorageUsageBadge />
    </footer>
  );
}
