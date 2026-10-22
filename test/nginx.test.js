const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const base = process.env.TEST_BASE_URL || 'http://localhost:8080';

const sha256 = source => "'sha256-" + crypto.createHash('sha256').update(source, 'utf8').digest('base64') + "'";
// HTML input preprocessing converts both CRLF and lone CR to LF before CSP sees text.
function permitsInline(policy, directive, source) {
  const tokens = policy.split(';').map(value => value.trim().split(/\s+/))
    .find(parts => parts[0] === directive);
  return Boolean(tokens?.includes(sha256(source.replace(/\r\n?/g, '\n'))));
}

test('CSP regression: browser-normalized CRLF/LF hash, wrong hash and wrong directive', () => {
  const lf = '\nconsole.log("CSP regression");\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  const policy = `script-src 'self' ${sha256(lf)}; style-src 'self'`;
  assert.notEqual(sha256(crlf), sha256(lf));
  assert.ok(permitsInline(policy, 'script-src', lf));
  assert.ok(permitsInline(policy, 'script-src', crlf));
  assert.ok(permitsInline(policy, 'script-src', lf.replace(/\n/g, '\r')));
  assert.ok(!permitsInline(`script-src 'self' ${sha256(crlf)}`, 'script-src', crlf), 'raw CRLF hash must fail');
  assert.ok(!permitsInline(policy, 'script-src', lf + '// changed'));
  assert.ok(!permitsInline(`script-src 'self'; style-src ${sha256(lf)}`, 'script-src', lf));
});

function checkHeaders(response) {
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'same-origin');
  assert.equal(response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.equal(response.headers.get('server'), 'nginx');
  const csp = response.headers.get('content-security-policy');
  assert.ok(csp?.includes("frame-ancestors 'none'"));
  assert.ok(csp.includes("object-src 'none'"));
  assert.ok(csp.includes("base-uri 'none'"));
  assert.ok(csp.includes("form-action 'self'"));
}

test('Nginx proxies HTML/client JS and CSP permits the exact inline application script', async () => {
  const response = await fetch(base + '/');
  assert.equal(response.status, 200); checkHeaders(response);
  const html = await response.text();
  assert.ok(html.includes('id="loginForm"') && html.includes('id="chat"'));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  for (const script of scripts) {
    assert.ok(permitsInline(response.headers.get('content-security-policy'), 'script-src', script[1]), 'script-src must permit the actual script after HTML newline normalization');
  }
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  assert.equal(styles.length, 1);
  assert.ok(permitsInline(response.headers.get('content-security-policy'), 'style-src', styles[0][1]));
  assert.ok(!response.headers.get('content-security-policy').includes("'unsafe-inline'"));
  const scriptDirective=response.headers.get('content-security-policy').split(';').find(value=>value.trim().startsWith('script-src'));
  assert.ok(!scriptDirective.includes('unsafe-inline') && !scriptDirective.includes('unsafe-eval'));
  const client = await fetch(base + '/socket.io/socket.io.js');
  assert.equal(client.status, 200);checkHeaders(client);
  assert.match(client.headers.get('content-type'), /javascript/);
  await client.text();
});

test('Nginx sends security headers for API, authorization failures and error responses', async () => {
  for (const [path, options, expected] of [
    ['/health', {}, 200],
    ['/api/me', {}, 200],
    ['/api/rooms/members', {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}, 401],
    ['/review-missing-path', {}, 404],
    ['/socket.io/?EIO=4&transport=invalid', {}, 400]
  ]) {
    const response = await fetch(base + path, options);
    assert.equal(response.status, expected, path);checkHeaders(response);await response.text();
  }
});
