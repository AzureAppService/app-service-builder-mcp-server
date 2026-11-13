import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const executable = [process.env.CHROME_BIN,
  ...(process.env.CI ? ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'] : []),
].find((path) => {
  if (!path) return false;
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
});

export async function chromeEndpoint(child, profile, timeoutMs = 30_000) {
  let stdout = '';
  let stderr = '';
  let spawnError;
  let portFileState = 'not written';
  const captureOut = (data) => { stdout = `${stdout}${data}`.slice(-8192); };
  const captureErr = (data) => { stderr = `${stderr}${data}`.slice(-8192); };
  const onError = (error) => { spawnError = error; };
  child.stdout.on('data', captureOut);
  child.stderr.on('data', captureErr);
  child.on('error', onError);
  const diagnostic = () => `exit=${child.exitCode}, signal=${child.signalCode}, `
    + `DevToolsActivePort=${portFileState}\nstdout tail:\n${stdout || '(empty)'}`
    + `\nstderr tail:\n${stderr || '(empty)'}`;
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (spawnError || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Chrome exited before startup: ${spawnError?.message ?? ''}\n${diagnostic()}`);
      }
      // Chrome's port-0 readiness file does not depend on a particular stderr announcement.
      try {
        const [port, target] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
        portFileState = 'incomplete or invalid';
        if (/^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65535
          && /^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(target)) {
          return `ws://127.0.0.1:${port}${target}`;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const announcement = `${stderr}\n${stdout}`.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/);
      if (announcement) return announcement[1];
      await delay(25);
    }
    throw new Error(`Chrome startup timed out after ${timeoutMs}ms\n${diagnostic()}`);
  } finally {
    child.stdout.off('data', captureOut);
    child.stderr.off('data', captureErr);
    child.off('error', onError);
    child.stdout.resume();
    child.stderr.resume();
  }
}

/** Own a headless browser and short profile path; never attach to a user browser. */
export async function openBrowser(binary) {
  const profile = await mkdtemp(join(tmpdir(), 'mcp-chrome-'));
  const child = spawn(binary, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--metrics-recording-only', '--no-pings', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // A private process group keeps forced cleanup confined to this browser's helpers.
    detached: process.platform !== 'win32',
    env: { ...process.env, TMPDIR: profile, TMP: profile, TEMP: profile },
  });
  let socket;
  const pending = new Map();
  const listeners = new Map();
  const stop = (signal) => {
    if (process.platform === 'win32') child.kill(signal);
    else {
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  const close = async () => {
    socket?.close();
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error('Browser closed'));
    }
    pending.clear();
    try {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        stop('SIGTERM');
        try { await once(child, 'exit', { signal: AbortSignal.timeout(2000) }); }
        catch {
          if (child.exitCode === null && child.signalCode === null) {
            stop('SIGKILL');
            await once(child, 'exit', { signal: AbortSignal.timeout(5000) });
          }
        }
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  };
  try {
    const endpoint = await chromeEndpoint(child, profile);
    const address = new URL(endpoint);
    const targets = await (await fetch(`http://${address.host}/json/list`, {
      signal: AbortSignal.timeout(5000),
    })).json();
    const target = targets.find(({ type }) => type === 'page');
    assert.ok(target?.webSocketDebuggerUrl, 'Chrome must expose the owned page target');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await once(socket, 'open', { signal: AbortSignal.timeout(5000) });
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      } else {
        for (const listener of listeners.get(message.method) ?? []) listener(message.params);
      }
    });
    let id = 0;
    return {
      close,
      on(method, listener) {
        if (!listeners.has(method)) listeners.set(method, []);
        listeners.get(method).push(listener);
      },
      call(method, params = {}) {
        return new Promise((resolve, reject) => {
          const requestId = ++id;
          const timer = setTimeout(() => {
            pending.delete(requestId);
            reject(new Error(`CDP timed out: ${method}`));
          }, 5000);
          pending.set(requestId, { resolve, reject, timer });
          socket.send(JSON.stringify({ id: requestId, method, params }));
        });
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function evaluate(browser, expression) {
  const result = await browser.call('Runtime.evaluate', { expression, returnByValue: true });
  assert.equal(result.exceptionDetails, undefined, 'Browser evaluation must succeed');
  return result.result.value;
}

export async function waitFor(browser, expression) {
  const deadline = Date.now() + 5000;
  while (!await evaluate(browser, expression)) {
    assert.ok(Date.now() < deadline, `Browser condition timed out: ${expression}`);
    await delay(25);
  }
}

export async function enter(browser) {
  await browser.call('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r',
  });
  await browser.call('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
  });
}

