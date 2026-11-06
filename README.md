# LLHIL_WebXR

WebXR for three.js scenes: VR at 1:1 with teleport and viewpoints, and AR placement. MIT licensed.

```bash
pnpm add @gramaziokohler/llhil-webxr three
```

Example viewer: run `pnpm dev` and open the printed HTTPS address on the headset.

## VR menu

There is no HTML overlay inside an immersive session, so in VR the kit draws its own small menu.
The user opens it with B or Y, or the host opens it. It has the viewpoints, Walk / Fly,
Diagnostics, the host's items and Exit VR.

- `kit.openMenu()`, `kit.closeMenu()`, `kit.menuOpen`; the `menu` event `{ open }`.
- `kit.setMenuItems(items)` with `MenuItem = { id, label, kind?: "action" | "toggle" | "section", value?, icon? }`;
  the `menu-select` event `{ id, value? }`.
- `ui: { theme, icons, menu: { builtins, hostItemsFirst, title } }` in the kit options and
  `kit.setTheme(patch)` let the menu and the headset panels match the host's own UI. The default
  is a plain, neutral look (`DEFAULT_THEME`).
