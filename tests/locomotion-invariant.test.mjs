import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const engineSource = await readFile(
  new URL("../app/game/engine.ts", import.meta.url),
  "utf8",
);

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function forwardStep(currentYaw, desiredYaw, dt) {
  const turnDelta = Math.atan2(
    Math.sin(desiredYaw - currentYaw),
    Math.cos(desiredYaw - currentYaw),
  );
  const yaw = currentYaw + clamp(turnDelta, -8.5 * dt, 8.5 * dt);
  return {
    yaw,
    x: Math.sin(yaw),
    z: Math.cos(yaw),
  };
}

test("NPC navigation translates along the same +Z axis the rig faces", () => {
  for (let current = -Math.PI; current <= Math.PI; current += Math.PI / 8) {
    for (let desired = -Math.PI; desired <= Math.PI; desired += Math.PI / 8) {
      const step = forwardStep(current, desired, 1 / 60);
      const visibleForward = {
        x: Math.sin(step.yaw),
        z: Math.cos(step.yaw),
      };
      const dot = step.x * visibleForward.x + step.z * visibleForward.z;
      assert.ok(dot > 0.999999, `forward invariant failed at ${current}, ${desired}`);
    }
  }
});

test("collision-slide yaw is rebuilt from accepted displacement", () => {
  for (const displacement of [
    { x: 1, z: 0 },
    { x: -1, z: 0 },
    { x: 0, z: 1 },
    { x: 0, z: -1 },
    { x: 0.4, z: 0.8 },
  ]) {
    const movementYaw = Math.atan2(displacement.x, displacement.z);
    const magnitude = Math.hypot(displacement.x, displacement.z);
    const dot =
      (displacement.x / magnitude) * Math.sin(movementYaw) +
      (displacement.z / magnitude) * Math.cos(movementYaw);
    assert.ok(dot > 0.999999);
  }
});

test("engine keeps movement, facing, and stride coupled to accepted motion", () => {
  assert.match(engineSource, /const forwardX = Math\.sin\(bot\.group\.rotation\.y\)/);
  assert.match(engineSource, /const forwardZ = Math\.cos\(bot\.group\.rotation\.y\)/);
  assert.match(engineSource, /bot\.group\.rotation\.y = movementYaw/);
  assert.match(
    engineSource,
    /bot\.stride \+= \(actualDistance \/ 1\.42\) \* Math\.PI \* 2/,
  );
  assert.doesNotMatch(engineSource, /bot\.stride \+= dt \* speed/);
});
