import { redactSecrets } from "@repo-arch/shared";

/**
 * The transport-agnostic shape of a request and a response.
 *
 * The router below never touches a socket, which is the point: every route is a
 * function from a plain object to a plain object, so the whole API is testable without
 * binding a port, and the `node:http` adapter has nothing in it worth testing.
 */

export interface ApiRequest {
  method: string;
  /** Path only, already decoded, no query string. */
  path: string;
  query: URLSearchParams;
  /** Parsed JSON body, or `undefined` for a request without one. */
  body: unknown;
}

export type ApiResponse =
  | { kind: "json"; status: number; value: unknown }
  | {
      kind: "bytes";
      status: number;
      contentType: string;
      bytes: Uint8Array;
      /** Sets `Content-Disposition: attachment`. */
      filename?: string;
    }
  | {
      kind: "stream";
      status: number;
      contentType: string;
      /**
       * Writes to the open response and returns a teardown for when it closes.
       *
       * A route stays a function from a plain object to a plain object right up
       * to here, where it cannot: a progress stream is a socket held open, which
       * is the one thing the transport-agnostic shape above cannot express. So
       * the route hands over a *function* rather than a socket. It is given
       * `send`, which frames one event, and `close`, which ends the response;
       * it never sees the `ServerResponse`, cannot set a header, and cannot
       * write an unframed byte. The adapter calls the returned teardown when the
       * client disconnects.
       */
      open: (channel: StreamChannel) => (() => void) | void;
    };

export interface StreamChannel {
  /** Sends one server-sent event. Named events; the browser listens per name. */
  send: (event: string, data: unknown) => void;
  /** A comment line. Keeps an idle connection alive through a proxy. */
  comment: (text: string) => void;
  close: () => void;
}

export type ApiHandler = (request: ApiRequest) => Promise<ApiResponse>;

export function jsonResponse(value: unknown, status = 200): ApiResponse {
  return { kind: "json", status, value };
}

/**
 * Serialises a JSON response.
 *
 * `redactSecrets` is applied here, to the finished string, for the same reason
 * `writeJsonFile` applies it to a file: this is where content leaves the process, and a
 * choke point cannot be forgotten by a route added later. Redacting per field would put
 * the obligation on every author of every response.
 *
 * The evidence ledger holds raw repository text — redaction has never been applied on
 * the way *in*, because grounding has to verify an excerpt against what the file really
 * says. So the outbound boundary is exactly where it belongs.
 */
export function serializeJson(value: unknown): string {
  return redactSecrets(JSON.stringify(value) ?? "null");
}
