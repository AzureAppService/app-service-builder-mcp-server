---
page_type: sample
languages:
  - javascript
products:
  - azure
  - azure-app-service
name: App Service Builder HTTP MCP server
description: A standalone, authenticated HTTP MCP sample with a bounded, read-only text tool.
urlFragment: app-service-builder-mcp-server
---

# App Service Builder HTTP MCP server

Host a small HTTP Model Context Protocol (MCP) server on App Service Builder.
The single `text_length` tool counts Unicode code points without accessing files,
networks, or application state. This repository contains the complete app,
deployment configuration, lockfile, Node client, and local HTTP/protocol tests;
no parent repository or ZIP download is needed.

**Private Preview, development/test only.** You need authorized access to an
App Service Builder preview environment before deploying. Local tests do not
qualify a deployed route, another MCP client, or production use. This is an
HTTP MCP endpoint, not a remote stdio bridge or native Builder agent orchestration.

## Showcase preview

The read-only showcase is the home page at `/`, served directly as HTML.
The tool example shown is illustrative, not a live request.

![Daylight MCP root guide with official protocol logo, text_length example, configuration disclosure, and inline public liveness check](docs/images/sample.png)

Real local rendering in Microsoft Edge, not evidence of an Azure deployment.
**Check server liveness** displays the public `/health` response here; it does
not verify authentication or execute an MCP tool. The machine endpoint and
authenticated `/mcp` protocol are unchanged. Failed checks stay inline and the
same control retries. MCP documentation is separate from Builder documentation;
setup links explicitly identify the upstream README, not your fork. The
configuration disclosure names `APP_API_TOKEN` and `PUBLIC_ORIGIN` from `server.mjs`.

## Prerequisites

- Node.js **24.x** and npm (the runtime declared in `package.json` and `builder.yaml`).
- Git for cloning or working in your own fork.
- For deployment only: authorized Private Preview access, a suitable subscription
  and resource group, and permission to select the source repository in the Portal.
  Use the environment and region approved for your preview access.

The direct dependencies are `@modelcontextprotocol/server`,
`@modelcontextprotocol/node`, and `zod`. See [`package.json`](package.json)
for their exact version pins and [`package-lock.json`](package-lock.json)
for the complete locked dependency tree. Use `npm ci --ignore-scripts` with
the committed lockfile rather than substituting SDK versions.

## Run locally

Clone this repository (or your fork), and work from its root:

```sh
git clone https://github.com/AzureAppService/app-service-builder-mcp-server.git
cd app-service-builder-mcp-server
npm ci --ignore-scripts
npm test
export APP_API_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
npm start
```

The process listens on `0.0.0.0:8080`. Use an isolated local network or firewall;
binding to all interfaces is needed for the hosted web component. Keep the token
in your environment or an approved secret store, never source, a URL, a shell
history entry, or a command-line argument. Generate a new token for each test
environment; do not reuse a production credential.

In another terminal, check public liveness:

```sh
curl --fail http://127.0.0.1:8080/health
```

The expected body is `OK`. Liveness is deliberately unauthenticated and does
**not** prove that app authentication is configured or that a tool can be called.
Open `http://127.0.0.1:8080/` for a responsive, read-only showcase of the
tool, an illustrative JSON-RPC call, the route contract, and client setup.
It does not send MCP requests, collect credentials, or report live tool status.
The page uses local HTML/CSS with no external assets or additional dependencies;
its light/dark appearance follows your system preference.
In a terminal with the same `APP_API_TOKEN` set securely, run:

```sh
node client.mjs
```

The client defaults to `http://127.0.0.1:8080/mcp`, initializes using protocol
`2025-11-25`, sends the initialized notification, lists `text_length`, and calls
it with `Hello`. Expect `Tools: text_length` and a JSON result containing text
`"5"`. The tests also run this client against an owned loopback server using a
synthetic token, so no external service or credential is required for `npm test`.
Stop the local server with Ctrl+C; SIGINT and SIGTERM close the HTTP server.

Independent terminals do not share exported variables. To exercise the client
without copying the token between terminals, stop `npm start`, ensure port 8080
is free, and run this in the same shell where you generated the token:

```sh
node server.mjs &
MCP_SERVER_PID=$!
trap 'kill "$MCP_SERVER_PID"' EXIT
curl --fail --retry 5 --retry-connrefused --retry-delay 1 http://127.0.0.1:8080/health
node client.mjs
kill "$MCP_SERVER_PID"
wait "$MCP_SERVER_PID"
trap - EXIT
```

## HTTP and security contract

| Setting or route | Behavior |
|---|---|
| `APP_API_TOKEN` | Required for `POST /mcp`; at least 32 characters. The `Authorization` header must use the `Bearer` scheme with this exact token; comparison is timing-safe for equal-length values. |
| `PUBLIC_ORIGIN` | Optional exact HTTPS origin, without a trailing slash, allowed when a client supplies `Origin`. Invalid configuration prevents startup. |
| `GET /` | Public HTML showcase, served directly without a redirect; examples are static, not live MCP calls. Query strings leave the HTML response unchanged. |
| `GET /health` | Public `200` with `OK` body; liveness only. |
| `POST /mcp` | JSON-RPC over stateless Streamable HTTP, with an 8192-byte request-body limit and JSON responses. Each request owns a fresh SDK server and transport. |
| `text_length` | Accepts text of at most 1000 UTF-16 code units and counts Unicode code points. No file, network, or state access. |
| `GET` or `DELETE /mcp` | `405`; no standalone event stream or session lifecycle. |
| `Origin` | When supplied, must exactly match `http://localhost:8080`, `http://127.0.0.1:8080`, or `PUBLIC_ORIGIN`. Untrusted, empty, or `null` origins receive `403` on every route. |

