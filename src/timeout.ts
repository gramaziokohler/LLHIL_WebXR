/**
 * Rejects when `promise` has not settled within `ms`. WebXR anchor calls never settle when the
 * session lacks the `anchors` feature (seen in the Quest emulator), so every anchor promise the
 * kit waits on goes through this.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, what = "operation"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`[llhil-webxr] ${what} timed out`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** How long the kit waits for an anchor to be created or restored. */
export const ANCHOR_TIMEOUT_MS = 8000;
