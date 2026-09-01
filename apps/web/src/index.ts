/**
 * The web application, as a library.
 *
 * `main.ts` is the executable; this is what a test imports. The split matters: importing
 * a module must never bind a port, and a test that has to guard against that is a test
 * of the wrong thing.
 */

export { startWebServer, defaultPublicDir, type RunningServer, type WebServerOptions } from "./server";
export { createApi, type ApiDependencies, type WebApi } from "./routes";
export { readStaticAsset, type StaticAsset } from "./static";
export {
  jsonResponse,
  serializeJson,
  type ApiHandler,
  type ApiRequest,
  type ApiResponse,
} from "./api";
