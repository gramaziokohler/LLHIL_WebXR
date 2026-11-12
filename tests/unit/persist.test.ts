import { describe, expect, it } from "vitest";
import { createAlignmentStore } from "../../src/persist";

const KEY = (id: string) => `llhil-webxr:alignment:${id}`;

class MemoryStorage implements Storage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

class FakeAnchor {
  deleted = false;
  handle: string | null = null;
  failHandle = false;
  constructor(readonly session: FakeSession) {}
  async requestPersistentHandle(): Promise<string> {
    if (this.failHandle) throw new DOMException("no", "InvalidStateError");
    this.handle ??= uuid();
    this.session.persistent.set(this.handle, this);
    return this.handle;
  }
  delete(): void {
    this.deleted = true;
  }
}

class FakeSession {
  persistent = new Map<string, FakeAnchor>();
  deletedHandles: string[] = [];
  failRestore = new Set<string>();
  get persistentAnchors(): string[] {
    return [...this.persistent.keys()];
  }
  async restorePersistentAnchor(id: string): Promise<FakeAnchor> {
    if (!this.persistent.has(id) || this.failRestore.has(id)) {
      throw new DOMException(`not found ${id}`, "InvalidStateError");
    }
    const restored = new FakeAnchor(this);
    restored.handle = id;
    return restored;
  }
  async deletePersistentAnchor(id: string): Promise<void> {
    this.deletedHandles.push(id);
    if (!this.persistent.delete(id)) throw new DOMException("unknown", "InvalidStateError");
  }
  anchor(): FakeAnchor {
    return new FakeAnchor(this);
  }
}

const asSession = (s: unknown) => s as XRSession;
const asAnchor = (a: FakeAnchor) => a as unknown as XRAnchor;

function setup() {
  const storage = new MemoryStorage();
  const session = new FakeSession();
  const store = createAlignmentStore(storage);
  return { storage, session, store, xr: asSession(session) };
}

