import { test, expect } from '@playwright/test';
import net from 'node:net';
import os from 'node:os';

/**
 * Dev servers listen on loopback only (#826). A dev server on the LAN
 * hands every device on a shared network a server with no security
 * boundary (GHSA-p4f5-76q4-ffq7) and an API with seeded credentials.
 *
 * Probes the servers Playwright's webServer started (`npm run dev:e2e`,
 * the same config as `npm run dev` on other ports): each must accept on
 * 127.0.0.1 and refuse on the machine's LAN address.
 */

/** Returns the first non-loopback IPv4 address, or null. */
function getLocalIPv4(): string | null {
  for (const addrs of Object.values(os.networkInterfaces())) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

/** TCP connect outcome: 'connected', or the error code. */
function connect(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 2_000 });
    socket.once('connect', () => {
      socket.destroy();
      resolve('connected');
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve('ETIMEDOUT');
    });
    socket.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message));
  });
}

test('vite and fastify accept on loopback and refuse on the LAN address', async () => {
  const ip = getLocalIPv4();
  test.skip(!ip, 'No non-loopback IPv4 address available');

  const { baseURL } = test.info().project.use;
  const webServer = test.info().config.webServer;
  const ports = {
    vite: Number(new URL(baseURL!).port),
    fastify: Number(webServer?.env?.PORT),
  };

  for (const [name, port] of Object.entries(ports)) {
    expect(port, `${name} port`).toBeGreaterThan(0);
    expect(await connect('127.0.0.1', port), `${name} on 127.0.0.1:${port}`).toBe('connected');
    expect(await connect(ip!, port), `${name} on ${ip}:${port}`).toBe('ECONNREFUSED');
  }
});
