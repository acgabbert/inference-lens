import assert from "node:assert/strict";
import test from "node:test";

import {
  coordinateProjectTab,
  parseProjectTabMessage,
  projectEditorLockName,
} from "../app/project-tab-coordination.client.ts";
import type {
  ProjectTabCoordinator,
  ProjectTabEvents,
  ProjectTabHost,
} from "../app/project-tab-coordination.client.ts";

const PROJECT = "project-tab-test";

/**
 * One exclusive Web Lock with the semantics the coordinator relies on:
 * `ifAvailable` grants null instead of queuing, a queued request can be
 * aborted, a steal rejects the holder's request with `AbortError`, and a
 * release grants the oldest queued request.
 */
class FakeLocks {
  holder?: { client: string; reject(error: unknown): void };
  readonly queue: Array<{ client: string; grant(): void; abort(): void }> = [];

  forClient(client: string): ProjectTabHost["locks"] {
    return {
      request: ((name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) => {
        assert.equal(name, projectEditorLockName(PROJECT));
        return new Promise<unknown>((resolve, reject) => {
          const entry = {
            client,
            grant: () => {
              this.holder = { client, reject };
              Promise.resolve(callback({ name, mode: "exclusive" } as Lock)).then((value) => {
                if (this.holder?.client !== client || this.holder.reject !== reject) return;
                this.holder = undefined;
                resolve(value);
                this.queue.shift()?.grant();
              });
            },
            abort: () => reject(new DOMException("Aborted", "AbortError")),
          };
          if (options.steal) {
            this.holder?.reject(new DOMException("Stolen", "AbortError"));
            this.holder = undefined;
            entry.grant();
          } else if (!this.holder && this.queue.length === 0) {
            entry.grant();
          } else if (options.ifAvailable) {
            Promise.resolve(callback(null)).then(resolve);
          } else {
            this.queue.push(entry);
            options.signal?.addEventListener("abort", () => {
              const index = this.queue.indexOf(entry);
              if (index >= 0) { this.queue.splice(index, 1); entry.abort(); }
            });
          }
        });
      }) as unknown as LockManager["request"],
      query: async () => ({
        held: this.holder ? [{ name: projectEditorLockName(PROJECT), mode: "exclusive", clientId: this.holder.client }] : [],
        pending: this.queue.map(({ client }) => ({ name: projectEditorLockName(PROJECT), mode: "exclusive" as const, clientId: client })),
      }),
    };
  }
}

interface FakeChannel {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(data: unknown): void;
  close(): void;
}

class FakeBus {
  readonly channels = new Set<FakeChannel>();
  /** When set, this channel hears nothing: a tab frozen in the background. */
  muted?: FakeChannel;

  open(): FakeChannel {
    const channel: FakeChannel = {
      onmessage: null,
      postMessage: (data) => {
        for (const other of this.channels) {
          if (other === channel || other === this.muted) continue;
          const copy = structuredClone(data);
          queueMicrotask(() => other.onmessage?.({ data: copy } as MessageEvent));
        }
      },
      close: () => { this.channels.delete(channel); },
    };
    this.channels.add(channel);
    return channel;
  }
}

class FakeTimers {
  readonly pending = new Map<number, () => void>();
  private next = 0;
  set(callback: () => void): number {
    this.next += 1;
    this.pending.set(this.next, callback);
    return this.next;
  }
  clear(handle: unknown): void { this.pending.delete(handle as number); }
  fireAll(): void {
    const due = [...this.pending.values()];
    this.pending.clear();
    for (const run of due) run();
  }
}

interface Tab {
  coordinator: ProjectTabCoordinator;
  log: string[];
  channel: () => FakeChannel;
  flushes: number;
}

