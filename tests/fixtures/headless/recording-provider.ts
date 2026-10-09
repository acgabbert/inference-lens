import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const ANSWER = "Buffered fixture response: 2 + 2 = 4.";

/**
 * A chat-completions provider that records what reached it. The recorded
 * Authorization header is the proof the key got to the wire; scanning the
 * written files for the same key is the proof it went nowhere else.
 */
export async function recordingProvider(options: {
  holdFirstRequest?: Promise<void>;
  /**
   * Holds every request until this many are in flight at once, so a run that
   * never overlaps them is seen at a peak of 1 rather than passing by luck.
   * Gives up after a second so a sequential run still finishes.
   */
  holdUntilInFlight?: number;
  /** Answers the first request with a 429 carrying this `Retry-After`. */
  rateLimitFirstRequest?: string;
  /** Answers the first request with this non-retryable HTTP status. */
  failFirstRequest?: number;
} = {}) {
  const requests: Array<{
    authorization?: string;
    body: { model?: string; stream?: boolean; messages?: Array<{ role: string; content: unknown }> };
  }> = [];
  let inFlight = 0;
  let peakInFlight = 0;
  let releaseOverlap: () => void = () => {};
  const overlapped = new Promise<void>((resolve) => { releaseOverlap = resolve; });
  const overlapTimeout = setTimeout(releaseOverlap, 1_000);
  let first = true;
  let notifyFirst: () => void = () => {};
  const firstArrived = new Promise<void>((resolve) => { notifyFirst = resolve; });
  const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    requests.push({
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    if (options.holdUntilInFlight !== undefined) {
      if (inFlight >= options.holdUntilInFlight) releaseOverlap();
      await overlapped;
    }
    if (first) {
      first = false;
      notifyFirst();
      await options.holdFirstRequest;
      if (options.rateLimitFirstRequest !== undefined) {
        response.writeHead(429, { "content-type": "application/json", "retry-after": options.rateLimitFirstRequest });
        response.end(JSON.stringify({ error: { message: "Too many requests" } }));
        inFlight -= 1;
        return;
      }
      if (options.failFirstRequest !== undefined) {
        response.writeHead(options.failFirstRequest, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Intentional failure" } }));
        inFlight -= 1;
        return;
      }
    }
    if (requests.at(-1)?.body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const [delta, finishReason] of [[{ content: ANSWER }, null], [{}, "stop"]] as const) {
        response.write(`data: ${JSON.stringify({
          id: "chatcmpl-headless",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`);
      }
      response.end("data: [DONE]\n\n");
      inFlight -= 1;
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl-headless",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: ANSWER }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 9, total_tokens: 12 },
    }));
    inFlight -= 1;
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}/v1`,
    requests,
    firstArrived,
    get peakInFlight() { return peakInFlight; },
    close: () => new Promise<void>((resolve) => {
      clearTimeout(overlapTimeout);
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
