// T1 replaces this stub: the optional Enter VR / View in AR buttons.
import type { XRKit } from "./types";

export interface XRButtonsOptions {
  labels?: { vr?: string; ar?: string; exit?: string };
}

export interface XRButtons {
  element: HTMLElement;
  dispose(): void;
}

export function createXRButtons(
  _kit: XRKit,
  container: HTMLElement,
  _options: XRButtonsOptions = {},
): XRButtons {
  const element = document.createElement("div");
  container.appendChild(element);
  return {
    element,
    dispose() {
      element.remove();
    },
  };
}
