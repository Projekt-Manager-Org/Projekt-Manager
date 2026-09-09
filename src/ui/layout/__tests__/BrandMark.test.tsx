/**
 * Component tests — brand mark rendering (issue #189, AC-361).
 *
 * The header's mark has three states worth pinning: the default install
 * (generic SVG), a deployment that configured its own logo, and that
 * same deployment with a broken asset path. The third is the one that
 * matters operationally — a typo in the config must not leave a broken
 * image in the header of every page.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BRANDING } from '@/config/brandingConfig';
import { BrandMark } from '../BrandMark';

// Snapshot before any spy is installed: reading `BRANDING.mark` inside
// `configureLogo` would go through the spy that call just created, which
// has no return value yet.
const ORIGINAL_MARK = { ...BRANDING.mark };

function configureLogo(value: string | undefined): void {
  vi.spyOn(BRANDING, 'mark', 'get').mockReturnValue({ ...ORIGINAL_MARK, logo: value });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BrandMark — AC-361 configurable brand mark', () => {
  it('renders the generic three-bar mark when no logo is configured', () => {
    configureLogo(undefined);
    render(<BrandMark />);

    expect(screen.getByTestId('brand-mark-fallback')).toBeInTheDocument();
    expect(screen.queryByTestId('brand-mark-logo')).not.toBeInTheDocument();
  });

  it('renders the configured logo asset when one is set', () => {
    configureLogo('/brand/logo.png');
    render(<BrandMark />);

    const img = screen.getByTestId('brand-mark-logo');
    expect(img).toHaveAttribute('src', '/brand/logo.png');
    expect(screen.queryByTestId('brand-mark-fallback')).not.toBeInTheDocument();
  });

  it('is decorative in both states — the accessible name comes from the surrounding control', () => {
    configureLogo('/brand/logo.png');
    const { unmount } = render(<BrandMark />);

    const img = screen.getByTestId('brand-mark-logo');
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveAttribute('aria-hidden', 'true');
    unmount();

    // The fallback arm too: AC-361 calls the mark decorative in BOTH
    // states, and the generic SVG is what a default install renders on
    // every page.
    configureLogo(undefined);
    render(<BrandMark />);

    expect(screen.getByTestId('brand-mark-fallback')).toHaveAttribute('aria-hidden', 'true');
  });

  it('falls back to the generic mark when the configured asset fails to load', () => {
    configureLogo('/brand/typo.png');
    render(<BrandMark />);

    fireEvent.error(screen.getByTestId('brand-mark-logo'));

    expect(screen.getByTestId('brand-mark-fallback')).toBeInTheDocument();
    expect(screen.queryByTestId('brand-mark-logo')).not.toBeInTheDocument();
  });
});
