import { dirname } from "node:path";
import type { FileSystemDirectoryHandleLike, FileSystemFileHandleLike } from "../app/project-directory.client.ts";

export class ByteDirectory implements FileSystemDirectoryHandleLike {
  readonly kind = "directory";
  readonly name: string;
  readonly path: string;
  readonly root: ByteDirectory;
  files = new Map<string, Uint8Array>();
  directories = new Set([""]);
  writes: string[] = [];
  failPath?: string;
  afterWrite?: (path: string) => void;
  beforeRead?: (path: string) => void;
  constructor(path = "", root?: ByteDirectory) {
    this.path = path; this.name = path.split("/").at(-1) || "project"; this.root = root ?? this;
  }
  child(name: string) { return this.path ? `${this.path}/${name}` : name; }
  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandleLike> {
    const path = this.child(name);
    if (this.root.directories.has(path)) throw new DOMException("directory", "TypeMismatchError");
    if (!this.root.files.has(path)) {
      if (!options?.create) throw new DOMException("missing", "NotFoundError");
      this.root.files.set(path, new Uint8Array());
    }
    return {
      kind: "file", name,
      getFile: async () => {
        this.root.beforeRead?.(path);
        const contents = new Uint8Array(this.root.files.get(path)!);
        return { text: async () => new TextDecoder().decode(contents), arrayBuffer: async () => contents.buffer } as File;
      },
      createWritable: async () => {
        let pending = new Uint8Array();
        return {
          write: async (data: string | Uint8Array) => { pending = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data); },
          close: async () => {
            if (this.root.failPath === path) throw new Error("injected failure");
            this.root.files.set(path, pending);
            this.root.writes.push(path);
            this.root.afterWrite?.(path);
          },
        };
      },
    };
  }
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<ByteDirectory> {
    const path = this.child(name);
    if (this.root.files.has(path)) throw new DOMException("file", "TypeMismatchError");
    if (!this.root.directories.has(path)) {
      if (!options?.create) throw new DOMException("missing", "NotFoundError");
      this.root.directories.add(path);
    }
    return new ByteDirectory(path, this.root);
  }
  async *values() {
    for (const path of this.root.files.keys()) if (dirname(path) === (this.path || ".")) yield await this.getFileHandle(path.split("/").at(-1)!);
    for (const path of this.root.directories) if (path && dirname(path) === (this.path || ".")) yield new ByteDirectory(path, this.root);
  }
  async removeEntry(name: string) { this.root.files.delete(this.child(name)); }
  seed(path: string, data: string | Uint8Array) {
    let parent = dirname(path);
    while (parent !== ".") { this.root.directories.add(parent); parent = dirname(parent); }
    this.root.files.set(path, typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data));
  }
}
