import { describe, it, expect } from 'vitest';
import { isInsecureConnection } from '../insecureConnection';

describe('AC-766: isInsecureConnection', () => {
  it('returns false for HTTPS on any host', () => {
    expect(isInsecureConnection('https:', 'example.com')).toBe(false);
    expect(isInsecureConnection('https:', '192.168.1.50')).toBe(false);
  });

  it('returns false for HTTP on localhost', () => {
    expect(isInsecureConnection('http:', 'localhost')).toBe(false);
  });

  it('returns false for HTTP on 127.0.0.1', () => {
    expect(isInsecureConnection('http:', '127.0.0.1')).toBe(false);
  });

  it('returns true for HTTP on a LAN IP', () => {
    expect(isInsecureConnection('http:', '192.168.1.50')).toBe(true);
    expect(isInsecureConnection('http:', '10.0.0.5')).toBe(true);
  });

  it('returns true for HTTP on a domain name', () => {
    expect(isInsecureConnection('http:', 'example.com')).toBe(true);
    expect(isInsecureConnection('http:', 'staging.internal')).toBe(true);
  });
});