function world() {
  const locks = new FakeLocks();
  const bus = new FakeBus();
  const timers = new FakeTimers();
  let tokens = 0;
  function open(client: string, options: { flush?: () => Promise<void> } = {}): Tab {
    let channel!: FakeChannel;
    const tab: Tab = { coordinator: undefined!, log: [], channel: () => channel, flushes: 0 };
    const events: ProjectTabEvents = {
      acquired: (cause) => tab.log.push(`acquired:${cause}`),
      secondary: (cause) => tab.log.push(`secondary:${cause}`),
      peerSaved: () => tab.log.push("peer-saved"),
      flushBeforeRelease: () => {
        tab.flushes += 1;
        return options.flush?.() ?? Promise.resolve();
      },
    };
    tab.coordinator = coordinateProjectTab(PROJECT, events, {
      locks: locks.forClient(client),
      openChannel: () => (channel = bus.open()),
      newToken: () => `${client}-token-${(tokens += 1)}`,
      setTimeout: (callback) => timers.set(callback),
      clearTimeout: (handle) => timers.clear(handle),
    });
    return tab;
  }
  return { locks, bus, timers, open };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

test("messages are validated by shape and anything unrecognized is ignored", () => {
  assert.deepEqual(parseProjectTabMessage({ type: "saved", projectId: "p", tab: "t" }), { type: "saved", projectId: "p", tab: "t" });
  assert.deepEqual(
    parseProjectTabMessage({ type: "release-request", projectId: "p", tab: "t", requestId: "r", path: "/secret" }),
    { type: "release-request", projectId: "p", tab: "t", requestId: "r" },
  );
  for (const invalid of [
    null,
    "saved",
    [],
    { type: "saved", projectId: "p" },
    { type: "saved", projectId: "", tab: "t" },
    { type: "saved", projectId: 7, tab: "t" },
    { type: "released", projectId: "p", tab: "t" },
    { type: "open-run", projectId: "p", tab: "t" },
  ]) {
    assert.equal(parseProjectTabMessage(invalid), undefined, JSON.stringify(invalid));
  }
});

test("the first tab becomes editor and later tabs are secondary", async () => {
  const { open } = world();
  const editor = open("a");
  await settle();
  const second = open("b");
  await settle();
  assert.deepEqual(editor.log, ["acquired:initial"]);
  assert.deepEqual(second.log, ["secondary:occupied"]);
  assert.equal(await editor.coordinator.holdsEditorLock(), true);
  assert.equal(await second.coordinator.holdsEditorLock(), false);
});

test("closing the editor hands the role to a waiting tab", async () => {
  const { open } = world();
  const editor = open("a");
  await settle();
  const second = open("b");
  await settle();
  editor.coordinator.close();
  await settle();
  assert.deepEqual(second.log, ["secondary:occupied", "acquired:vacated"]);
  assert.equal(await second.coordinator.holdsEditorLock(), true);
});

test("a requested handover flushes the editor before the requester takes the lock", async () => {
  const { open } = world();
  let finishFlush!: () => void;
  const editor = open("a", { flush: () => new Promise((resolve) => { finishFlush = resolve; }) });
  await settle();
  const requester = open("b");
  const bystander = open("c");
  await settle();

  void requester.coordinator.requestEditor();
  await settle();
  assert.equal(editor.flushes, 1);
  // Until the flush finishes, the editor still holds the lock and nobody else does.
  assert.deepEqual(editor.log, ["acquired:initial"]);
  assert.equal(await editor.coordinator.holdsEditorLock(), true);

  finishFlush();
  await settle();
  assert.deepEqual(editor.log, ["acquired:initial", "secondary:handed-over"]);
  assert.deepEqual(requester.log, ["secondary:occupied", "acquired:requested"]);
  // The queued bystander never slips in between release and request.
  assert.deepEqual(bystander.log, ["secondary:occupied"]);
  assert.equal(await requester.coordinator.holdsEditorLock(), true);
  assert.equal(await editor.coordinator.holdsEditorLock(), false);
});

test("an editor that does not answer is stolen from after the timeout", async () => {
  const { open, bus, timers } = world();
  const editor = open("a");
  await settle();
  const requester = open("b");
  await settle();
  bus.muted = editor.channel();

  void requester.coordinator.requestEditor();
  await settle();
  assert.deepEqual(requester.log, ["secondary:occupied"]);
  timers.fireAll();
  await settle();

  assert.equal(editor.flushes, 0);
  assert.deepEqual(requester.log, ["secondary:occupied", "acquired:requested"]);
  assert.deepEqual(editor.log, ["acquired:initial", "secondary:stolen"]);
  assert.equal(await editor.coordinator.holdsEditorLock(), false);
});

test("the write fence asks the lock manager, not the tab's memory", async () => {
  const { open, locks } = world();
  const editor = open("a");
  await settle();
  // A steal whose rejection this tab has not processed yet, as after a thaw.
  const stolen = locks.holder!;
  locks.holder = { client: "b", reject: () => undefined };
  assert.equal(await editor.coordinator.holdsEditorLock(), false);
  locks.holder = stolen;
  assert.equal(await editor.coordinator.holdsEditorLock(), true);
});

test("saves are announced to other tabs of the same project only", async () => {
  const { open, bus } = world();
  const editor = open("a");
  await settle();
  const second = open("b");
  await settle();
  const elsewhere = bus.open();
  elsewhere.postMessage({ type: "saved", projectId: "another-project", tab: "z" });
  editor.coordinator.announceSaved();
  second.coordinator.announceSaved();
  await settle();
  assert.deepEqual(second.log, ["secondary:occupied", "peer-saved"]);
  assert.deepEqual(editor.log, ["acquired:initial"]);
});

test("declining an unadopted hold hands the lock to the tab waiting for it", async () => {
  const { open, locks } = world();
  const editor = open("a");
  await settle();
  const requester = open("b");
  await settle();
  void requester.coordinator.requestEditor();
  await settle();
  assert.deepEqual(editor.log, ["acquired:initial", "secondary:handed-over"]);

  await requester.coordinator.declineEditor();
  await settle();
  // The yielded tab regains the role; the decliner queues behind it, unreported.
  assert.deepEqual(editor.log, ["acquired:initial", "secondary:handed-over", "acquired:vacated"]);
  assert.deepEqual(requester.log, ["secondary:occupied", "acquired:requested"]);
  assert.equal(locks.holder?.client, "a");
  assert.deepEqual(locks.queue.map(({ client }) => client), ["b"]);
});

test("declining keeps the hold when no other tab is waiting for it", async () => {
  const { open, locks } = world();
  const editor = open("a");
  await settle();
  const second = open("b");
  await settle();
  editor.coordinator.close();
  await settle();
  assert.deepEqual(second.log, ["secondary:occupied", "acquired:vacated"]);

  // Releasing would only grant the lock straight back and ask again.
  await second.coordinator.declineEditor();
  await settle();
  assert.deepEqual(second.log, ["secondary:occupied", "acquired:vacated"]);
  assert.equal(locks.holder?.client, "b");

  // A tab that opens later still gets the role by asking for it.
  const third = open("c");
  await settle();
  void third.coordinator.requestEditor();
  await settle();
  assert.deepEqual(third.log, ["secondary:occupied", "acquired:requested"]);
  assert.deepEqual(second.log, ["secondary:occupied", "acquired:vacated", "secondary:handed-over"]);
});

test("closing releases the lock and stops reporting", async () => {
  const { open, locks } = world();
  const editor = open("a");
  await settle();
  editor.coordinator.close();
  editor.coordinator.close();
  await settle();
  assert.equal(locks.holder, undefined);
  assert.deepEqual(editor.log, ["acquired:initial"]);
});
