// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createXRButtons } from "../../src/buttons";
import { Emitter } from "../../src/events";
import type { KitEvents, XRKit, XRMode, XRSupport } from "../../src/types";

function fakeKit(support: XRSupport | Promise<XRSupport>) {
  const events = new Emitter<KitEvents>();
  let presenting: XRMode | null = null;
  const kit = {
    supports: vi.fn(() => Promise.resolve(support)),
    enter: vi.fn(async (mode: XRMode) => {
      presenting = mode;
      events.emit("sessionstart", { mode });
    }),
    exit: vi.fn(async () => {
      const mode = presenting;
      presenting = null;
      if (mode) events.emit("sessionend", { mode });
    }),
    on: vi.fn(<K extends keyof KitEvents>(e: K, fn: (p: KitEvents[K]) => void) => events.on(e, fn)),
    get presenting() {
      return presenting;
    },
  };
  return { kit: kit as unknown as XRKit & typeof kit, events };
}

const button = (root: HTMLElement, mode: XRMode) =>
  root.querySelector<HTMLButtonElement>(`button[data-mode="${mode}"]`)!;
const errorLine = (root: HTMLElement) => root.querySelector<HTMLElement>(".llhil-webxr-error")!;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createXRButtons", () => {
  it("shows a button only for each supported mode", async () => {
    const { kit } = fakeKit({ vr: true, ar: false });
    const container = document.createElement("div");
    const buttons = createXRButtons(kit, container);
    expect(container.contains(buttons.element)).toBe(true);
    expect(buttons.element.className).toBe("llhil-webxr-buttons");
    expect(button(container, "vr").hidden).toBe(true);
    await buttons.ready;
    expect(button(container, "vr").hidden).toBe(false);
    expect(button(container, "vr").textContent).toBe("Enter VR");
    expect(button(container, "ar").hidden).toBe(true);
    expect(button(container, "ar").textContent).toBe("View in AR");
  });

  it("hides everything when supports() rejects", async () => {
    const { kit } = fakeKit({ vr: true, ar: true });
    kit.supports.mockImplementation(() => Promise.reject(new Error("no")));
    const container = document.createElement("div");
    await createXRButtons(kit, container).ready;
    expect(button(container, "vr").hidden).toBe(true);
    expect(button(container, "ar").hidden).toBe(true);
  });

  it("calls enter synchronously on click and switches to Exit while presenting", async () => {
    const { kit } = fakeKit({ vr: true, ar: true });
    const container = document.createElement("div");
    const buttons = createXRButtons(kit, container, { labels: { exit: "Leave" } });
    await buttons.ready;

    button(container, "ar").click();
    expect(kit.enter).toHaveBeenCalledWith("ar");
    expect(button(container, "ar").textContent).toBe("Leave");
    expect(button(container, "vr").disabled).toBe(true);

    await flush();
    button(container, "ar").click();
    expect(kit.exit).toHaveBeenCalledTimes(1);
    await flush();
    expect(button(container, "ar").textContent).toBe("View in AR");
    expect(button(container, "vr").disabled).toBe(false);
  });

  it("follows sessionstart and sessionend from elsewhere", async () => {
    const { kit, events } = fakeKit({ vr: true, ar: true });
    const container = document.createElement("div");
    await createXRButtons(kit, container, { labels: { vr: "VR" } }).ready;
    expect(button(container, "vr").textContent).toBe("VR");
    events.emit("sessionstart", { mode: "vr" });
    expect(button(container, "vr").textContent).toBe("Exit");
    events.emit("sessionend", { mode: "vr" });
    expect(button(container, "vr").textContent).toBe("VR");
  });

  it("shows the error of a refused enter instead of throwing", async () => {
    const { kit } = fakeKit({ vr: true, ar: true });
    kit.enter.mockImplementation(async () => {
      throw new Error("could not start a VR session");
    });
    const container = document.createElement("div");
    await createXRButtons(kit, container).ready;
    expect(errorLine(container).hidden).toBe(true);
    button(container, "vr").click();
    await flush();
    expect(errorLine(container).hidden).toBe(false);
    expect(errorLine(container).textContent).toBe("could not start a VR session");
    expect(button(container, "vr").disabled).toBe(false);
    expect(button(container, "vr").textContent).toBe("Enter VR");

    // The next attempt clears the line.
    kit.enter.mockImplementation(async () => {});
    button(container, "vr").click();
    expect(errorLine(container).hidden).toBe(true);
  });

  it("dispose removes the block and unsubscribes", async () => {
    const { kit, events } = fakeKit({ vr: true, ar: true });
    const container = document.createElement("div");
    const buttons = createXRButtons(kit, container);
    await buttons.ready;
    buttons.dispose();
    expect(container.children.length).toBe(0);
    events.emit("sessionstart", { mode: "vr" });
    expect(button(buttons.element, "vr").textContent).toBe("Enter VR");
  });

  it("ignores a supports() answer that arrives after dispose", async () => {
    let answer!: (s: XRSupport) => void;
    const { kit } = fakeKit(
      new Promise<XRSupport>((r) => {
        answer = r;
      }),
    );
    const container = document.createElement("div");
    const buttons = createXRButtons(kit, container);
    buttons.dispose();
    answer({ vr: true, ar: true });
    await buttons.ready;
    expect(button(buttons.element, "vr").hidden).toBe(true);
  });
});
