# Claude-of-Duty reference audit

This review covers
[`mshumer/Claude-of-Duty`](https://github.com/mshumer/Claude-of-Duty) at commit
[`d9b237b`](https://github.com/mshumer/Claude-of-Duty/commit/d9b237b75c9304ab8d9ef4cfa0c3568c7c11a853).
The reference was built and its physics, audio, and AI self-tests were run
before the Iron Meridian combat-systems pass.

The important conclusion is that the reference's aesthetic is not a texture
pack or a post-processing preset. It is the combined result of measured
geometry, layered materials, camera response, physical effects, sound
transients, animation, and a disciplined HUD all reacting to the same events.

## Component evaluation

| System | What the reference implements | Evaluation and Iron Meridian decision |
| --- | --- | --- |
| Core/runtime | Dependency-ordered subsystems, a shared event contract, seeded RNG, fixed updates, prewarming, quality budgets, and explicit disposal. | Excellent architecture for parallel construction and deterministic capture. Iron Meridian retains its smaller integrated engine, but follows the same deterministic procedural generation and bounded-quality principles. A future split should begin with events and lifecycle boundaries, not arbitrary file extraction. |
| Renderer | A custom HDR chain with cascaded shadows, depth/normal/velocity prepass, GTAO, contact shadows, SSR, TAA, motion blur, ADS depth of field, bloom, exposure, AgX-style tonemapping, and LUT grading. | The largest contributor to image cohesion, but also the reference's largest performance cost. Iron Meridian keeps a lighter composer, soft shadows, bloom, environment lighting, haze, and cinematic grading. Porting the complete chain would be inappropriate until GPU timing and quality tiers exist. |
| Materials | Nineteen generated PBR material families, albedo/normal/roughness variation, masks, edge wear, grime, and shared surface vocabulary. | Strong and directly relevant. Iron Meridian already has deterministic surface generation and expands that language onto the weapon and vehicle. The next material milestone is localized wear masks and decals rather than simply adding more noise. |
| Sky/atmosphere | Physical atmosphere, celestial lighting, clouds, stars, environment-map generation, volumetrics, and light shafts. | Visually strong but expensive. Iron Meridian uses a authored procedural dusk environment, fog, sun response, mountains, and haze. Full volumetrics remain deferred because combat readability and frame stability take priority. |
| World | A roughly 120-m modular market with buildings, interiors, props, dressing, instancing, collision geometry, and repeated-kit variation. | This is the reference's main environmental strength. Iron Meridian's larger Conquest corridor already contains dense market, industrial, residential, fortification, cable, debris, and terrain layers with static batching. More bespoke interiors and silhouette landmarks would add more value than raw prop count. |
| Physics | Deterministic 120 Hz simulation, BVH acceleration, swept capsule character collision, rigid bodies, ragdolls, material tagging, raycasts, and bullet penetration. | Technically excellent. The reference self-test passed all 55 checks and reported sub-microsecond BVH rays on the audit machine. Iron Meridian currently uses bounded collision boxes and hitscan combat. Swept movement and penetration are high-value future work; importing a full rigid-body stack is not justified for the present match scale. |
| Player feel | Sprint, crouch, prone, slide, mantle, lean, health effects, landing response, and spring-based camera movement. | The reference demonstrates that camera and body response matter as much as speed values. Iron Meridian has sprint, crouch, jump, ADS slowdown, bob, recoil, damage feedback, and vehicle transition. Slide/mantle/lean should only be added with animation, collision, audio, and bot-aware navigation support. |
| Weapons/viewmodel | Physically dimensioned rifles, SMG, and pistol; detailed parts; hands; independent view scene; open-ended optics; collimated reticle; spring recoil; sway; bob; reload/inspect clips; and ballistics. | This was the largest visible gap. Iron Meridian now uses detailed receiver, controls, rail, gas system, muzzle, magazine, stock, hand, and optic assemblies. Each class has an open holographic, combat LPVO, or marksman scope. ADS now aligns the viewmodel and supplies an etched, zoom-specific sight picture. |
| Combat FX | GPU particles, muzzle flash, shell ejection, tracers, impacts, decals, smoke, blood, explosions, and atmospheric effects. | Strong event coverage and good action-to-feedback discipline. Iron Meridian now layers viewmodel/RWS muzzle flashes, casings, tracers, irregular surface-colored fracture decals, material-specific debris, dust, blood, and explosions. GPU particle migration is a future optimization, not a visual prerequisite. |
| AI | Skinned soldier rig, procedural clips, navigation grid, perception, cover scoring, squads, flanking, suppression, aiming/grounding IK, combat firing, and ragdoll integration. | The reference has much deeper tactics and animation. Iron Meridian's bots support teams, objectives, engagement, hit reactions, respawn, and locomotion whose visible forward axis is now regression-tested against accepted movement. Cover selection, suppression, and squad roles are the clearest remaining gameplay gap. |
| UI/HUD | Modular DOM HUD for crosshair, ammo, health, compass, markers, hit feedback, killfeed, minimap, damage direction, prompts, and menus. | Strong hierarchy, restrained color, and consistent event feedback. Iron Meridian already covers those match-critical modules and now adds a functional scope layer plus a distinct stabilized RWS vehicle display with speed, heading, and caliber readouts. |
| Audio | Dedicated weapon, foley, ambience, voice, and UI paths; weapon layers; HRTF spatialization; occlusion; convolution impulse responses selected by space; ambience; and mix protection. | A major contributor to perceived authenticity. Iron Meridian now separates weapon, foley, ambience, and UI buses; layers crack/body/sub/mechanics/reflections; adds weapon actions, material impacts, distance-delayed reports, explosions, footsteps, reverb, limiting, battlefield beds, and a load-responsive diesel engine. Geometry-aware occlusion remains future work. |
| Developer tooling | Deterministic capture, subsystem previews, probes, visual comparisons, pixel-diff tooling, boot frames, self-tests, and performance budgets. | This is one of the reference's best ideas. Iron Meridian now has build/worker validation plus static regression tests for locomotion and combat systems. The next tooling investment should be a checked-in deterministic gameplay capture that runs on CI with a pinned browser. |

## What was adopted in build 1.4

- Rebuilt procedural weapon assemblies with recognizable functional parts and
  class-specific proportions.
- Added open-ended optics and replaced transmissive first-person glass, which
  was the source of the black disc moving with the reticle.
- Added a functional ADS presentation with combat and marksman magnification,
  etched reticle markings, optic housing, smooth alignment, and crosshair
  suppression.
- Replaced circular bullet marks with irregular, surface-aware fracture decals.
- Rebuilt the vehicle as the original Marauder 6×6 MRAP-style platform with
  sloped armor, V hull, six detailed wheels, suspension response, steering,
  dust, stowage, lighting, and an animated remote weapon station.
- Rebuilt the sound system around layered weapon profiles, foley, ambience,
  reverb, distance reports, material impacts, vehicle engine load, and a
  protective master limiter.

## What was deliberately not copied

- Source code, names, art, layout, or authored design from the reference.
- Its complete high-cost render chain before Iron Meridian has GPU timing and
  scalable quality tiers.
- Its documented shortcomings: overly bright viewmodel lighting, block-like
  hands, distant mannequin appearance, procedural-material repetition, and
  unstable high-resolution performance.
- A vehicle design from the reference, because the reference has no vehicle
  subsystem. The Marauder is an original Iron Meridian system.

## Verification result

- Reference production build: passed.
- Reference physics self-test: 55/55 passed.
- Reference audio self-test: passed.
- Reference AI self-test: passed.
- Iron Meridian production build and regression suite: run as part of
  `npm test`.
