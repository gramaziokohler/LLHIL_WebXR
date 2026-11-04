// Alignments saved on the device as WebXR persistent anchors (Quest Browser). The anchors live on
// the device; only their handles (UUIDs) are kept in storage, under the alignment id.
import type { AlignmentStore } from "./internal";

const KEY_PREFIX = "llhil-webxr:alignment:";

interface SavedRecord {
  v: 1;
  a: string;
  b: string;
  savedAt: string;
}

export function createAlignmentStore(storage: Storage | null = safeLocalStorage()): AlignmentStore {
  const key = (id: string) => KEY_PREFIX + id;

  // Reads the record of `id`; a malformed one is removed so it cannot fail every restore.
  function read(id: string): SavedRecord | null {
    if (!storage) return null;
    let raw: string | null;
    try {
      raw = storage.getItem(key(id));
    } catch {
      return null;
    }
    if (raw === null) return null;
    const record = parse(raw);
    if (!record) remove(id);
    return record;
  }

  function write(id: string, record: SavedRecord): boolean {
    if (!storage) return false;
    try {
      storage.setItem(key(id), JSON.stringify(record));
      return true;
    } catch {
      return false;
    }
  }

  function remove(id: string): void {
    try {
      storage?.removeItem(key(id));
    } catch {
      // Storage unavailable: nothing to remove.
    }
  }

  const store: AlignmentStore = {
    supported(session) {
      try {
        return (
          typeof session?.restorePersistentAnchor === "function" &&
          typeof session?.deletePersistentAnchor === "function"
        );
      } catch {
        return false;
      }
    },

    async save(session, id, a, b) {
      if (!storage || !store.supported(session)) return false;
      const previous = read(id);
      // Handles the device already knew are not ours to delete on failure: a browser may hand back
      // the existing handle when an anchor is persisted twice.
      const known = new Set<string>(listed(session) ?? []);
      if (previous) known.add(previous.a).add(previous.b);
      const created: string[] = [];
      const cleanUp = async () => {
        for (const uuid of created) await deleteHandle(session, uuid);
        return false;
      };
      try {
        const uuidA = await requestHandle(a);
        if (!known.has(uuidA)) created.push(uuidA);
        const uuidB = await requestHandle(b);
        if (!known.has(uuidB)) created.push(uuidB);
        // Write before deleting the old handles, so a failed write leaves the old alignment whole.
        const ok = write(id, { v: 1, a: uuidA, b: uuidB, savedAt: new Date().toISOString() });
        if (!ok) return await cleanUp();
        if (previous) {
          for (const old of [previous.a, previous.b]) {
            if (old !== uuidA && old !== uuidB) await deleteHandle(session, old);
          }
        }
        return true;
      } catch {
        return await cleanUp();
      }
    },

    async restore(session, id) {
      try {
        if (!store.supported(session)) return null;
        const record = read(id);
        if (!record) return null;
        const list = listed(session);
        // Saved on another device or wiped from this one: the handles cannot be restored here.
        if (list && !(list.includes(record.a) && list.includes(record.b))) return null;
        const restore = session.restorePersistentAnchor as (uuid: string) => Promise<XRAnchor>;
        const [ra, rb] = await Promise.allSettled([
          restore.call(session, record.a),
          restore.call(session, record.b),
        ]);
        if (ra.status === "fulfilled" && rb.status === "fulfilled") {
          return { a: ra.value, b: rb.value };
        }
        // Drop the half that came back: a lone anchor is of no use and would keep being tracked.
        for (const r of [ra, rb]) {
          if (r.status === "fulfilled") deleteAnchor(r.value);
        }
        return null;
      } catch {
        return null;
      }
    },

    async forget(session, id) {
      try {
        const record = read(id);
        if (record && session && store.supported(session)) {
          await deleteHandle(session, record.a);
          if (record.b !== record.a) await deleteHandle(session, record.b);
        }
      } catch {
        // Best effort: the storage record goes regardless.
      }
      remove(id);
    },
  };
  return store;
}

function parse(raw: string): SavedRecord | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const r = value as Record<string, unknown>;
    if (r.v !== 1) return null;
    if (typeof r.a !== "string" || r.a === "" || typeof r.b !== "string" || r.b === "") return null;
    if (typeof r.savedAt !== "string") return null;
    return { v: 1, a: r.a, b: r.b, savedAt: r.savedAt };
  } catch {
    return null;
  }
}

async function requestHandle(anchor: XRAnchor): Promise<string> {
  if (typeof anchor?.requestPersistentHandle !== "function") {
    throw new Error("persistent handles unsupported");
  }
  const uuid = await anchor.requestPersistentHandle();
  if (typeof uuid !== "string" || uuid === "") throw new Error("invalid persistent handle");
  return uuid;
}

/** The handles the session knows, or null when it does not expose the list. */
function listed(session: XRSession): string[] | null {
  try {
    const list = session.persistentAnchors as Iterable<string> | undefined | null;
    if (list == null) return null;
    return Array.from(list);
  } catch {
    return null;
  }
}

async function deleteHandle(session: XRSession, uuid: string): Promise<void> {
  try {
    await session.deletePersistentAnchor?.(uuid);
  } catch {
    // Already gone, or the device refused: either way nothing more to do.
  }
}

function deleteAnchor(anchor: XRAnchor): void {
  try {
    anchor.delete();
  } catch {
    // Already deleted.
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