test('Chrome renders the actual root and preserves navigation and HTTP boundaries', {
  timeout: 60_000,
  skip: !process.env.CI && !executable ? 'Set CHROME_BIN to run the local browser smoke' : false,
}, async (t) => {
  assert.ok(executable, 'CI requires the Ubuntu runner preinstalled Google Chrome');
  const { createApp } = await import('./server.mjs');
  const app = createApp({ env: {} });
  t.after(() => new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); }));
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const origin = `http://127.0.0.1:${app.address().port}`;
  const root = await fetch(`${origin}/`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  assert.equal(root.status, 200);
  assert.equal(root.headers.get('location'), null);
  assert.equal(root.headers.get('content-type'), 'text/html; charset=utf-8');
  await root.arrayBuffer();

  const browser = await openBrowser(executable);
  t.after(browser.close);
  const external = [];
  const errors = [];
  const documents = [];
  browser.on('Network.requestWillBeSent', ({ request, redirectResponse }) => {
    if (new URL(request.url).origin !== origin) external.push(request.url);
    if (redirectResponse) errors.push('Unexpected redirect');
  });
  browser.on('Runtime.exceptionThrown', ({ exceptionDetails }) => errors.push(exceptionDetails.text));
  browser.on('Network.responseReceived', ({ type, response }) => {
    if (type === 'Document') documents.push(response);
  });
  await browser.call('Page.enable');
  await browser.call('Runtime.enable');
  await browser.call('Network.enable');
  const navigation = await browser.call('Page.navigate', { url: `${origin}/` });
  assert.equal(navigation.errorText, undefined);
  await waitFor(browser, `location.href === ${JSON.stringify(`${origin}/`)} && document.readyState === 'complete'`);
  assert.equal(documents[0]?.status, 200);
  assert.equal(documents[0]?.mimeType, 'text/html');
  assert.equal(await evaluate(browser, 'document.title'), 'MCP server | App Service Builder');
  assert.equal(await evaluate(browser, `document.body.textContent.includes('text_length')
    && document.body.textContent.includes('Expected result, not a live request')`), true);
  assert.equal(await evaluate(browser, `document.querySelectorAll('form, input, textarea').length`), 0);

  await evaluate(browser, `document.querySelector('summary').focus()`);
  await enter(browser);
  assert.equal(await evaluate(browser, `document.querySelector('details').open`), true);
  await evaluate(browser, `document.querySelector('a[href="#connect"]').focus()`);
  await enter(browser);
  await waitFor(browser, `location.hash === '#connect'`);
  await browser.call('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 1, mobile: false,
  });
  assert.equal(await evaluate(browser, 'document.documentElement.scrollWidth <= innerWidth'), true);

  await evaluate(browser, `document.querySelector('[data-health-check]').focus()`);
  await enter(browser);
  await waitFor(browser, `document.querySelector('#health-status').textContent.startsWith('Healthy:')`);
  assert.equal(await evaluate(browser, 'location.pathname'), '/');
  assert.equal(await evaluate(browser, `document.querySelector('[data-health-check]').disabled`), false);
  assert.match(await evaluate(browser, `document.querySelector('#health-status').textContent`), /Does not verify authentication/);
  await browser.call('Network.setBlockedURLs', { urls: [`${origin}/health`] });
  await evaluate(browser, `document.querySelector('[data-health-check]').focus()`);
  await enter(browser);
  await waitFor(browser, `document.querySelector('#health-status').textContent.startsWith('Health check failed:')`);
  assert.match(await evaluate(browser, `document.querySelector('#health-status').textContent`), /Retry the check/);
  assert.equal(await evaluate(browser, `document.querySelector('[data-health-check]').disabled`), false);
  await browser.call('Network.setBlockedURLs', { urls: [] });
  await evaluate(browser, `document.querySelector('[data-health-check]').focus()`);
  await enter(browser);
  await waitFor(browser, `document.querySelector('#health-status').textContent.startsWith('Healthy:')`);
  assert.equal(await evaluate(browser, 'location.pathname'), '/');
  const removed = await fetch(`${origin}/demo`, {
    redirect: 'manual', signal: AbortSignal.timeout(5000),
  });
  assert.equal(removed.status, 404);
  assert.equal(removed.headers.get('location'), null);
  assert.deepEqual(await removed.json(), { error: 'not_found' });
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
});
