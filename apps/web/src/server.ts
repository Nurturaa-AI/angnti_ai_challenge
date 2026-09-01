import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { serializeJson, type ApiRequest } from "./api";
import { createApi, type ApiDependencies, type WebApi } from "./routes";
import { readStaticAsset } from "./static";

/**
 * The HTTP adapter.
 *
 * Everything here is transport: read a body, choose between the API and the asset
 * directory, write bytes, set headers. No decision that affects an analysis, a citation
 * or a boundary is made in this file — those all live in `routes.ts` and below, which is
 * why the routes can be tested without a socket and this can be checked by reading it.
 *
 * Three things it does own, because they are properties of being reachable over HTTP:
 *
 *   - **Loopback only.** The default host is `127.0.0.1`. This server reads repositories
 *     and holds their contents in memory; it is a local tool, and binding `0.0.0.0` by
 *     default would put a file reader on the network.
 *   - **Host and Origin checks.** A page on the internet can point a name at 127.0.0.1
 *     (DNS rebinding) and then talk to this server with the browser's own credentials.
 *     Requiring a loopback `Host` and refusing a foreign `Origin` closes that, and costs
 *     a legitimate local client nothing.
 *   - **A restrictive CSP.** The dashboard renders text taken from an untrusted
 *     repository. `default-src 'none'` with `'self'` for scripts and styles means that
 *     even a successful injection has nowhere to send what it steals — which is also why
 *     the UI keeps its script and stylesheet in separate files instead of inlining them.
 */

const DEFAULT_PORT = 4173;
const DEFAULT_HOST = "127.0.0.1";
/** A request body larger than this is refused unread. */
const MAX_BODY_BYTES = 1024 * 1024;

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cache-control": "no-store",
};

export interface WebServerOptions extends ApiDependencies {
  host?: string | undefined;
  /** `0` asks the OS for a free port, which is what the integration test uses. */
  port?: number | undefined;
  /** Defaults to this package's own `public/`. */
  publicDir?: string | undefined;
}

export interface RunningServer {
  url: string;
  host: string;
  port: number;
  api: WebApi;
  close: () => Promise<void>;
}

export function defaultPublicDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
}

export async function startWebServer(options: WebServerOptions): Promise<RunningServer> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const publicDir = options.publicDir ?? defaultPublicDir();
  const api = createApi(options);

  const server = createServer((request, response) => {
    void handle(api, publicDir, request, response);
  });

  await listen(server, host, port);
  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;

  return {
    url: `http://${host}:${boundPort}`,
    host,
    port: boundPort,
    api,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function handle(
  api: WebApi,
  publicDir: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    if (!isLocalHost(request.headers.host)) {
      send(response, 421, "text/plain; charset=utf-8", Buffer.from("This server answers on localhost only.\n"));
      return;
    }
    if (!isSameOrigin(request.headers.origin, request.headers.host)) {
      send(response, 403, "text/plain; charset=utf-8", Buffer.from("Cross-origin requests are refused.\n"));
      return;
    }

    // A relative URL needs a base to parse; the value is discarded with the object.
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      await serveApi(api, request, response, url);
      return;
    }

    const asset = readStaticAsset(publicDir, url.pathname);
    if (asset) {
      send(response, 200, asset.contentType, asset.bytes);
      return;
    }
    send(response, 404, "text/plain; charset=utf-8", Buffer.from("Not found.\n"));
  } catch (error) {
    // The routes handle their own errors; reaching here means the transport failed.
    if (!response.headersSent) {
      send(
        response,
        500,
        "application/json; charset=utf-8",
        Buffer.from(
          serializeJson({
            error: { name: "TransportError", message: error instanceof Error ? error.message : "Request failed." },
          }),
          "utf8",
        ),
      );
    } else {
      response.end();
    }
  }
}

async function serveApi(
  api: WebApi,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  let body: unknown;
  if (request.method === "POST" || request.method === "PUT" || request.method === "PATCH") {
    const raw = await readBody(request);
    if (raw === "too-large") {
      // The response has to be written before the socket goes away, or the client sees
      // a connection reset and has to guess why. `connection: close` tells it not to
      // reuse the socket, and the unread remainder is discarded once the reply is out.
      send(
        response,
        413,
        "application/json; charset=utf-8",
        Buffer.from(
          serializeJson({
            error: {
              name: "RequestError",
              message: "The request body is too large.",
              hint: `The limit is ${MAX_BODY_BYTES} bytes.`,
            },
          }),
          "utf8",
        ),
        { connection: "close" },
      );
      response.on("finish", () => request.destroy());
      return;
    }
    if (raw.trim() !== "") {
      try {
        body = JSON.parse(raw);
      } catch {
        send(
          response,
          400,
          "application/json; charset=utf-8",
          Buffer.from(
            serializeJson({
              error: { name: "RequestError", message: "The request body is not valid JSON." },
            }),
            "utf8",
          ),
        );
        return;
      }
    }
  }

  const apiRequest: ApiRequest = {
    method: request.method ?? "GET",
    path: url.pathname,
    query: url.searchParams,
    body,
  };

  const result = await api.handle(apiRequest);
  if (result.kind === "json") {
    // One serialiser, so `redactSecrets` runs on every JSON body that leaves here.
    send(response, result.status, "application/json; charset=utf-8", Buffer.from(serializeJson(result.value), "utf8"));
    return;
  }

  const headers: Record<string, string> = {};
  if (result.filename !== undefined) {
    // The filename is a slug built by the exporter, never a caller's string.
    headers["content-disposition"] = `attachment; filename="${result.filename}"`;
  }
  send(response, result.status, result.contentType, Buffer.from(result.bytes), headers);
}

/**
 * Reads the body, or gives up at the cap.
 *
 * Giving up means: stop buffering, stop reading, and hand the decision back — not tear
 * the connection down. The caller still owes the client an answer, and a socket destroyed
 * here would take the answer with it.
 */
function readBody(request: IncomingMessage): Promise<string | "too-large"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    request.on("data", (chunk: Buffer) => {
      if (refused) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        refused = true;
        request.pause();
        resolve("too-large");
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!refused) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", (error) => {
      if (!refused) reject(error);
    });
  });
}

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  bytes: Buffer,
  extra: Record<string, string> = {},
): void {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    ...extra,
    "content-type": contentType,
    "content-length": String(bytes.length),
  });
  response.end(bytes);
}

/**
 * True when the `Host` header names loopback.
 *
 * The defence against DNS rebinding: an attacker's domain resolving to 127.0.0.1 still
 * sends its own name in `Host`, and no legitimate client of a local tool sends anything
 * but `localhost` or an IP loopback address.
 */
function isLocalHost(header: string | undefined): boolean {
  if (header === undefined) return false;
  const name = header.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return name === "localhost" || name === "127.0.0.1" || name === "::1" || name === "0:0:0:0:0:0:0:1";
}

/** A browser sends `Origin` on any cross-site request; a matching one is ours. */
function isSameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined || origin === "null") return true; // Not a browser form/fetch.
  if (host === undefined) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}