Missing or short app-token configuration fails closed with `503` on `POST /mcp`;
missing or wrong credentials receive `401`. Authenticated requests with a
non-JSON content type receive `415`, malformed JSON receives `400`, and oversized
bodies receive `413`. Root and health remain public unless an untrusted Origin
is supplied. No CORS access is granted; the included client is a server-side Node
client, not a browser integration.

`index.html` contains the home page's local HTML/CSS. There is no separate
showcase route or plain-text identifier endpoint. Only `GET` serves the page;
other methods and unknown paths return `404`. Health and MCP routes retain
their exact paths, without query strings.

Only POST request/response behavior is demonstrated: **no SSE streaming, session
state, resumability, session affinity, or long-lived workload support** is
claimed. Although the client's `Accept` header includes `text/event-stream` for
the SDK's HTTP contract, this server enables JSON responses only. The sample
does not interpret Host or forwarding headers, generate absolute request URLs,
or require public-host/proxy configuration.

The shared app token is not a complete multi-user MCP authorization server or
an OAuth implementation. Before adding tools, enforce user scopes/roles and
resource ownership inside each tool. Prompts, tool arguments, returned content,
and tool annotations do not grant permissions.

## Deploy from your own repository

Follow the [App Service Builder MCP hosting guide](https://builder.appservice.azure.com/docs/guides/host-mcp-server/)
for your authorized preview environment. This sample does not install a Builder
CLI or choose a deployment region for you.

1. Fork this repository and use your fork's `main` branch, or copy the sample
   into a repository you are authorized to deploy. Commit and push the files.
   Keep the app at the repository root, not under `samples/mcp-server`.
2. In the App Service Builder Portal, create a test app and select **your own
   authorized repository and branch** as its source. Use `/` as the source root.
   The included `builder.yaml` declares a Node 24 web component, starts
   `node server.mjs`, and probes `/health`. It uses the single-component defaults
   for the repository root (`/`), port `8080`, and exact health status `200`.
3. Configure `APP_API_TOKEN` securely through the app's runtime **Variables**.
   Use the generated token, not the placeholder text or a committed `.env` file.
   `PUBLIC_ORIGIN` is optional for clients supplying Origin; the included Node
   client does not need it. If set, use the exact HTTPS origin with no trailing slash.
4. Deploy explicitly. **Save only** stores desired variable values;
   **Save and deploy** captures them in a new deployment version. A Git push is
   not evidence of a deployment: after later source pushes, trigger a new app
   deployment and wait for it to succeed.
5. Inspect the build/startup and deployment status, then verify `/health` at the
   returned HTTPS app URL. Set `MCP_URL` to that same URL with `/mcp` appended
   (for example, `https://<your-app-host>/mcp`), supply the matching app token
   securely, and run `node client.mjs`. Verify initialize/list/call behavior,
   not just a green health check.

If platform bearer authentication is enabled, the client additionally accepts
`PLATFORM_ACCESS_TOKEN` and sends it in `X-Embr-Authorization`, independently of
the sample token in `Authorization`. Obtain the platform credential only through
your environment's approved flow and keep it out of source and logs. Platform
browser login is not MCP OAuth. Independently qualify credential acquisition,
audience, forwarding, health-probe access, and the exact MCP client on the
deployed route. Do not disable authentication to make a client connect.

## Cleanup

Delete **only the test app you created**, using its **Delete** action in the
Portal. Do not delete a shared resource group, subscription, or other apps.
Deleting the app does not delete your fork. Revoke test credentials as
appropriate and remove the local environment values:

```sh
unset APP_API_TOKEN MCP_URL PLATFORM_ACCESS_TOKEN PUBLIC_ORIGIN
```

## Tests and contributing

`npm test` uses Node's built-in test runner. Tests cover local HTTP
initialize/list/call, bounded Unicode input, fail-closed authentication,
Origin validation, malformed/oversized input, root HTML and removed-route 404s,
health, ordinary reverse-proxy headers, and the included client. CI runs the
same tests on Node 24.

The existing Ubuntu CI job also runs a dependency-free Chrome browser smoke
through Node's native WebSocket and Chrome DevTools Protocol. Chrome is required
in CI; locally, set `CHROME_BIN` to an installed Chromium-compatible executable
to enable this test, otherwise only the browser test is skipped. The test owns
an ephemeral loopback HTTP port, a headless browser, and a short test-owned
profile that it removes afterward; it never uses port 8080 or your browser profile.

Hosted build/startup, HTTPS routing, platform authentication, and external-client
compatibility still require separate validation in your authorized preview.

See [CONTRIBUTING.md](CONTRIBUTING.md), the
[Code of Conduct](.github/CODE_OF_CONDUCT.md), and [MIT license](LICENSE.md).
For security concerns, follow [Microsoft's security reporting guidance](https://www.microsoft.com/msrc);
do not put credentials or sensitive exploit details in a public issue.

## References

- [App Service Builder MCP hosting guide](https://builder.appservice.azure.com/docs/guides/host-mcp-server/)
- [Official MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP Streamable HTTP transport, protocol 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

The product mark uses the supplied App Service Builder asset in `assets/AppServiceBuilder.svg`. Its SVG is inlined in the root page to preserve the existing routes and security policy. Keep the inline copy and asset in sync when updating the logo.

Official ecosystem logo sources and trademark notices are documented in
[assets/NOTICE.md](assets/NOTICE.md). Artwork is stored locally and inlined;
no remote image or font requests are needed to render the root page.
