// Service Worker probe for the runtime smoke. Runs inside the app
// container (`docker exec -i … node --input-type=module - < this file`),
// so it must stay dependency-free. Exit 1 lists every failed check.
const res = await fetch('http://localhost:3000/sw.js');
const body = await res.text();
const failures = [];
if (res.status !== 200) failures.push(`status ${res.status}, want 200`);
const type = res.headers.get('content-type') ?? '';
if (!type.includes('javascript')) failures.push(`content-type "${type}", want javascript`);
const cache = res.headers.get('cache-control') ?? '';
if (cache !== 'no-cache') failures.push(`cache-control "${cache}", want no-cache`);
if (!body.includes('/encrypted-storage/')) {
  failures.push('decrypt surface missing (no /encrypted-storage/ route)');
}
for (const event of ['fetch', 'push']) {
  if (!new RegExp(`addEventListener\\(["']${event}["']`).test(body)) {
    failures.push(`no '${event}' listener`);
  }
}
for (const f of failures) console.log(`  ${f}`);
if (failures.length > 0) process.exit(1);
console.log(`  /sw.js: ${body.length} bytes, fetch + push wired, no-cache — smoke OK`);
