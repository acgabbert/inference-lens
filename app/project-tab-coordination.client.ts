"use client";

/**
 * Same-origin coordination of which browser tab writes a project's manifest.
 *
 * One Web Lock per project ID names the editor tab; a `BroadcastChannel`
 * carries the handover conversation. This module owns only those two host
 * primitives: it knows nothing of React, the project document or the folder.
 * Tabs on other origins, the desktop app and other machines do not take part,
 * so the manifest's expected-content check remains their only protection.
 */

const CHANNEL_NAME = "inference-lens:project-tabs";
/** How long a requesting tab waits for the editor to flush before stealing. */
export const HANDOVER_REPLY_TIMEOUT_MS = 2_000;
/** How long a yielded editor keeps its lock for the requester to steal it. */
const YIELDED_LOCK_TIMEOUT_MS = 5_000;

export function projectEditorLockName(projectId: string): string {
  return `inference-lens:project-editor:${projectId}`;
}

/**
 * Messages carry project IDs and opaque tab tokens only, never paths or
 * contents. Run links will add a message of their own.
 */
export type ProjectTabMessage =
  | { type: "saved"; projectId: string; tab: string }
  | { type: "release-request"; projectId: string; tab: string; requestId: string }
  | { type: "released"; projectId: string; tab: string; requestId: string };