describe("createAlignmentStore", () => {
  it("saves two anchors and restores them by id", async () => {
    const { storage, session, store, xr } = setup();
    const a = session.anchor();
    const b = session.anchor();
    expect(store.supported(xr)).toBe(true);
    expect(await store.save(xr, "site", asAnchor(a), asAnchor(b))).toBe(true);

    const record = JSON.parse(storage.getItem(KEY("site")) as string);
    expect(record).toMatchObject({ v: 1, a: a.handle, b: b.handle });
    expect(Number.isNaN(Date.parse(record.savedAt))).toBe(false);

    const restored = await store.restore(xr, "site");
    expect(restored).not.toBeNull();
    expect((restored?.a as unknown as FakeAnchor).handle).toBe(a.handle);
    expect((restored?.b as unknown as FakeAnchor).handle).toBe(b.handle);
    expect(await store.restore(xr, "other")).toBeNull();
  });

  it("has() says whether an alignment is saved, without a session", async () => {
    const { session, store, xr } = setup();
    expect(store.has("site")).toBe(false);
    await store.save(xr, "site", asAnchor(session.anchor()), asAnchor(session.anchor()));
    expect(store.has("site")).toBe(true);
    await store.forget(null, "site");
    expect(store.has("site")).toBe(false);
  });

  it("saving again replaces the record and deletes the old handles", async () => {
    const { storage, session, store, xr } = setup();
    const a1 = session.anchor();
    const b1 = session.anchor();
    await store.save(xr, "site", asAnchor(a1), asAnchor(b1));
    const a2 = session.anchor();
    const b2 = session.anchor();
    expect(await store.save(xr, "site", asAnchor(a2), asAnchor(b2))).toBe(true);

    expect(session.deletedHandles.sort()).toEqual([a1.handle, b1.handle].sort());
    expect(session.persistentAnchors.sort()).toEqual([a2.handle, b2.handle].sort());
    const record = JSON.parse(storage.getItem(KEY("site")) as string);
    expect(record).toMatchObject({ a: a2.handle, b: b2.handle });
  });

  it("does not delete a handle the device returns again for the same anchor", async () => {
    const { session, store, xr } = setup();
    const a = session.anchor();
    const b1 = session.anchor();
    await store.save(xr, "site", asAnchor(a), asAnchor(b1));
    const b2 = session.anchor();
    expect(await store.save(xr, "site", asAnchor(a), asAnchor(b2))).toBe(true);
    expect(session.deletedHandles).toEqual([b1.handle]);
    expect(session.persistentAnchors).toContain(a.handle);
  });

  it("a failure on the second handle deletes the first and keeps the old record", async () => {
    const { storage, session, store, xr } = setup();
    await store.save(xr, "site", asAnchor(session.anchor()), asAnchor(session.anchor()));
    const before = storage.getItem(KEY("site"));

    const a = session.anchor();
    const b = session.anchor();
    b.failHandle = true;
    expect(await store.save(xr, "site", asAnchor(a), asAnchor(b))).toBe("handle refused");
    expect(session.deletedHandles).toEqual([a.handle]);
    expect(session.persistentAnchors).not.toContain(a.handle);
    expect(storage.getItem(KEY("site"))).toBe(before);
  });

  it("a failed write deletes the handles created for it", async () => {
    const { storage, session, xr } = setup();
    storage.setItem = () => {
      throw new DOMException("quota", "QuotaExceededError");
    };
    const store = createAlignmentStore(storage);
    const a = session.anchor();
    const b = session.anchor();
    expect(await store.save(xr, "site", asAnchor(a), asAnchor(b))).toBe("storage full");
    expect(session.deletedHandles.sort()).toEqual([a.handle, b.handle].sort());
    expect(session.persistentAnchors).toEqual([]);
  });

  it("restore returns null when the session does not list the handles", async () => {
    const { session, store, xr } = setup();
    const a = session.anchor();
    const b = session.anchor();
    await store.save(xr, "site", asAnchor(a), asAnchor(b));
    session.persistent.delete(b.handle as string);
    let restoreCalls = 0;
    const original = session.restorePersistentAnchor.bind(session);
    session.restorePersistentAnchor = async (id: string) => {
      restoreCalls++;
      return original(id);
    };
    expect(await store.restore(xr, "site")).toBeNull();
    expect(restoreCalls).toBe(0);
  });

  it("restore returns null and deletes the other anchor when one fails", async () => {
    const { session, store, xr } = setup();
    const a = session.anchor();
    const b = session.anchor();
    await store.save(xr, "site", asAnchor(a), asAnchor(b));
    session.failRestore.add(b.handle as string);
    const restored: FakeAnchor[] = [];
    const original = session.restorePersistentAnchor.bind(session);
    session.restorePersistentAnchor = async (id: string) => {
      const anchor = await original(id);
      restored.push(anchor);
      return anchor;
    };
    expect(await store.restore(xr, "site")).toBeNull();
    expect(restored).toHaveLength(1);
    expect(restored[0].deleted).toBe(true);
  });

  it("removes a malformed record", async () => {
    const { storage, store, xr } = setup();
    for (const bad of ["{not json", '{"v":2,"a":"x","b":"y","savedAt":"t"}', '{"v":1,"a":"x"}']) {
      storage.setItem(KEY("site"), bad);
      expect(await store.restore(xr, "site")).toBeNull();
      expect(storage.getItem(KEY("site"))).toBeNull();
    }
  });

  it("forget deletes the device handles and the record", async () => {
    const { storage, session, store, xr } = setup();
    const a = session.anchor();
    const b = session.anchor();
    await store.save(xr, "site", asAnchor(a), asAnchor(b));
    await store.forget(xr, "site");
    expect(session.deletedHandles.sort()).toEqual([a.handle, b.handle].sort());
    expect(session.persistentAnchors).toEqual([]);
    expect(storage.getItem(KEY("site"))).toBeNull();
  });

  it("forget without a session only removes the record", async () => {
    const { storage, session, store, xr } = setup();
    await store.save(xr, "site", asAnchor(session.anchor()), asAnchor(session.anchor()));
    await store.forget(null, "site");
    expect(session.deletedHandles).toEqual([]);
    expect(storage.getItem(KEY("site"))).toBeNull();
  });

  it("reports unsupported sessions and never throws on them", async () => {
    const store = createAlignmentStore(new MemoryStorage());
    const bare = asSession({});
    expect(store.supported(bare)).toBe(false);
    expect(store.supported(asSession({ restorePersistentAnchor() {} }))).toBe(false);
    expect(store.supported(asSession(null))).toBe(false);
    const session = new FakeSession();
    expect(
      await store.save(bare, "site", asAnchor(session.anchor()), asAnchor(session.anchor())),
    ).toBe("no anchors");
    expect(await store.restore(bare, "site")).toBeNull();
    await expect(store.forget(bare, "site")).resolves.toBeUndefined();
  });

  it("without storage, save is false and restore null, and no handle leaks", async () => {
    const session = new FakeSession();
    const xr = asSession(session);
    const store = createAlignmentStore(null);
    expect(
      await store.save(xr, "site", asAnchor(session.anchor()), asAnchor(session.anchor())),
    ).toBe("no storage");
    expect(session.persistentAnchors).toEqual([]);
    expect(await store.restore(xr, "site")).toBeNull();
    await expect(store.forget(xr, "site")).resolves.toBeUndefined();
  });

  it("survives storage that throws on every access", async () => {
    const throwing = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
      removeItem() {
        throw new Error("denied");
      },
    } as unknown as Storage;
    const session = new FakeSession();
    const xr = asSession(session);
    const store = createAlignmentStore(throwing);
    expect(
      await store.save(xr, "site", asAnchor(session.anchor()), asAnchor(session.anchor())),
    ).toBe("storage full");
    expect(session.persistentAnchors).toEqual([]);
    expect(await store.restore(xr, "site")).toBeNull();
    await expect(store.forget(xr, "site")).resolves.toBeUndefined();
  });
});
