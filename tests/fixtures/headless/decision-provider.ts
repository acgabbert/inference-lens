import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { DecisionInput } from "../../../packages/core/src/decision.ts";

const capture = JSON.parse(
  readFileSync(new URL("../system-one/llamacpp-all-types.json", import.meta.url), "utf8"),
) as {
  request: { questions: DecisionInput["questions"] };
  response: { status: number; body: Record<string, unknown> };
};

/** The questions the captured answer replies to; a decision suite under test asks exactly these. */
export const CAPTURED_QUESTIONS = capture.request.questions;

/**
 * A System One endpoint that records what reached it and answers every
 * request with the committed llama.cpp capture (`intent` billing, `severity`
 * about 1.09, `is_spam` about 0.08), so which checks pass is known before the
 * run. Requests whose questions differ from the capture's get a 400, as the
 * fixture provider does, so a run that sent the wrong input cannot pass.
 */
export async function recordingDecisionProvider(options: {
  /** Answers the first request with a 429 carrying this `Retry-After`. */
  rateLimitFirstRequest?: string;
  /** Answers every request with a 429 carrying `retry-after: 1`. */
  alwaysRateLimit?: boolean;
} = {}) {
  const requests: Array<{
    path: string;
    authorization?: string;
    body: { model?: string; state?: unknown; questions?: unknown };
  }> = [];
  const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({
      path: request.url ?? "",
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
      body,
    });
    const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(payload));
    };
    if (request.method !== "POST" || request.url !== "/v1/systemone") {
      send(404, { error: { code: 404, message: `Not found: ${request.url}`, type: "not_found_error" } });
      return;
    }
    if (options.alwaysRateLimit || (options.rateLimitFirstRequest !== undefined && requests.length === 1)) {
      send(429, { error: { code: 429, message: "Too many requests", type: "rate_limit_error" } }, {
        "retry-after": options.rateLimitFirstRequest ?? "1",
      });
      return;
    }
    if (JSON.stringify(body.questions) !== JSON.stringify(capture.request.questions)) {
      send(400, { error: { code: 400, message: "Unexpected questions.", type: "invalid_request_error" } });
      return;
    }
    send(capture.response.status, { ...capture.response.body, model: body.model });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
