import { describe, expect, it, vi } from "vitest";
import { Emitter } from "../../src/events";

interface E {
  a: { n: number };
  b: { s: string };
}

describe("Emitter", () => {
  it("delivers payloads in subscription order and unsubscribes", () => {
    const e = new Emitter<E>();
    const calls: string[] = [];
    const off1 = e.on("a", (p) => calls.push(`1:${p.n}`));
    e.on("a", (p) => calls.push(`2:${p.n}`));
    e.emit("a", { n: 1 });
    off1();
    e.emit("a", { n: 2 });
    expect(calls).toEqual(["1:1", "2:1", "2:2"]);
  });

  it("keeps calling other listeners when one throws", () => {
    const e = new Emitter<E>();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: string[] = [];
    e.on("b", () => {
      throw new Error("boom");
    });
    e.on("b", (p) => seen.push(p.s));
    e.emit("b", { s: "ok" });
    expect(seen).toEqual(["ok"]);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it("ignores events without listeners and clears", () => {
    const e = new Emitter<E>();
    const fn = vi.fn();
    e.emit("a", { n: 0 });
    e.on("a", fn);
    e.clear();
    e.emit("a", { n: 1 });
    expect(fn).not.toHaveBeenCalled();
  });
});
