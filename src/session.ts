// T1 replaces this stub: session lifecycle (see plans, task T1).
import type { KitContext, SessionController, SessionHooks } from "./internal";
import type { XRMode, XRSupport } from "./types";

export function createSessionController(_ctx: KitContext, _hooks: SessionHooks): SessionController {
  return {
    async supports(): Promise<XRSupport> {
      return { vr: false, ar: false };
    },
    async enter(_mode: XRMode): Promise<void> {
      throw new Error("[llhil-webxr] session: not implemented yet");
    },
    async exit(): Promise<void> {},
    dispose(): void {},
  };
}
