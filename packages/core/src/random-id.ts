/**
 * `crypto.randomUUID()` is only exposed in secure contexts (HTTPS or
 * `localhost`). The Docker-hosted build is commonly reached over plain HTTP
 * from a non-localhost address (LAN IP, reverse proxy), where browsers drop
 * the method entirely and every call site that used it directly threw. This
 * wraps `crypto.randomUUID()` and falls back to `crypto.getRandomValues()`,
 * which carries no such restriction, so ID generation stays uniformly
 * random everywhere the app runs.
 */
export function randomUUID(): string {
  const cryptoObj = globalThis.crypto;
  if (typeof cryptoObj?.randomUUID === "function") {
    try {
      return cryptoObj.randomUUID();
    } catch {
      // Falls through to getRandomValues in insecure contexts.
    }
  }
  if (typeof cryptoObj?.getRandomValues === "function") {
    const bytes = cryptoObj.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
    return [
      hex.slice(0, 4).join(""),
      hex.slice(4, 6).join(""),
      hex.slice(6, 8).join(""),
      hex.slice(8, 10).join(""),
      hex.slice(10, 16).join(""),
    ].join("-");
  }
  throw new Error("No secure random source available to generate an ID");
}
