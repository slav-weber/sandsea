# Sandsea

An infinite desert rendered in real time in the browser: no meshes, no textures, no engine —
the world is an SDF evaluated per pixel in a WebGL2 fragment shader.

**Live demo:** https://slav-weber.github.io/sandsea/

## What it does

- **Sphere-traced terrain.** Dune fields are a procedural height function raymarched in the
  shader, so the horizon is not a mesh boundary — it is the trace distance.
- **A sky that belongs to the ground.** Banded gradient, stars at night, sun position from a
  time-of-day model, shadows and haze derived from the same sun vector the terrain uses.
- **Weather that changes what you see.** Cloud cover, wind, fog, heat haze, rain and lightning
  run as a small simulation; every value is also exposed as a slider.
- **3D rain.** Particles are simulated on the CPU against the terrain, caves and solids, then
  packed into a buffer and drawn as motion-blurred streaks.
- **Caves.** A branching hollow carved by a seed, folded into the same SDF, with the camera
  easing down onto the cave floor at a mouth.
- **Palettes and presets.** Five sand and five sky palettes, scene presets, and every setting
  persisted to `localStorage` and the URL — a link reproduces the exact scene.

## Run it

```bash
yarn install
yarn dev      # dev server
yarn build    # production build into dist/
yarn preview  # serve the build
```

Node 22+ (see `.nvmrc`). Yarn 4, no global installs.

## How it is built

`src/render/glPipeline.js` is the renderer: it compiles the fragment shader, keeps palette LUT
textures, and draws one full-screen triangle per frame. Everything else feeds it uniforms —
`terrain/` is the CPU mirror of the shader's height function, `weather/` is the simulation,
`state/` is a tiny store with URL and `localStorage` persistence, `ui/` is the control panel.

The shader is the interesting part: a sphere tracer with an analytic height field, soft
shadows, cloud shadowing, a cave SDF unioned into the scene, and a palette quantisation pass
that gives the image its banded look.

Designed, specified and accepted by Slava Weber; the implementation was typed by coding agents
(Claude Code) working from that specification, and accepted against live runs in the browser.

## Licence

PolyForm Noncommercial 1.0.0 — see [LICENSE](LICENSE). Free for noncommercial use; for a
commercial licence, ask.
