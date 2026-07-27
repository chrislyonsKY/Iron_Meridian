import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const engineSource = await readFile(
  new URL("../app/game/engine.ts", import.meta.url),
  "utf8",
);
const audioSource = await readFile(
  new URL("../app/game/audio.ts", import.meta.url),
  "utf8",
);
const hudSource = await readFile(
  new URL("../app/game/GameClient.tsx", import.meta.url),
  "utf8",
);
const stylesSource = await readFile(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);

const weaponSource = engineSource.slice(
  engineSource.indexOf("private createWeapon"),
  engineSource.indexOf("private rebuildWeapon"),
);

test("first-person optics stay transparent and open-ended", () => {
  assert.doesNotMatch(weaponSource, /MeshPhysicalMaterial/);
  assert.doesNotMatch(weaponSource, /\btransmission\s*:/);
  assert.match(weaponSource, /CylinderGeometry\([\s\S]*?true,/);
  assert.match(weaponSource, /depthWrite:\s*false/);
  assert.match(engineSource, /new THREE\.ShapeGeometry\(fracture\)/);
  assert.doesNotMatch(engineSource, /CircleGeometry\(0\.065/);
});

test("ADS has class-specific optics and a dedicated sight picture", () => {
  assert.match(engineSource, /this\.scopeMode = marksman \? "marksman"/);
  assert.match(engineSource, /const aimedFov =[\s\S]*?marksman[\s\S]*?38/);
  assert.match(hudSource, /id="scope-overlay"/);
  assert.match(hudSource, /className="scope-reticle"/);
  assert.match(stylesSource, /\.battle-hud\.is-ads \.crosshair/);
  assert.match(engineSource, /clearCombatOverlays\(\)/);
});

test("Marauder is a six-wheel sprung combat vehicle with RWS feedback", () => {
  assert.match(engineSource, /group\.name = "marauder-6x6"/);
  assert.match(engineSource, /for \(const z of \[-1\.92, 0\.02, 1\.92\]\)/);
  assert.match(engineSource, /steeringPivots/);
  assert.match(engineSource, /rws-muzzle/);
  assert.match(engineSource, /createVehicleMuzzleFlash/);
  assert.match(engineSource, /createVehicleDust/);
  assert.match(hudSource, /MARAUDER 6×6/);
  assert.doesNotMatch(`${engineSource}\n${hudSource}`, /KITE LRV/);
});

test("combat audio is layered, routed, and surface-aware", () => {
  assert.match(audioSource, /type WeaponSoundProfile/);
  assert.match(
    audioSource,
    /Record<"weapons" \| "foley" \| "ambience" \| "ui", GainNode>/,
  );
  assert.match(audioSource, /weapons:\s*0\.92/);
  assert.match(audioSource, /foley:\s*0\.72/);
  assert.match(audioSource, /ambience:\s*0\.52/);
  assert.match(audioSource, /createConvolver/);
  assert.match(audioSource, /createDynamicsCompressor/);
  assert.match(audioSource, /setVehicleEngine/);
  assert.match(audioSource, /updateBattlefield/);
  assert.match(engineSource, /this\.audio\.impact\(surface, impactPan\)/);
});
