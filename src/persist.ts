// Alignments saved on the device as WebXR persistent anchors (Quest Browser). The anchors live on
// the device; only their handles (UUIDs) are kept in storage, under the alignment id.
import type { AlignmentStore } from "./internal";
import { ANCHOR_TIMEOUT_MS, withTimeout } from "./timeout";

const KEY_PREFIX = "llhil-webxr:alignment:";

interface SavedRecord {
  v: 1;
  a: string;
  b: string;
  savedAt: string;
  /** The model points the two anchors stand for (six numbers: A, then B), where the saver gave them. */
  p?: number[];
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
    has(id) {
      return read(id) !== null;
    },
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

    async sweep(session) {
      // Handles this site holds on the device that no saved alignment names: left by saves that
      // failed half way. A device keeps only a few per site (eight on a Quest), and refuses
      // every new one once they are used up.
      try {
        if (!storage || !store.supported(session)) return 0;
        // A storage that cannot be listed cannot say which handles are in use: nothing is swept.
        if (typeof storage.length !== "number" || typeof storage.key !== "function") return 0;
        const list = listed(session);
        if (!list || list.length === 0) return 0;
        const ours = new Set<string>();
        for (let i = 0; i < storage.length; i++) {
          const k = storage.key(i);
          if (!k?.startsWith(KEY_PREFIX)) continue;
          const record = parse(storage.getItem(k) ?? "");
          if (record) ours.add(record.a).add(record.b);
        }
        let swept = 0;
        for (const uuid of list) {
          if (ours.has(uuid)) continue;
          if (await deleteHandle(session, uuid)) swept++;
        }
        return swept;
      } catch {
        return 0;
      }
    },

    async save(session, id, a, b, points) {
      if (!storage) return "no storage";
      if (!store.supported(session)) return "no anchors";
      await store.sweep(session);
      const previous = read(id);
      // Handles the device already knew are not ours to delete on failure: a browser may hand back
      // the existing handle when an anchor is persisted twice.
      const known = new Set<string>(listed(session) ?? []);
      if (previous) known.add(previous.a).add(previous.b);
      const created: string[] = [];
      const cleanUp = async () => {
        for (const uuid of created) await deleteHandle(session, uuid);
      };
      try {
        const uuidA = await requestHandle(a);
        if (!known.has(uuidA)) created.push(uuidA);
        const uuidB = await requestHandle(b);
        if (!known.has(uuidB)) created.push(uuidB);
        // Write before deleting the old handles, so a failed write leaves the old alignment whole.
        const ok = write(id, {
          v: 1,
          a: uuidA,
          b: uuidB,
          savedAt: new Date().toISOString(),
          ...(points ? { p: points } : {}),
        });
        if (!ok) {
          await cleanUp();
          return "storage full";
        }
        if (previous) {
          for (const old of [previous.a, previous.b]) {
            if (old !== uuidA && old !== uuidB) await deleteHandle(session, old);
          }
        }
        return true;
      } catch (error) {
        await cleanUp();
        // What the headset said, after the colon: the only way to learn it without a console.
        // And how many handles the site holds, and what a delete was told: all of them used up
        // reads the same as any refusal.
        const held = listed(session)?.length ?? "?";
        const del = deleteNote ? `; delete: ${deleteNote}` : "";
        return `handle refused: ${said(error)} (${held} held${del})`.slice(0, 320);
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
          withTimeout(restore.call(session, record.a), ANCHOR_TIMEOUT_MS, "anchor restore"),
          withTimeout(restore.call(session, record.b), ANCHOR_TIMEOUT_MS, "anchor restore"),
        ]);
        if (ra.status === "fulfilled" && rb.status === "fulfilled") {
          return { a: ra.value, b: rb.value, ...(record.p ? { points: record.p } : {}) };
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
    const p = r.p;
    const points =
      Array.isArray(p) &&
      p.length === 6 &&
      p.every((n) => typeof n === "number" && Number.isFinite(n))
        ? (p as number[])
        : undefined;
    return { v: 1, a: r.a, b: r.b, savedAt: r.savedAt, ...(points ? { p: points } : {}) };
  } catch {
    return null;
  }
}

/** Tries and the pause between them: a headset refuses a handle for an anchor it has not located yet. */
const HANDLE_TRIES = 4;
const HANDLE_RETRY_MS = 500;

async function requestHandle(anchor: XRAnchor): Promise<string> {
  if (typeof anchor?.requestPersistentHandle !== "function") {
    throw new Error("persistent handles unsupported");
  }
  let last: unknown;
  for (let i = 0; i < HANDLE_TRIES; i++) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, HANDLE_RETRY_MS));
    try {
      const uuid = await withTimeout(
        anchor.requestPersistentHandle(),
        ANCHOR_TIMEOUT_MS,
        "persistent handle",
      );
      if (typeof uuid === "string" && uuid !== "") return uuid;
      last = new Error("invalid persistent handle");
    } catch (error) {
      last = error;
    }
  }
  console.warn("[llhil-webxr] no persistent handle for the anchor", last);
  throw last;
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

/** What the device said to the last delete that failed, for a host with no console to show. */
let deleteNote = "";

/**
 * Deletes a persistent handle. A headset can refuse one it has not loaded in this session (seen on
 * a Quest 3: nine handles held, none deleted), so a refusal is followed by a restore and a second
 * try; the restored anchor is dropped again either way.
 */
async function deleteHandle(session: XRSession, uuid: string): Promise<boolean> {
  try {
    await withTimeout(
      Promise.resolve(session.deletePersistentAnchor?.(uuid)),
      ANCHOR_TIMEOUT_MS,
      "anchor delete",
    );
    if (!listed(session)?.includes(uuid)) return true;
  } catch (error) {
    deleteNote = said(error);
  }
  let anchor: XRAnchor | null = null;
  try {
    const restore = session.restorePersistentAnchor as (uuid: string) => Promise<XRAnchor>;
    anchor = await withTimeout(restore.call(session, uuid), ANCHOR_TIMEOUT_MS, "anchor restore");
    await withTimeout(
      Promise.resolve(session.deletePersistentAnchor?.(uuid)),
      ANCHOR_TIMEOUT_MS,
      "anchor delete",
    );
    return !listed(session)?.includes(uuid);
  } catch (error) {
    deleteNote = said(error);
    return false;
  } finally {
    if (anchor) deleteAnchor(anchor);
  }
}

const said = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

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
