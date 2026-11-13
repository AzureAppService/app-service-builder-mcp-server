import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createApp } from './server.mjs';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';

const token = 'local-test-token-'.repeat(3);
async function fixture(t, env = { APP_API_TOKEN: token }) {
  const app = createApp({ env });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); }));
  return (path, options = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(`http://127.0.0.1:${app.address().port}${path}`, {
      ...options,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(new Response(res.statusCode === 202 ? null : Buffer.concat(chunks), {
        status: res.statusCode, headers: res.headers,
      })));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}
const headers = {
  Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25',
};

test('public root serves the actual informational HTML and preserves protocol boundaries', async (t) => {
  const request = await fixture(t, {});
  for (const path of ['/', '/?scoutTheme=dark', '/?scoutTheme=light&check=1']) {
    const response = await request(path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html; charset=utf-8/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('location'), null);
    const html = await response.text();
    assert.equal(html, readFileSync(new URL('./index.html', import.meta.url), 'utf8'));
    assert.match(html, /<html lang="en">/);
    assert.match(html, /text_length/);
    assert.match(html, /Expected result, not a live request/);
    assert.match(html, /node client\.mjs/);
    assert.match(html, /data-health-path="\/health"/);
    assert.match(html, /id="health-status" role="status"/);
    assert.doesNotMatch(html, /\/demo|plain-text greeting|sample identifier/);
    assert.doesNotMatch(html, /<script[^>]+src=|XMLHttpRequest/);
    assert.deepEqual([...html.matchAll(/fetch\('([^']+)'/g)].map(match => match[1]), ['/health']);
  }
  assert.equal(await (await request('/health')).text(), 'OK\n');
  assert.equal((await request('/mcp', { method: 'POST' })).status, 503);
  for (const path of ['/demo', '/demo/', '/demo/index.php', '/demo?scoutTheme=dark',
    '/demo/missing', '/demo.html', '/index.html', '/missing', '/health?check=1', '/mcp?check=1']) {
    assert.equal((await request(path)).status, 404, path);
  }
  for (const method of ['POST', 'HEAD', 'DELETE']) {
    assert.equal((await request('/', { method })).status, 404, method);
    assert.equal((await request('/demo', { method })).status, 404, method);
  }
  assert.equal((await request('/', { headers: { Origin: 'https://evil.example' } })).status, 403);
});

test('HTTP initialize, initialized, list and bounded read-only call work without sessions', async (t) => {
  const request = await fixture(t);
  const rpc = (id, method, params) => request('/mcp', {
    method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, params }),
  });
  const initialized = await rpc(1, 'initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });
  assert.equal(initialized.status, 200);
  assert.match(initialized.headers.get('content-type'), /application\/json/);
  assert.equal(initialized.headers.get('mcp-session-id'), null);
  assert.equal((await initialized.json()).result.protocolVersion, '2025-11-25');
  assert.equal((await rpc(null, 'notifications/initialized')).status, 202);
  const listed = (await (await rpc(2, 'tools/list', {})).json()).result.tools;
  assert.deepEqual(listed.map((tool) => tool.name), ['text_length']);
  assert.equal(listed[0].annotations.readOnlyHint, true);
  const called = await (await rpc(3, 'tools/call', { name: 'text_length', arguments: { text: 'Hi😀' } })).json();
  assert.deepEqual(called.result.content, [{ type: 'text', text: '3' }]);
  const invalid = await (await rpc(4, 'tools/call', {
    name: 'text_length', arguments: { text: 'x'.repeat(1001) },
  })).json();
  assert(invalid.error || invalid.result?.isError);
  assert.equal((await request('/mcp')).status, 405);
  assert.equal((await request('/mcp', { method: 'DELETE' })).status, 405);
  assert.equal(await (await request('/health')).text(), 'OK\n');
});

test('HTTP boundary rejects untrusted origins, missing auth, malformed and oversized input', async (t) => {
  const request = await fixture(t);
  assert.equal((await request('/mcp', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  for (const Origin of ['', 'null', 'http://localhost:8080, https://evil.example']) {
    assert.equal((await request('/mcp', { method: 'POST', headers: { ...headers, Origin } })).status, 403);
  }
  assert.equal((await request('/mcp', { method: 'POST' })).status, 401);
  assert.equal((await request('/mcp', { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await request('/mcp', { method: 'POST', headers, body: 'x'.repeat(8193) })).status, 413);
  assert.equal((await request('/missing')).status, 404);
});

test('auth fails closed while health remains available; public origin must be exact HTTPS', async (t) => {
  const request = await fixture(t, {});
  assert.equal((await request('/mcp', { method: 'POST' })).status, 503);
  assert.equal((await request('/health')).status, 200);
  assert.equal(await (await request('/health', { headers: { Host: 'candidate.runtime.example' } })).text(), 'OK\n');
  assert.equal((await request('/health', { headers: { Host: 'candidate.runtime.example', Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request('/', { headers: { Host: 'candidate.runtime.example' } })).status, 200);
  assert.equal((await request('/health', { method: 'POST', headers: { Host: 'candidate.runtime.example' } })).status, 404);
  assert.throws(() => createApp({ env: { PUBLIC_ORIGIN: 'http://example.com' } }), /HTTPS/);
  const publicRequest = await fixture(t, { APP_API_TOKEN: token, PUBLIC_ORIGIN: 'https://sample.example' });
  assert.equal((await publicRequest('/health', { headers: { Host: 'sample.example', Origin: 'https://sample.example' } })).status, 200);
});

test('ordinary hosted HTTP works without public-host forwarding while auth and Origin remain enforced', async (t) => {
  const request = await fixture(t, { APP_API_TOKEN: token, PUBLIC_ORIGIN: 'https://sample.example' });
  const hosted = { ...headers, Host: 'runtime.example' };
  const rpc = (id, method, params) => request('/mcp', { method: 'POST', headers: hosted,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  assert.equal((await rpc(1, 'initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'proxy-test', version: '1' },
  })).status, 200);
  const called = await (await rpc(2, 'tools/call', { name: 'text_length', arguments: { text: 'Hi😀' } })).json();
  assert.deepEqual(called.result.content, [{ type: 'text', text: '3' }]);
  assert.equal((await request('/mcp', { method: 'POST', headers: { ...hosted, Authorization: 'Bearer wrong' } })).status, 401);
  for (const forwardedHost of ['evil.example', 'sample.example, evil.example', '']) {
    assert.equal((await request('/mcp', { method: 'POST',
      headers: { Host: 'runtime.example', 'X-Forwarded-Host': forwardedHost } })).status, 401);
  }
  assert.equal((await request('/mcp', { method: 'POST',
    headers: { ...hosted, Origin: 'https://evil.example', 'X-Forwarded-Host': 'sample.example' } })).status, 403);
  assert.equal((await request('/mcp', { method: 'POST', headers: { ...hosted, Origin: 'https://sample.example' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }) })).status, 200);
});
