import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { accessSync, constants } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const executable = [process.env.CHROME_BIN,
  ...(process.env.CI ? ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'] : []),
].find((path) => {
  if (!path) return false;
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
});

/** Own a headless browser and repository-local profile; never attach to a user browser. */
export async function openBrowser(binary) {
  const profile = fileURLToPath(new URL(`./.chrome-profile-${randomUUID()}/`, import.meta.url));
  await mkdir(profile);
  const child = spawn(binary, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--metrics-recording-only', '--no-pings', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
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
    const endpoint = await new Promise((resolve, reject) => {
      let output = '';
      const finish = (error, value) => {
        clearTimeout(timer);
        child.stderr.off('data', onData);
        child.off('error', onError);
        child.off('exit', onExit);
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('Chrome startup timed out')), 10_000);
      const onData = (data) => {
        output = `${output}${data}`.slice(-8192);
        const match = output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/);
        if (match) finish(null, match[1]);
      };
      const onError = (error) => finish(error);
      const onExit = () => finish(new Error(`Chrome exited before startup: ${output}`));
      child.stderr.on('data', onData);
      child.once('error', onError);
      child.once('exit', onExit);
      // Keep draining stderr after discovery so Chrome cannot block on a full pipe.
      child.stderr.on('data', () => {});
    });
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
  timeout: 45_000,
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

  await evaluate(browser, `document.querySelector('a[href="/health"]').focus()`);
  await enter(browser);
  await waitFor(browser, `location.pathname === '/health' && document.readyState === 'complete'`);
  assert.equal(await evaluate(browser, 'document.body.textContent'), 'OK\n');
  assert.equal(documents.at(-1)?.status, 200);
  const removed = await fetch(`${origin}/demo`, {
    redirect: 'manual', signal: AbortSignal.timeout(5000),
  });
  assert.equal(removed.status, 404);
  assert.equal(removed.headers.get('location'), null);
  assert.deepEqual(await removed.json(), { error: 'not_found' });
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
});
