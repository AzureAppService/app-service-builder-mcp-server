import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from './server.mjs';

const run = promisify(execFile);
const token = 'synthetic-client-test-token-'.repeat(2);
const clientPath = fileURLToPath(new URL('./client.mjs', import.meta.url));

async function fixture(t, env = { APP_API_TOKEN: token }) {
  const app = createApp({ env });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise((resolve) => {
    app.close(resolve);
    app.closeAllConnections();
  }));
  return `http://127.0.0.1:${app.address().port}`;
}

function client(origin, appToken = token) {
  return run(process.execPath, [clientPath], {
    env: { MCP_URL: `${origin}/mcp`, APP_API_TOKEN: appToken },
    timeout: 15_000,
  });
}

test('included client initializes, lists and calls the local JSON HTTP server', async (t) => {
  const origin = await fixture(t);
  const { stdout, stderr } = await client(origin);
  assert.equal(stderr, '');
  const [tools, result] = stdout.trim().split('\n');
  assert.equal(tools, 'Tools: text_length');
  assert.deepEqual(JSON.parse(result).content, [{ type: 'text', text: '5' }]);
});

test('included client rejects incorrect and missing credentials', async (t) => {
  const origin = await fixture(t);
  await assert.rejects(client(origin, 'synthetic-wrong-token-'.repeat(2)), {
    code: 1,
    stderr: /HTTP 401/,
  });
  await assert.rejects(client(origin, ''), {
    code: 1,
    stderr: /APP_API_TOKEN is required/,
  });
});

for (const env of [{}, { APP_API_TOKEN: 'synthetic-short-token' }]) {
  test(`client fails closed with ${env.APP_API_TOKEN ? 'short' : 'missing'} server token while health stays public`, async (t) => {
    const origin = await fixture(t, env);
    const health = await fetch(`${origin}/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), 'OK\n');
    const home = await fetch(origin);
    assert.equal(home.status, 200);
    assert.equal(home.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(await home.text(), /Expected result, not a live request/);
    await assert.rejects(client(origin), { code: 1, stderr: /HTTP 503/ });
  });
}
