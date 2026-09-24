import { createHash, randomUUID } from "node:crypto";
import type { McpServerDeclaration } from "./mcp-server-catalog.ts";

export type McpConsentMode = "ask" | "automatic";

export interface McpConsent {
  toolId: string;
  serverId: string;
  remoteToolName: string;
  discoveryFingerprint: string;
  mode: McpConsentMode;
  grantedAt: string;
  declarationFingerprint: string;
}

export function mcpDeclarationFingerprint(declaration: McpServerDeclaration): string {
  return createHash("sha256").update(JSON.stringify([
    declaration.endpoint, declaration.authorization, declaration.callTimeoutMs,
    declaration.maxResponseBytes,
  ])).digest("hex");
}

export function publicMcpConsent(consent: McpConsent) {
  const { declarationFingerprint: _private, ...publicValue } = consent;
  void _private;
  return publicValue;
}

const SESSION_IDLE_MS = 86_400_000;
const sessions = new Map<string, { grants: Map<string, McpConsent>; touchedAt: number }>();
const COOKIE = "il_mcp_session";

function activeSession(id: string | undefined) {
  if (!id) return;
  const session = sessions.get(id);
  if (!session) return;
  if (Date.now() - session.touchedAt > SESSION_IDLE_MS) {
    sessions.delete(id);
    return;
  }
  session.touchedAt = Date.now();
  return session;
}

export function mcpSession(request: Request): string | undefined {
  const value = request.headers.get("cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return value && /^[a-f0-9-]{36}$/.test(value) && activeSession(value) ? value : undefined;
}

export function createMcpSession(): string {
  for (const [key, session] of sessions) {
    if (Date.now() - session.touchedAt > SESSION_IDLE_MS) sessions.delete(key);
  }
  const id = randomUUID();
  sessions.set(id, { grants: new Map(), touchedAt: Date.now() });
  return id;
}

export function mcpSessionCookie(id: string, secure = false): string {
  return `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/api/mcp${secure ? "; Secure" : ""}`;
}

export function listMcpConsents(session: string | undefined): McpConsent[] {
  return [...(activeSession(session)?.grants.values() ?? [])];
}

export function findMcpConsent(session: string | undefined, toolId: string): McpConsent | undefined {
  return activeSession(session)?.grants.get(toolId);
}

export function setMcpConsent(session: string, consent: McpConsent): void {
  activeSession(session)!.grants.set(consent.toolId, consent);
}

export function removeMcpConsent(session: string | undefined, toolId: string): void {
  activeSession(session)?.grants.delete(toolId);
}
