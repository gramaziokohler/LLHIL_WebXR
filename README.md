# LLHIL_WebXR

WebXR for three.js scenes: VR at 1:1 with teleport and viewpoints, and AR placement. MIT licensed.

```bash
pnpm add @gramaziokohler/llhil-webxr three
```

Example viewer: run `pnpm dev` and open the printed HTTPS address on the headset.

## VR controls

Both controllers are identical, so everything works with one hand:

- **Thumbstick:** walk where the head looks (forward, back, sideways), kept on the floors and stopped by walls.
- **Grip held + thumbstick left/right:** turn (snap by default, smooth as an option).
- **Trigger:** aim the teleport arc; release to go there. Hands: pinch.
- **B / Y:** emits `menu-button` (`{ hand }`) for the host's menu.

Options: `vr.locomotion: { mode: "walk" | "fly" | "teleport", speed, turn: "snap" | "smooth", snapDegrees, smoothDegreesPerSecond, vignette }`; change them live with `kit.setLocomotion(patch)`, read them from `kit.locomotion`, and listen for `locomotion` (`{ mode }`). In the example viewer, `?loco=fly` or `?loco=teleport` picks the mode.