/** Same-origin, but still untrusted in shape: anything unrecognized is `undefined`. */
export function parseProjectTabMessage(value: unknown): ProjectTabMessage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const message = value as Record<string, unknown>;
  const text = (key: string) => typeof message[key] === "string" && message[key] !== "";
  if (!text("projectId") || !text("tab")) return undefined;
  const projectId = message.projectId as string;
  const tab = message.tab as string;
  switch (message.type) {
    case "saved":
      return { type: "saved", projectId, tab };
    case "release-request":
    case "released":
      return text("requestId")
        ? { type: message.type, projectId, tab, requestId: message.requestId as string }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * Why this tab now holds the editor lock. `initial`: it was free when the
 * project opened. `vacated`: the editor tab closed or crashed. `requested`:
 * this tab asked for it.
 */
export type LockAcquisition = "initial" | "vacated" | "requested";

/**
 * Why this tab no longer may write. `handed-over`: it flushed and yielded to a
 * tab that asked. `stolen`: a tab took the lock without its reply, typically
 * because this tab was frozen in the background, so a pending change may not
 * have been flushed.
 */
export type LockLoss = "handed-over" | "stolen";

export interface ProjectTabEvents {
  acquired(cause: LockAcquisition): void;
  /** The tab started as, or became, a tab that must not write the manifest. */
  secondary(cause: "occupied" | LockLoss): void;
  /** The editor tab saved the manifest. */
  peerSaved(): void;
  /**
   * Another tab asked for the editor role. Resolve once pending changes are
   * flushed; from then on this tab must not write.
   */
  flushBeforeRelease(): Promise<void>;
}

export interface ProjectTabCoordinator {
  /** Ask the editor to flush and yield; take the lock when it replies or times out. */
  requestEditor(): Promise<void>;
  /**
   * Asks the lock manager, not this tab's memory, whether this tab still holds
   * the editor lock. A tab thawed after a steal can run a pending autosave
   * before it learns the lock is gone; this is the fence that stops it.
   */
  holdsEditorLock(): Promise<boolean>;
  announceSaved(): void;
  /** Releases the lock and stops listening. Idempotent. */
  close(): void;
}

/** Narrow host seams, so role transitions can be tested without a browser. */
export interface ProjectTabHost {
  locks: Pick<LockManager, "request" | "query">;
  openChannel(): Pick<BroadcastChannel, "postMessage" | "close"> & {
    onmessage: ((event: MessageEvent) => void) | null;
  };
  newToken(): string;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export function browserProjectTabHost(): ProjectTabHost | undefined {
  if (
    typeof navigator === "undefined" ||
    !navigator.locks ||
    typeof BroadcastChannel === "undefined"
  ) {
    return undefined;
  }
  return {
    locks: navigator.locks,
    openChannel: () => new BroadcastChannel(CHANNEL_NAME),
    newToken: () => crypto.randomUUID(),
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  };
}

/**
 * Starts coordinating one open project. The first event is always `acquired`
 * or `secondary`; until then the tab must not write.
 */
export function coordinateProjectTab(
  projectId: string,
  events: ProjectTabEvents,
  host: ProjectTabHost,
): ProjectTabCoordinator {
  const lockName = projectEditorLockName(projectId);
  const tab = host.newToken();
  const channel = host.openChannel();
  let closed = false;
  /** Resolving it releases the held lock; set exactly while this tab holds it. */
  let releaseHeld: (() => void) | undefined;
  /** The lock manager's name for this tab's hold, read while it holds the lock. */
  let holder: Promise<string | undefined> = Promise.resolve(undefined);
  /** Aborts the queued wait for the editor tab to close. */
  let stopWaiting: AbortController | undefined;
  /** Answering a release request: flushing, then yielding. */
  let yielding = false;
  /** Already reported itself secondary after yielding. */
  let handedOver = false;
  let yieldTimer: unknown;
  let awaitingRelease: { requestId: string; resolve(): void } | undefined;
  let requesting: Promise<void> | undefined;

  function post(message: ProjectTabMessage): void {
    if (!closed) channel.postMessage(message);
  }

  async function currentHolder(): Promise<string | undefined> {
    const snapshot = await host.locks.query();
    return snapshot.held?.find(({ name }) => name === lockName)?.clientId;
  }

  /**
   * Requests the lock and holds it until `releaseHeld` runs. A hold that ends
   * any other way was stolen: the request rejects with `AbortError`.
   */
  function acquire(
    options: LockOptions,
    cause: () => LockAcquisition,
    notGranted?: () => void,
  ): void {
    let granted = false;
    host.locks
      .request(lockName, options, (lock) => {
        if (!lock || closed) return undefined;
        granted = true;
        yielding = false;
        handedOver = false;
        const held = new Promise<void>((resolve) => { releaseHeld = resolve; });
        // Only this tab holds an exclusive lock now, so the holder is this tab.
        holder = currentHolder().catch(() => undefined);
        events.acquired(cause());
        return held;
      })
      .then(
        () => { if (granted) ended(); else notGranted?.(); },
        () => { if (granted) ended(); },
      );
  }

  function ended(): void {
    releaseHeld = undefined;
    holder = Promise.resolve(undefined);
    host.clearTimeout(yieldTimer);
    if (closed) return;
    if (!handedOver) events.secondary("stolen");
    yielding = false;
    handedOver = false;
    waitForVacancy();
  }

  function waitForVacancy(): void {
    if (closed || releaseHeld) return;
    stopWaiting?.abort();
    stopWaiting = new AbortController();
    // A vacancy that arrives while this tab is asking satisfies the request.
    acquire({ signal: stopWaiting.signal }, () => requesting ? "requested" : "vacated");
  }

  channel.onmessage = (event: MessageEvent) => {
    const message = parseProjectTabMessage(event.data);
    if (!message || message.projectId !== projectId || message.tab === tab || closed) return;
    switch (message.type) {
      case "saved":
        events.peerSaved();
        return;
      case "release-request":
        if (!releaseHeld || yielding) return;
        yielding = true;
        void events.flushBeforeRelease().catch(() => undefined).then(() => {
          // A steal that landed during the flush has already been reported.
          if (closed || !releaseHeld) return;
          handedOver = true;
          events.secondary("handed-over");
          post({ type: "released", projectId, tab, requestId: message.requestId });
          // The requester steals the lock. Should it vanish instead, release so
          // a waiting tab is not blocked by an editor that no longer writes.
          yieldTimer = host.setTimeout(() => releaseHeld?.(), YIELDED_LOCK_TIMEOUT_MS);
        });
        return;
      case "released":
        if (awaitingRelease?.requestId === message.requestId) awaitingRelease.resolve();
    }
  };

  acquire({ ifAvailable: true }, () => "initial", () => {
    if (closed) return;
    events.secondary("occupied");
    waitForVacancy();
  });

  function requestEditor(): Promise<void> {
    if (closed) return Promise.resolve();
    if (releaseHeld && !yielding) {
      // Holding after a vacancy the user had not yet adopted.
      events.acquired("requested");
      return Promise.resolve();
    }
    requesting ??= (async () => {
      const requestId = host.newToken();
      await new Promise<void>((resolve) => {
        const timer = host.setTimeout(resolve, HANDOVER_REPLY_TIMEOUT_MS);
        awaitingRelease = {
          requestId,
          resolve: () => { host.clearTimeout(timer); resolve(); },
        };
        post({ type: "release-request", projectId, tab, requestId });
      });
      awaitingRelease = undefined;
      if (closed || (releaseHeld && !yielding)) return;
      stopWaiting?.abort();
      stopWaiting = undefined;
      // Steal whether or not the editor replied. After a reply it completes the
      // handover without a gap in which a queued tab could take the lock.
      acquire({ steal: true }, () => "requested");
    })().finally(() => { requesting = undefined; });
    return requesting;
  }

  return {
    requestEditor,
    async holdsEditorLock() {
      if (!releaseHeld) return false;
      const [mine, current] = await Promise.all([holder, currentHolder().catch(() => undefined)]);
      // Without client IDs to compare, fall back to what this tab believes.
      if (!mine || !current) return releaseHeld !== undefined;
      return mine === current;
    },
    announceSaved() {
      if (releaseHeld) post({ type: "saved", projectId, tab });
    },
    close() {
      if (closed) return;
      closed = true;
      host.clearTimeout(yieldTimer);
      stopWaiting?.abort();
      releaseHeld?.();
      releaseHeld = undefined;
      channel.onmessage = null;
      channel.close();
    },
  };
}
