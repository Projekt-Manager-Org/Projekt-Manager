/**
 * Reverse-proxy trust boundary: TRUSTED_PROXY_CIDRS → Fastify `trustProxy`.
 *
 * `request.ip` keys the login rate limiter and is written to the login audit
 * trail (routes/auth.ts), so a wrong X-Forwarded-For trust boundary is both a
 * lockout vector (every client sharing one bucket) and an attribution bug.
 * It fails *silently* — the app serves normally — which is why the behaviour
 * is pinned here rather than left to the config's say-so.
 *
 * The regression that motivated this file: fastify 5.12.1 removed the numeric
 * hop-count `trustProxy` (GHSA-3m5p-2c4r-xxw2) the app was configured with. A
 * hop count never validated *which* peer connected, so a direct client could
 * forge the header by supplying enough hops. Under the old `trustProxy: 1` on
 * fastify ≥5.12.1 the first two cases below return Caddy's address instead of
 * the client's — no test covered it, so only the type error caught the break.
 *
 * Addresses follow the ADR-0008 topology: Caddy reaches the app from the
 * pinned compose subnet 172.16.0.0/16; clients are WireGuard peers in
 * 10.213.17.0/24. The ranges are disjoint by construction, so a client address
 * can never satisfy the proxy trust check.
 */

import { describe, it, expect } from 'vitest';
import { buildApp } from '../app.js';
import { envSchema } from '../config/env.js';

/** Caddy's address on the pinned compose network — the only trusted peer. */
const CADDY = '172.16.0.5';
/** A real client: a WireGuard peer (ADR-0008). */
const CLIENT = '10.213.17.10';

/**
 * Build an app under the given trust config and report the `request.ip` it
 * derives for a request arriving from `remoteAddress` with `xff`.
 *
 * `buildApp` reads TRUSTED_PROXY_CIDRS through `getEnv()` at construction
 * time, so the var is set around the call and restored afterwards — this is
 * what makes the test exercise the real env → trustProxy wiring rather than
 * just re-testing Fastify.
 */
async function resolveIp(
  cidrs: string | undefined,
  remoteAddress: string,
  xff?: string,
): Promise<string> {
  const previous = process.env.TRUSTED_PROXY_CIDRS;
  if (cidrs === undefined) delete process.env.TRUSTED_PROXY_CIDRS;
  else process.env.TRUSTED_PROXY_CIDRS = cidrs;
  try {
    const app = buildApp({ logger: false, rateLimit: false });
    // buildApp mounts no route that echoes the resolved IP; add one before
    // ready() so the assertion reads exactly what the handlers would see.
    app.get('/__ip', (req) => ({ ip: req.ip }));
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/__ip',
        remoteAddress,
        headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
      });
      return (res.json() as { ip: string }).ip;
    } finally {
      await app.close();
    }
  } finally {
    if (previous === undefined) delete process.env.TRUSTED_PROXY_CIDRS;
    else process.env.TRUSTED_PROXY_CIDRS = previous;
  }
}

describe('request.ip resolution across the reverse-proxy trust boundary', () => {
  it('reports the forwarded client address when the peer is the trusted proxy', async () => {
    // Arrange + Act — the ordinary production path: Caddy forwards, having
    // appended the client it accepted the connection from.
    const ip = await resolveIp('172.16.0.0/16', CADDY, CLIENT);
    // Assert — the client, not the proxy.
    expect(ip).toBe(CLIENT);
  });

  it('ignores a client-supplied X-Forwarded-For prefix', async () => {
    // Arrange — a client forging a header. Caddy APPENDS the address it
    // actually saw, so the forged entry sits to the LEFT of the real one.
    // Act — trust walks right-to-left and stops at the first untrusted hop,
    // which is the real client, so the forged entry is never reached.
    const ip = await resolveIp('172.16.0.0/16', CADDY, `1.2.3.4, ${CLIENT}`);
    // Assert — the spoof does not move request.ip.
    expect(ip).toBe(CLIENT);
  });

  it('ignores X-Forwarded-For entirely when the peer is not the trusted proxy', async () => {
    // Arrange + Act — someone reaching the app directly, bypassing Caddy,
    // and forging the header. The peer is not in the trusted block.
    const ip = await resolveIp('172.16.0.0/16', CLIENT, '1.2.3.4');
    // Assert — the socket peer wins; the header is not believed at all.
    // This is the case the removed hop-count form got wrong.
    expect(ip).toBe(CLIENT);
  });

  it('falls back to the socket peer when unset', async () => {
    // Arrange + Act — the dev posture: no Caddy in front, nothing trusted.
    const ip = await resolveIp(undefined, CLIENT, '1.2.3.4');
    // Assert — direct connection, so the socket peer already IS the client.
    expect(ip).toBe(CLIENT);
  });
});

describe('TRUSTED_PROXY_CIDRS schema', () => {
  const minimal = { DATABASE_URL: 'postgres://unused' };

  function parse(value: string | undefined): string | undefined {
    return envSchema.parse({ ...minimal, TRUSTED_PROXY_CIDRS: value }).TRUSTED_PROXY_CIDRS;
  }

  it('accepts a CIDR block', () => {
    expect(parse('172.16.0.0/16')).toBe('172.16.0.0/16');
  });

  it('accepts a comma-separated list of CIDRs and bare addresses', () => {
    expect(parse('172.16.0.0/16, 10.0.0.7')).toBe('172.16.0.0/16, 10.0.0.7');
  });

  it('accepts IPv6', () => {
    expect(parse('fd00::/8')).toBe('fd00::/8');
  });

  it('treats the empty string as unset', () => {
    // Compose forwards an unconfigured `${VAR:-}` as "", not undefined —
    // which must mean "trust nothing", not "trust the empty list".
    expect(parse('')).toBeUndefined();
  });

  it('rejects proxy-addr presets such as uniquelocal', () => {
    // 'uniquelocal' trusts every RFC1918 address — including the WireGuard
    // client range — so a client could forge X-Forwarded-For and shift
    // request.ip off itself. Only an explicit peer address is a boundary.
    expect(() => parse('uniquelocal')).toThrow();
    expect(() => parse('loopback')).toThrow();
  });

  it('rejects a malformed address', () => {
    expect(() => parse('not-an-ip')).toThrow();
    expect(() => parse('172.16.0.999/16')).toThrow();
  });

  it('rejects an out-of-range prefix length', () => {
    expect(() => parse('172.16.0.0/33')).toThrow();
  });

  it('rejects an empty entry in the list', () => {
    // A stray trailing comma would otherwise compile to an empty string,
    // which proxy-addr rejects at request time rather than at boot.
    expect(() => parse('172.16.0.0/16,')).toThrow();
  });
});
