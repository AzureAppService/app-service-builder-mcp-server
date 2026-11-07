import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import * as z from 'zod';

const home = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

/**
 * Each POST owns a fresh SDK server/transport, closed when its response finishes.
 * This intentionally offers neither session persistence nor a GET event stream.
 */
export function createApp({ env = process.env } = {}) {
  const token = env.APP_API_TOKEN ?? '';
  const origin = env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN) : null;
  if (origin && (origin.protocol !== 'https:' || origin.origin !== env.PUBLIC_ORIGIN)) {
    throw new Error('PUBLIC_ORIGIN must be an exact HTTPS origin');
  }
  const origins = ['http://localhost:8080', 'http://127.0.0.1:8080', ...(origin ? [origin.origin] : [])];
  const send = (res, status, error) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error }));
  };
  const app = createServer(async (req, res) => {
    if (req.headers.origin !== undefined && !origins.includes(req.headers.origin)) {
      return send(res, 403, 'untrusted_origin');
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('OK\n');
    }
    if (req.method === 'GET' && req.url?.split('?')[0] === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      return res.end(home);
    }
    if (req.url !== '/mcp') return send(res, 404, 'not_found');
    if (req.method !== 'POST') return send(res, 405, 'post_only');
    if (token.length < 32) return send(res, 503, 'app_auth_not_configured');
    const actual = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return send(res, 401, 'unauthorized');
    }
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
      return send(res, 415, 'expected_json');
    }
    let body;
    try {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > 8192) {
          req.resume();
          return send(res, 413, 'body_limit');
        }
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return send(res, 400, 'invalid_json');
    }
    const server = new McpServer({ name: 'builder-mcp-sample', version: '1.0.0' });
    server.registerTool('text_length', {
      description: 'Count Unicode code points in at most 1000 UTF-16 code units of text; performs no I/O.',
      inputSchema: z.object({ text: z.string().max(1000) }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ text }) => ({
      content: [{ type: 'text', text: String(Array.from(text).length) }],
    }));
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, enableJsonResponse: true,
      enableDnsRebindingProtection: true, allowedOrigins: origins,
    });
    // One cleanup callback covers normal completion and client disconnect.
    res.once('close', () => { void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) send(res, 500, 'protocol_failed');
      await server.close();
    }
  });
  app.requestTimeout = 15_000;
  app.headersTimeout = 10_000;
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createApp();
  server.listen(8080, '0.0.0.0');
  process.once('SIGTERM', () => server.close());
  process.once('SIGINT', () => server.close());
}
