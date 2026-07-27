# Iron Meridian

Iron Meridian is a browser-based combined-arms FPS built with React, Three.js,
WebGL 2, and Vinext. It ships a complete Conquest match with infantry classes,
AI squads, three capture sectors, reinforcement tickets, a drivable armed
6×6 combat vehicle, layered procedural combat audio, and desktop/touch
controls.

Play the current production build:
[iron-meridian-fps.kygeodude.chatgpt.site](https://iron-meridian-fps.kygeodude.chatgpt.site)

## Visual stack

The battlefield is assembled entirely at runtime. There are no downloaded
models, image textures, HDRIs, or audio files.

- procedural albedo, normal, bump, and roughness maps for sand, concrete,
  plaster, brick, asphalt, metal, wood, and fabric
- a dense desert-city combat corridor with buildings, markets, warehouses,
  fuel infrastructure, fortifications, debris, cables, mountains, and haze
- physically based materials, environment reflections, soft shadows, bloom,
  film grain, chromatic edge separation, and cinematic color grading
- a separately rendered first-person view model with detailed receivers,
  controls, rails, magazines, stocks, barrels, segmented gloved hands, recoil,
  staged reload animation, muzzle flash, casings, tracers, and surface-aware
  impacts
- open holographic, combat LPVO, and marksman optics with a functional
  screen-space sight picture, etched reticles, distinct zoom levels, and no
  opaque lens artifacts
- the original Marauder 6×6: sloped mine-resistant armor, sprung body motion,
  six animated wheels, steering, dust, remote weapon station, vehicle
  telemetry, and a layered diesel sound
- a bus-based Web Audio mix with layered weapon transients and tails,
  mechanical handling sounds, material-specific impacts, distance reports,
  battlefield ambience, reverb, and limiting
- optimized static-geometry batching to reduce the environment from more than
  1,300 individual meshes to fewer than 200 scene meshes

The procedural-art and visual-validation approach was inspired by
[mshumer/Claude-of-Duty](https://github.com/mshumer/Claude-of-Duty). Iron
Meridian is an original game and codebase rather than a fork.

The exact component review behind the current combat pass is documented in
[docs/reference-audit.md](docs/reference-audit.md).

## Controls

| Input | Action |
| --- | --- |
| `WASD` | Move |
| Mouse | Aim |
| Left mouse | Fire |
| Right mouse | Aim down sights |
| `Shift` | Sprint |
| `Ctrl` or `C` | Crouch |
| `Space` | Jump |
| `R` | Reload |
| `G` | Throw grenade |
| `Q` | Use class gadget |
| `E` | Enter or exit vehicle |
| `Esc` | Release pointer / pause |

Touch controls appear automatically on coarse-pointer devices.

## Run locally

Requirements:

- Node.js `>=22.13.0`
- a current hardware-accelerated browser with WebGL 2

```bash
npm install
npm run dev
```

Open the local URL printed by Vite, select a class, and deploy.

## Validate

```bash
npm run lint
npm run build
npm test
```

`npm run build` also validates the deployable Cloudflare Worker artifact. The
Three.js engine is imported only in the browser so server-side rendering never
evaluates WebGL globals in the Worker runtime.

## Project map

| Path | Responsibility |
| --- | --- |
| `app/game/engine.ts` | renderer, match loop, movement, weapons, bots, vehicle, combat FX |
| `app/game/world.ts` | procedural level construction, props, batching, objectives |
| `app/game/materials.ts` | deterministic surface forge and PBR material library |
| `app/game/audio.ts` | layered weapon, foley, impact, explosion, vehicle, ambience, and UI audio |
| `app/game/GameClient.tsx` | deployment screen, HUD, minimap, and touch UI |
| `app/globals.css` | responsive military interface and screen-space treatment |
| `docs/reference-audit.md` | subsystem-by-subsystem reference evaluation and adoption decisions |

## License

Copyright © 2026. All rights reserved unless a repository license is added by
the owner.
