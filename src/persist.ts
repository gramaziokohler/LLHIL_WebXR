// K3 replaces this stub: alignments saved on the device as WebXR persistent anchors.
import type { AlignmentStore } from "./internal";

export function createAlignmentStore(
  _storage: Storage | null = safeLocalStorage(),
): AlignmentStore {
  return {
    supported: () => false,
    save: async () => false,
    restore: async () => null,
    forget: async () => {},
  };
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
