/**
 * The browser origin the workbench was opened on, and whether it is costing
 * the user anything.
 *
 * A container logs the address it listens on inside its own namespace —
 * `http://0.0.0.0:3000` — which reads like a URL and is the one people paste.
 * Browsers do not treat it as a trustworthy origin, so secure-context APIs are
 * withheld there. Nothing crashes any more (see `packages/core/src/random-id.ts`),
 * but the user is a keystroke away from an origin with none of the caveats and
 * has no way to know it.
 */

import { isWildcardAddress } from "../packages/core/src/local-addresses.ts";

export interface InsecureOriginNotice {
  headline: string;
  detail: string;
  /** A better origin to open, offered only when one is certain to be right. */
  suggestedUrl?: string;
}

export interface InsecureOriginInput {
  /** `window.isSecureContext`. */
  isSecureContext: boolean;
  /** `window.location.hostname`. */
  hostname: string;
  /** `window.location.port`; empty for a default port. */
  port: string;
  /** Reported by `GET /api/runtime-status`. */
  containerized: boolean;
}

export function insecureOriginNotice(
  input: InsecureOriginInput,
): InsecureOriginNotice | undefined {
  const { isSecureContext, hostname, port, containerized } = input;

  // Secure contexts include HTTPS and the loopback names browsers trust, which
  // is every origin this app is meant to be opened on.
  if (isSecureContext) return undefined;

  const localUrl = `http://localhost${port ? `:${port}` : ""}`;

  if (isWildcardAddress(hostname)) {
    return {
      headline: `${hostname} is a listening address, not a browser address`,
      detail: containerized
        ? `The container logs the address it binds inside its own network namespace. Open ${localUrl} instead — browsers trust that origin and grant it the full set of web APIs.`
        : `The server logs the address it binds to on every interface. Open ${localUrl} instead — browsers trust that origin and grant it the full set of web APIs.`,
      suggestedUrl: localUrl,
    };
  }

  // Some other host over plain HTTP: a LAN address, a container host, a
  // reverse proxy. Suggesting localhost here would be wrong — this browser may
  // not be running on the machine that serves the app.
  return {
    headline: "This page is not served from a trusted origin",
    detail: containerized
      ? `Browsers withhold some web APIs from plain HTTP outside localhost. If you are browsing from the machine running the container, open ${localUrl}. If you are not, serve Inference Lens over HTTPS.`
      : `Browsers withhold some web APIs from plain HTTP outside localhost. If you are browsing from the machine running the server, open ${localUrl}. If you are not, serve Inference Lens over HTTPS.`,
  };
}
