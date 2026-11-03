import type { XRKit, XRMode } from "./types";

export interface XRButtonsOptions {
  labels?: { vr?: string; ar?: string; exit?: string };
}

export interface XRButtons {
  /** The block holding the buttons and the error line; class `llhil-webxr-buttons`. */
  element: HTMLElement;
  /** Resolves once `kit.supports()` answered and the supported buttons are shown. */
  ready: Promise<void>;
  /** Removes the block and unsubscribes from the kit. */
  dispose(): void;
}

const MODES: readonly XRMode[] = ["vr", "ar"];

/** A kit method that throws synchronously still lands in the error line. */
function attempt(fn: () => Promise<void>): Promise<void> {
  try {
    return fn();
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Adds an "Enter VR" and a "View in AR" button to `container`, each shown only where the
 * device supports it. While a session runs, its button reads "Exit". The block carries class
 * names (prefix `llhil-webxr-`) and no styles: hosts style it or build their own UI instead.
 */
export function createXRButtons(
  kit: XRKit,
  container: HTMLElement,
  options: XRButtonsOptions = {},
): XRButtons {
  const labels = {
    vr: options.labels?.vr ?? "Enter VR",
    ar: options.labels?.ar ?? "View in AR",
    exit: options.labels?.exit ?? "Exit",
  };

  const element = document.createElement("div");
  element.className = "llhil-webxr-buttons";

  const buttons = {} as Record<XRMode, HTMLButtonElement>;
  for (const mode of MODES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `llhil-webxr-button llhil-webxr-button-${mode}`;
    button.dataset.mode = mode;
    button.textContent = labels[mode];
    button.hidden = true;
    button.addEventListener("click", () => onClick(mode));
    buttons[mode] = button;
    element.appendChild(button);
  }

  const status = document.createElement("p");
  status.className = "llhil-webxr-error";
  status.setAttribute("role", "status");
  status.hidden = true;
  element.appendChild(status);

  container.appendChild(element);

  let presenting: XRMode | null = kit.presenting;
  let busy = false;
  let disposed = false;

  function showError(error: unknown): void {
    if (disposed) return;
    status.textContent = error instanceof Error ? error.message : String(error);
    status.hidden = false;
  }

  function clearError(): void {
    status.textContent = "";
    status.hidden = true;
  }

  function render(): void {
    for (const mode of MODES) {
      const button = buttons[mode];
      button.textContent = presenting === mode ? labels.exit : labels[mode];
      button.disabled = busy || (presenting !== null && presenting !== mode);
    }
  }

  function onClick(mode: XRMode): void {
    if (busy) return;
    clearError();
    if (presenting === mode) {
      attempt(() => kit.exit()).catch(showError);
      return;
    }
    busy = true;
    render();
    // Called inside the click handler: WebXR needs the user activation.
    attempt(() => (mode === "vr" ? kit.enter("vr") : kit.enter("ar")))
      .catch(showError)
      .finally(() => {
        busy = false;
        if (!disposed) render();
      });
  }

  const unsubscribe = [
    kit.on("sessionstart", ({ mode }) => {
      presenting = mode;
      render();
    }),
    kit.on("sessionend", () => {
      presenting = null;
      render();
    }),
  ];

  render();

  const ready = kit
    .supports()
    .catch(() => ({ vr: false, ar: false }))
    .then((support) => {
      if (disposed) return;
      for (const mode of MODES) buttons[mode].hidden = !support[mode];
    });

  return {
    element,
    ready,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const off of unsubscribe) off();
      element.remove();
    },
  };
}
