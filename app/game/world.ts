import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  createBattlefieldMaterials,
  tintBattlefieldMaterials,
  type BattlefieldMaterials,
} from "./materials";
import type { Collider, ObjectiveState } from "./types";

export interface BuiltWorld {
  colliders: Collider[];
  staticMeshes: THREE.Object3D[];
  objectives: ObjectiveState[];
  blueSpawn: THREE.Vector3;
  redSpawn: THREE.Vector3;
  vehicleSpawn: THREE.Vector3;
}

const MAP_SIZE = 260;
const WORLD_AXIS_SCALE = 0.78;
const WORLD_SIDE_SCALE = 0.86;
export const MAIN_ROAD_ROTATION = 2.18;
const MAIN_AXIS = new THREE.Vector2(
  Math.sin(MAIN_ROAD_ROTATION),
  Math.cos(MAIN_ROAD_ROTATION),
);
const MAIN_SIDE = new THREE.Vector2(MAIN_AXIS.y, -MAIN_AXIS.x);

interface BuildingOptions {
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  floors: number;
  rotation?: number;
  wall: THREE.Material;
  accent?: THREE.Material;
  sign?: string;
  awning?: number;
  damaged?: boolean;
  balcony?: boolean;
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function terrainHeight(x: number, z: number): number {
  const longWave =
    Math.sin(x * 0.021) * 0.6 +
    Math.cos(z * 0.018) * 0.45 +
    Math.sin((x + z) * 0.012) * 0.35;
  const edgeRise = Math.max(0, Math.hypot(x, z) - 128) * 0.027;
  return longWave * 0.42 + edgeRise;
}

function localToWorld(
  centerX: number,
  centerZ: number,
  rotation: number,
  localX: number,
  localZ: number,
): [number, number] {
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  return [
    centerX + localX * cosine + localZ * sine,
    centerZ - localX * sine + localZ * cosine,
  ];
}

function axisPoint(distance: number, sideOffset = 0): [number, number] {
  const axialDistance = distance * WORLD_AXIS_SCALE;
  const lateralDistance = sideOffset * WORLD_SIDE_SCALE;
  return [
    MAIN_AXIS.x * axialDistance + MAIN_SIDE.x * lateralDistance,
    MAIN_AXIS.y * axialDistance + MAIN_SIDE.y * lateralDistance,
  ];
}

function streetFacingRotation(sideOffset: number): number {
  return (
    MAIN_ROAD_ROTATION +
    (sideOffset > 0 ? -Math.PI / 2 : Math.PI / 2)
  );
}

function registerMesh(
  scene: THREE.Scene,
  colliders: Collider[],
  staticMeshes: THREE.Object3D[],
  mesh: THREE.Mesh,
  options: {
    collider?: boolean;
    surface?: Collider["surface"];
    shadows?: boolean;
  } = {},
): THREE.Mesh {
  const shadows = options.shadows ?? true;
  mesh.castShadow = shadows;
  mesh.receiveShadow = shadows;
  scene.add(mesh);
  staticMeshes.push(mesh);
  if (options.collider) {
    mesh.updateMatrixWorld(true);
    colliders.push({
      box: new THREE.Box3().setFromObject(mesh),
      mesh,
      surface: options.surface ?? "concrete",
    });
  }
  return mesh;
}

function addBox(
  scene: THREE.Scene,
  colliders: Collider[],
  staticMeshes: THREE.Object3D[],
  material: THREE.Material,
  position: THREE.Vector3,
  size: THREE.Vector3,
  options: {
    rotation?: number;
    collider?: boolean;
    surface?: Collider["surface"];
    shadows?: boolean;
    bevel?: number;
  } = {},
): THREE.Mesh {
  const geometry =
    options.bevel && options.bevel > 0
      ? new RoundedBoxGeometry(
          size.x,
          size.y,
          size.z,
          2,
          Math.min(options.bevel, Math.min(size.x, size.y, size.z) * 0.2),
        )
      : new THREE.BoxGeometry(size.x, size.y, size.z);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(position);
  mesh.rotation.y = options.rotation ?? 0;
  return registerMesh(scene, colliders, staticMeshes, mesh, options);
}

function addCylinder(
  scene: THREE.Scene,
  colliders: Collider[],
  staticMeshes: THREE.Object3D[],
  material: THREE.Material,
  position: THREE.Vector3,
  radiusTop: number,
  radiusBottom: number,
  height: number,
  segments = 16,
  options: {
    collider?: boolean;
    surface?: Collider["surface"];
    shadows?: boolean;
    rotationX?: number;
    rotationZ?: number;
  } = {},
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments),
    material,
  );
  mesh.position.copy(position);
  mesh.rotation.x = options.rotationX ?? 0;
  mesh.rotation.z = options.rotationZ ?? 0;
  return registerMesh(scene, colliders, staticMeshes, mesh, options);
}

function createSky(scene: THREE.Scene): void {
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(720, 48, 26),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        zenith: { value: new THREE.Color(0x102b45) },
        upper: { value: new THREE.Color(0x456c80) },
        horizon: { value: new THREE.Color(0xe0ad78) },
        haze: { value: new THREE.Color(0xa67d61) },
        sunDirection: {
          value: new THREE.Vector3(-0.69, 0.31, -0.65).normalize(),
        },
      },
      vertexShader: `
        varying vec3 vWorldDirection;
        void main() {
          vec4 worldPosition = modelMatrix * vec4(position, 1.0);
          vWorldDirection = normalize(worldPosition.xyz - cameraPosition);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 zenith;
        uniform vec3 upper;
        uniform vec3 horizon;
        uniform vec3 haze;
        uniform vec3 sunDirection;
        varying vec3 vWorldDirection;

        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }

        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
            mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0)), f.x),
            f.y
          );
        }

        void main() {
          vec3 direction = normalize(vWorldDirection);
          float height = clamp(direction.y, -0.08, 1.0);
          vec3 color = mix(haze, horizon, smoothstep(-0.03, 0.14, height));
          color = mix(color, upper, smoothstep(0.08, 0.52, height));
          color = mix(color, zenith, smoothstep(0.5, 1.0, height));

          float sunDot = max(dot(direction, sunDirection), 0.0);
          float sun = pow(sunDot, 1150.0);
          float glow = pow(sunDot, 8.0);
          color += vec3(1.0, 0.55, 0.21) * glow * 0.62;
          color += vec3(1.0, 0.91, 0.7) * sun * 7.0;

          vec2 cloudUv = direction.xz / max(0.12, direction.y + 0.34);
          float cloud = noise(cloudUv * 2.1) * 0.62 + noise(cloudUv * 5.3) * 0.38;
          cloud = smoothstep(0.58, 0.75, cloud) * smoothstep(0.07, 0.34, height);
          color = mix(color, vec3(0.82, 0.77, 0.69), cloud * 0.31);

          float horizonDust = exp(-abs(height) * 15.0);
          color = mix(color, vec3(0.61, 0.46, 0.35), horizonDust * 0.27);
          gl_FragColor = vec4(color, 1.0);
        }
      `,
    }),
  );
  scene.add(sky);
}

function createMountains(
  scene: THREE.Scene,
  staticMeshes: THREE.Object3D[],
): void {
  const material = new THREE.MeshBasicMaterial({
    color: 0x917b69,
    fog: true,
  });
  const random = seeded(4412);
  const vertices: number[] = [];
  const segments = 128;
  const radius = 240;
  let heights = Array.from({ length: segments }, (_, index) => {
    const angle = (index / segments) * Math.PI * 2;
    return (
      14 +
      Math.sin(angle * 3.2 + 0.8) * 5.5 +
      Math.sin(angle * 7.4 - 0.4) * 3.4 +
      Math.sin(angle * 15.1) * 1.8 +
      random() * 4.5
    );
  });
  for (let pass = 0; pass < 3; pass += 1) {
    heights = heights.map(
      (height, index) =>
        heights[(index - 1 + segments) % segments] * 0.2 +
        height * 0.6 +
        heights[(index + 1) % segments] * 0.2,
    );
  }
  const innerRadii = Array.from(
    { length: segments },
    (_, index) =>
      radius -
      13 -
      Math.sin((index / segments) * Math.PI * 6.4) * 5 -
      random() * 7,
  );
  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % segments;
    const angleA = (index / segments) * Math.PI * 2;
    const angleB = (next / segments) * Math.PI * 2;
    const heightA = heights[index];
    const heightB = heights[next];
    const innerRadiusA = innerRadii[index];
    const innerRadiusB = innerRadii[next];
    vertices.push(
      Math.sin(angleA) * radius,
      -5,
      Math.cos(angleA) * radius,
      Math.sin(angleA) * innerRadiusA,
      heightA,
      Math.cos(angleA) * innerRadiusA,
      Math.sin(angleB) * radius,
      -5,
      Math.cos(angleB) * radius,
      Math.sin(angleB) * radius,
      -5,
      Math.cos(angleB) * radius,
      Math.sin(angleA) * innerRadiusA,
      heightA,
      Math.cos(angleA) * innerRadiusA,
      Math.sin(angleB) * innerRadiusB,
      heightB,
      Math.cos(angleB) * innerRadiusB,
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(vertices, 3),
  );
  geometry.computeVertexNormals();
  const mountains = new THREE.Mesh(geometry, material);
  mountains.receiveShadow = true;
  scene.add(mountains);
  staticMeshes.push(mountains);
}

function makeSignTexture(
  title: string,
  subtitle: string,
  background = "#1f382f",
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 192;
  const context = canvas.getContext("2d")!;
  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "rgba(255,255,255,0.04)";
  for (let x = -canvas.height; x < canvas.width; x += 36) {
    context.fillRect(x, 0, 12, canvas.height);
  }
  context.strokeStyle = "#ba9d65";
  context.lineWidth = 8;
  context.strokeRect(10, 10, canvas.width - 20, canvas.height - 20);
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = "#e8dfc8";
  context.font = "800 58px Arial, sans-serif";
  context.fillText(title.toUpperCase(), canvas.width / 2, 76);
  context.fillStyle = "#c7a96d";
  context.font = "700 23px Arial, sans-serif";
  context.fillText(subtitle.toUpperCase(), canvas.width / 2, 139);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function addRoad(
  scene: THREE.Scene,
  colliders: Collider[],
  staticMeshes: THREE.Object3D[],
  materials: BattlefieldMaterials,
  x: number,
  z: number,
  width: number,
  length: number,
  rotation: number,
  markings = true,
): void {
  const ground = terrainHeight(x, z);
  const geometry = new THREE.PlaneGeometry(width, length, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  const road = new THREE.Mesh(geometry, materials.asphalt);
  road.position.set(x, ground + 0.105, z);
  road.rotation.y = rotation;
  registerMesh(scene, colliders, staticMeshes, road, {
    shadows: false,
    surface: "concrete",
  });

  const direction = new THREE.Vector2(Math.sin(rotation), Math.cos(rotation));
  const side = new THREE.Vector2(direction.y, -direction.x);
  for (const sideSign of [-1, 1]) {
    const curbX = x + side.x * sideSign * (width / 2 + 0.34);
    const curbZ = z + side.y * sideSign * (width / 2 + 0.34);
    addBox(
      scene,
      colliders,
      staticMeshes,
      materials.concreteDark,
      new THREE.Vector3(curbX, ground + 0.22, curbZ),
      new THREE.Vector3(0.65, 0.28, length),
      {
        rotation,
        collider: false,
        surface: "concrete",
        shadows: false,
        bevel: 0.08,
      },
    );
  }

  if (!markings) return;
  for (let offset = -length / 2 + 7; offset < length / 2; offset += 12) {
    const markX = x + direction.x * offset;
    const markZ = z + direction.y * offset;
    addBox(
      scene,
      colliders,
      staticMeshes,
      materials.roadMarking,
      new THREE.Vector3(markX, ground + 0.125, markZ),
      new THREE.Vector3(0.16, 0.018, 5.2),
      {
        rotation,
        collider: false,
        shadows: false,
      },
    );
  }
}

function addWindow(
  scene: THREE.Scene,
  colliders: Collider[],
  staticMeshes: THREE.Object3D[],
  materials: BattlefieldMaterials,
  building: BuildingOptions,
  localX: number,
  localY: number,
  front: 1 | -1,
  width = 1.45,
  height = 1.2,
): void {
  const rotation = building.rotation ?? 0;
  const localZ = front * (building.depth / 2 + 0.015);
  const [x, z] = localToWorld(
    building.x,
    building.z,
    rotation,
    localX,
    localZ,
  );
  const pane = addBox(
    scene,
    colliders,
    staticMeshes,
    materials.windowDark,
    new THREE.Vector3(x, terrainHeight(building.x, building.z) + localY, z),
    new THREE.Vector3(width, height, 0.055),
    {
      rotation,
      collider: false,
      shadows: false,
      bevel: 0.02,
    },
  );
  if (front < 0) pane.rotation.y += Math.PI;

  const frameThickness = 0.075;
  const frameMaterial = materials.metalDark;
  for (const vertical of [-1, 0, 1]) {
    const [fx, fz] = localToWorld(
      building.x,
      building.z,
      rotation,
      localX + vertical * (width / 2),
      localZ + front * 0.04,
    );
    addBox(
      scene,
      colliders,
      staticMeshes,
      frameMaterial,
      new THREE.Vector3(
        fx,
        terrainHeight(building.x, building.z) + localY,
        fz,
      ),
      new THREE.Vector3(frameThickness, height + 0.16, 0.075),
      { rotation, collider: false, shadows: false },
    );
  }
  for (const horizontal of [-1, 1]) {
    const [fx, fz] = localToWorld(
      building.x,
      building.z,
      rotation,
      localX,
      localZ + front * 0.04,
    );
    addBox(
      scene,
      colliders,
      staticMeshes,
      frameMaterial,
      new THREE.Vector3(
        fx,
        terrainHeight(building.x, building.z) +
          localY +
          horizontal * (height / 2),
        fz,
      ),
      new THREE.Vector3(width + 0.15, frameThickness, 0.075),
      { rotation, collider: false, shadows: false },
    );
  }
}

function addFacadeWear(
  scene: THREE.Scene,
  staticMeshes: THREE.Object3D[],
  materials: BattlefieldMaterials,
  building: BuildingOptions,
): void {
  const random = seeded(
    Math.abs(Math.round(building.x * 113 + building.z * 173 + building.height * 41)),
  );
  const rotation = building.rotation ?? 0;
  const ground = terrainHeight(building.x, building.z);
  const patchMaterial =
    building.wall === materials.brick ? materials.plasterWarm : materials.concreteDark;
  for (let patchIndex = 0; patchIndex < 3; patchIndex += 1) {
    const radiusX = 0.48 + random() * 0.72;
    const radiusY = 0.35 + random() * 0.58;
    const shape = new THREE.Shape();
    const points = 9;
    for (let pointIndex = 0; pointIndex < points; pointIndex += 1) {
      const angle = (pointIndex / points) * Math.PI * 2;
      const jitter = 0.68 + random() * 0.4;
      const px = Math.cos(angle) * radiusX * jitter;
      const py = Math.sin(angle) * radiusY * jitter;
      if (pointIndex === 0) shape.moveTo(px, py);
      else shape.lineTo(px, py);
    }
    shape.closePath();
    const localX =
      (random() - 0.5) * Math.max(1, building.width - radiusX * 2.6);
    const localY =
      1.1 + random() * Math.max(0.8, building.height - 2.2);
    const [x, z] = localToWorld(
      building.x,
      building.z,
      rotation,
      localX,
      building.depth / 2 + 0.092,
    );
    const patch = new THREE.Mesh(new THREE.ShapeGeometry(shape), patchMaterial);
    patch.position.set(x, ground + localY, z);
    patch.rotation.y = rotation;
    patch.castShadow = false;
    patch.receiveShadow = true;
    scene.add(patch);
    staticMeshes.push(patch);
  }

  for (let streakIndex = 0; streakIndex < 3; streakIndex += 1) {
    const localX =
      -building.width * 0.34 + streakIndex * building.width * 0.31 +
      (random() - 0.5) * 0.45;
    const streakHeight = 0.65 + random() * 1.3;
    const [x, z] = localToWorld(
      building.x,
      building.z,
      rotation,
      localX,
      building.depth / 2 + 0.098,
    );
    addBox(
      scene,
      [],
      staticMeshes,
      materials.concreteDark,
      new THREE.Vector3(
        x,
        ground + building.height * 0.42 - streakHeight * 0.5,
        z,
      ),
      new THREE.Vector3(0.045 + random() * 0.06, streakHeight, 0.018),
      {
        rotation,
        collider: false,
        shadows: false,
      },
    );
  }
}

function addBuilding(
  scene: THREE.Scene,
  colliders: Collider[],
  staticMeshes: THREE.Object3D[],
  materials: BattlefieldMaterials,
  options: BuildingOptions,
): void {
  const rotation = options.rotation ?? 0;
  const ground = terrainHeight(options.x, options.z);
  const base = addBox(
    scene,
    colliders,
    staticMeshes,
    options.wall,
    new THREE.Vector3(options.x, ground + options.height / 2, options.z),
    new THREE.Vector3(options.width, options.height, options.depth),
    {
      rotation,
      collider: true,
      surface: "concrete",
      bevel: 0.08,
    },
  );
  base.userData.surface = "concrete";
  addFacadeWear(scene, staticMeshes, materials, options);

  const accent = options.accent ?? materials.concreteDark;
  addBox(
    scene,
    colliders,
    staticMeshes,
    accent,
    new THREE.Vector3(options.x, ground + options.height + 0.2, options.z),
    new THREE.Vector3(options.width + 0.45, 0.4, options.depth + 0.45),
    {
      rotation,
      collider: false,
      surface: "concrete",
      bevel: 0.05,
    },
  );

  // Deep contact bands and drain hardware stop the procedural blocks from
  // appearing to float above the street.
  for (const front of [-1, 1]) {
    const [bandX, bandZ] = localToWorld(
      options.x,
      options.z,
      rotation,
      0,
      front * (options.depth / 2 + 0.085),
    );
    addBox(
      scene,
      colliders,
      staticMeshes,
      materials.concreteDark,
      new THREE.Vector3(bandX, ground + 0.26, bandZ),
      new THREE.Vector3(options.width + 0.12, 0.52, 0.14),
      {
        rotation,
        collider: false,
        shadows: false,
        bevel: 0.025,
      },
    );
  }
  for (const sideSign of [-1, 1]) {
    const [bandX, bandZ] = localToWorld(
      options.x,
      options.z,
      rotation,
      sideSign * (options.width / 2 + 0.085),
      0,
    );
    addBox(
      scene,
      colliders,
      staticMeshes,
      materials.concreteDark,
      new THREE.Vector3(bandX, ground + 0.26, bandZ),
      new THREE.Vector3(0.14, 0.52, options.depth),
      {
        rotation,
        collider: false,
        shadows: false,
        bevel: 0.025,
      },
    );
  }
  const drainSide =
    seeded(Math.abs(Math.round(options.x * 37 + options.z * 61)))() > 0.5
      ? 1
      : -1;
  const [drainX, drainZ] = localToWorld(
    options.x,
    options.z,
    rotation,
    drainSide * (options.width / 2 - 0.42),
    options.depth / 2 + 0.18,
  );
  addCylinder(
    scene,
    colliders,
    staticMeshes,
    materials.metalDark,
    new THREE.Vector3(drainX, ground + options.height * 0.48, drainZ),
    0.065,
    0.075,
    Math.max(2.8, options.height * 0.9),
    7,
    { collider: false, surface: "metal", shadows: false },
  );

  for (const sideSign of [-1, 1]) {
    const [px, pz] = localToWorld(
      options.x,
      options.z,
      rotation,
      sideSign * (options.width / 2 - 0.22),
      0,
    );
    addBox(
      scene,
      colliders,
      staticMeshes,
      accent,
      new THREE.Vector3(px, ground + options.height / 2, pz),
      new THREE.Vector3(0.36, options.height + 0.24, options.depth + 0.18),
      {
        rotation,
        collider: false,
        shadows: true,
      },
    );
  }

  const windowColumns = Math.max(2, Math.floor(options.width / 3));
  for (let floor = 0; floor < options.floors; floor += 1) {
    const localY =
      1.65 +
      floor * ((options.height - 1.1) / Math.max(1, options.floors));
    for (let column = 0; column < windowColumns; column += 1) {
      if (floor === 0 && column === Math.floor(windowColumns / 2)) continue;
      const localX =
        -options.width / 2 +
        ((column + 0.5) * options.width) / windowColumns;
      addWindow(
        scene,
        colliders,
        staticMeshes,
        materials,
        options,
        localX,
        localY,
        1,
        Math.min(1.55, options.width / windowColumns - 0.55),
      );
    }
  }

  const doorX = 0;
  const [doorWorldX, doorWorldZ] = localToWorld(
    options.x,
    options.z,
    rotation,
    doorX,
    options.depth / 2 + 0.055,
  );
  addBox(
    scene,
    colliders,
    staticMeshes,
    materials.metalDark,
    new THREE.Vector3(doorWorldX, ground + 1.22, doorWorldZ),
    new THREE.Vector3(1.35, 2.44, 0.12),
    {
      rotation,
      collider: false,
      surface: "metal",
      bevel: 0.035,
    },
  );

  if (options.sign) {
    const [signX, signZ] = localToWorld(
      options.x,
      options.z,
      rotation,
      0,
      options.depth / 2 + 0.12,
    );
    const signTexture = makeSignTexture(options.sign, "KHARIF DISTRICT");
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(Math.min(5.2, options.width * 0.55), 1.45),
      new THREE.MeshStandardMaterial({
        map: signTexture,
        emissiveMap: signTexture,
        emissive: 0x342718,
        emissiveIntensity: 0.32,
        roughness: 0.74,
      }),
    );
    sign.position.set(signX, ground + options.height * 0.64, signZ);
    sign.rotation.y = rotation;
    scene.add(sign);
    staticMeshes.push(sign);
  }

  if (options.awning) {
    const [awningX, awningZ] = localToWorld(
      options.x,
      options.z,
      rotation,
      0,
      options.depth / 2 + 1.25,
    );
    const awning = addBox(
      scene,
      colliders,
      staticMeshes,
      materials.fabric,
      new THREE.Vector3(awningX, ground + 2.65, awningZ),
      new THREE.Vector3(options.awning, 0.12, 2.35),
      {
        rotation,
        collider: false,
        shadows: true,
        bevel: 0.04,
      },
    );
    awning.rotation.x = -0.11;
  }

  if (options.balcony && options.floors > 1) {
    const [balconyX, balconyZ] = localToWorld(
      options.x,
      options.z,
      rotation,
      options.width * 0.18,
      options.depth / 2 + 0.8,
    );
    addBox(
      scene,
      colliders,
      staticMeshes,
      materials.concreteDark,
      new THREE.Vector3(balconyX, ground + options.height * 0.55, balconyZ),
      new THREE.Vector3(options.width * 0.5, 0.22, 1.65),
      {
        rotation,
        collider: false,
        bevel: 0.04,
      },
    );
    for (let index = -2; index <= 2; index += 1) {
      const [railX, railZ] = localToWorld(
        options.x,
        options.z,
        rotation,
        options.width * 0.18 + index * (options.width * 0.055),
        options.depth / 2 + 1.55,
      );
      addBox(
        scene,
        colliders,
        staticMeshes,
        materials.metalDark,
        new THREE.Vector3(
          railX,
          ground + options.height * 0.55 + 0.62,
          railZ,
        ),
        new THREE.Vector3(0.055, 1.1, 0.055),
        { rotation, collider: false, shadows: false },
      );
    }
  }

  const roofRandom = seeded(
    Math.round((options.x + 180) * 17 + (options.z + 180) * 31),
  );
  const roofCount = 1 + Math.floor(roofRandom() * 3);
  for (let index = 0; index < roofCount; index += 1) {
    const localX = (roofRandom() - 0.5) * (options.width - 2);
    const localZ = (roofRandom() - 0.5) * (options.depth - 2);
    const [roofX, roofZ] = localToWorld(
      options.x,
      options.z,
      rotation,
      localX,
      localZ,
    );
    const isTank = index === 0 && roofRandom() > 0.45;
    if (isTank) {
      addCylinder(
        scene,
        colliders,
        staticMeshes,
        materials.rustedMetal,
        new THREE.Vector3(roofX, ground + options.height + 1.05, roofZ),
        0.7,
        0.7,
        1.65,
        18,
        { collider: false, surface: "metal" },
      );
    } else {
      addBox(
        scene,
        colliders,
        staticMeshes,
        materials.metalDark,
        new THREE.Vector3(roofX, ground + options.height + 0.52, roofZ),
        new THREE.Vector3(1.4, 0.85, 1.05),
        {
          rotation,
          collider: false,
          surface: "metal",
          bevel: 0.08,
        },
      );
    }
  }

  if (options.damaged) {
    const rubbleRandom = seeded(Math.abs(Math.round(options.x * 91 + options.z * 53)));
    for (let index = 0; index < 18; index += 1) {
      const localX = (rubbleRandom() - 0.5) * (options.width + 3);
      const localZ =
        options.depth / 2 + 0.7 + rubbleRandom() * 3.4;
      const [rubbleX, rubbleZ] = localToWorld(
        options.x,
        options.z,
        rotation,
        localX,
        localZ,
      );
      const size = 0.18 + rubbleRandom() * 0.48;
      const rubble = new THREE.Mesh(
        new THREE.DodecahedronGeometry(size, 0),
        rubbleRandom() > 0.3 ? materials.concreteDark : materials.brick,
      );
      rubble.position.set(
        rubbleX,
        terrainHeight(rubbleX, rubbleZ) + size * 0.55,
        rubbleZ,
      );
      rubble.rotation.set(
        rubbleRandom() * Math.PI,
        rubbleRandom() * Math.PI,
        rubbleRandom() * Math.PI,
      );
      registerMesh(scene, colliders, staticMeshes, rubble, {
        collider: false,
        surface: "concrete",
        shadows: index < 8,
      });
    }
  }
}

function addOpenWarehouse(
  scene: THREE.Scene,
  colliders: Collider[],
  staticMeshes: THREE.Object3D[],
  materials: BattlefieldMaterials,
  x: number,
  z: number,
  rotation: number,
): void {
  const ground = terrainHeight(x, z);
  const width = 24;
  const depth = 17;
  const height = 8.5;
  const walls: Array<[number, number, number, number, number, number]> = [
    [-width / 2, height / 2, 0, 0.65, height, depth],
    [width / 2, height / 2, 0, 0.65, height, depth],
    [0, height / 2, -depth / 2, width, height, 0.65],
    [-8.2, height / 2, depth / 2, 7.2, height, 0.65],
    [8.2, height / 2, depth / 2, 7.2, height, 0.65],
  ];
  walls.forEach(([localX, localY, localZ, sx, sy, sz]) => {
    const [worldX, worldZ] = localToWorld(x, z, rotation, localX, localZ);
    addBox(
      scene,
      colliders,
      staticMeshes,
      materials.rustedMetal,
      new THREE.Vector3(worldX, ground + localY, worldZ),
      new THREE.Vector3(sx, sy, sz),
      {
        rotation,
        collider: true,
        surface: "metal",
        bevel: 0.04,
      },
    );
  });
  addBox(
    scene,
    colliders,
    staticMeshes,
    materials.metalDark,
    new THREE.Vector3(x, ground + height + 0.2, z),
    new THREE.Vector3(width + 0.4, 0.42, depth + 0.4),
    {
      rotation,
      collider: false,
      surface: "metal",
      bevel: 0.04,
    },
  );
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(width - 0.8, depth - 0.8),
    materials.concreteDark,
  );
  floor.rotation.x = -Math.PI / 2;
  floor.rotation.z = -rotation;
  floor.position.set(x, ground + 0.13, z);
  registerMesh(scene, colliders, staticMeshes, floor, {
    collider: false,
    surface: "concrete",
    shadows: false,
  });

  for (let index = -2; index <= 2; index += 1) {
    const [trussX, trussZ] = localToWorld(
      x,
      z,
      rotation,
      (index * width) / 5,
      0,
    );
    addBox(
      scene,
      colliders,
      staticMeshes,
      materials.metalDark,
      new THREE.Vector3(trussX, ground + 7.85, trussZ),
      new THREE.Vector3(0.16, 0.16, depth - 0.8),
      { rotation, collider: false, surface: "metal" },
    );
  }

  const signTexture = makeSignTexture("ATLAS", "FORWARD OPERATING BASE", "#283c3b");
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(6.2, 1.6),
    new THREE.MeshStandardMaterial({
      map: signTexture,
      emissiveMap: signTexture,
      emissive: 0x1f2b28,
      emissiveIntensity: 0.35,
      roughness: 0.68,
    }),
  );
  const [signX, signZ] = localToWorld(x, z, rotation, 0, depth / 2 + 0.36);
  sign.position.set(signX, ground + 6.15, signZ);
  sign.rotation.y = rotation;
  scene.add(sign);
  staticMeshes.push(sign);

  for (let index = 0; index < 5; index += 1) {
    const localX = -7 + (index % 3) * 3.4;
    const localZ = -3 + Math.floor(index / 3) * 4.2;
    const [crateX, crateZ] = localToWorld(x, z, rotation, localX, localZ);
    addCrate(
      scene,
      colliders,
      staticMeshes,
      materials,
      crateX,
      crateZ,
      rotation + (index % 2) * 0.16,
      index === 1,
    );
  }
}

function addCrate(
  scene: THREE.Scene,
  colliders: Collider[],
  staticMeshes: THREE.Object3D[],
  materials: BattlefieldMaterials,
  x: number,
  z: number,
  rotation = 0,
  large = false,
): void {
  const size = large ? 2.1 : 1.35;
  const ground = terrainHeight(x, z);
  addBox(
    scene,
    colliders,
    staticMeshes,
    materials.wood,
    new THREE.Vector3(x, ground + size * 0.46, z),
    new THREE.Vector3(size, size * 0.92, size),
    {
      rotation,
      collider: true,
      surface: "wood",
      bevel: 0.055,
    },
  );
  for (const side of [-1, 1]) {
    const [strapX, strapZ] = localToWorld(
      x,
      z,
      rotation,
      side * size * 0.32,
      0,
    );
    addBox(
      scene,
      colliders,
      staticMeshes,
      materials.metalDark,
      new THREE.Vector3(strapX, ground + size * 0.47, strapZ),
      new THREE.Vector3(0.08, size * 0.94, size + 0.025),
      { rotation, collider: false, surface: "metal", shadows: false },
    );
  }
}

function addBarrier(
  scene: THREE.Scene,
  colliders: Collider[],
  staticMeshes: THREE.Object3D[],
  materials: BattlefieldMaterials,
  x: number,
  z: number,
  rotation: number,
): void {
  const ground = terrainHeight(x, z);
  const barrier = addBox(
    scene,
    colliders,
    staticMeshes,
    materials.concrete,
    new THREE.Vector3(x, ground + 0.52, z),
    new THREE.Vector3(2.9, 1.05, 0.66),
    {
      rotation,
      collider: true,
      surface: "concrete",
      bevel: 0.18,
    },
  );
  barrier.scale.set(1, 1, 0.88);
  for (const side of [-0.78, 0.78]) {
    const [stripeX, stripeZ] = localToWorld(x, z, rotation, side, -0.35);
    const stripe = addBox(
      scene,
      colliders,
      staticMeshes,
      materials.orange,
      new THREE.Vector3(stripeX, ground + 0.67, stripeZ),
      new THREE.Vector3(0.34, 0.36, 0.035),
      {
        rotation,
        collider: false,
        shadows: false,
      },
    );
    stripe.rotation.z = side > 0 ? -0.38 : 0.38;
  }
}

function addSandbagWall(
  scene: THREE.Scene,
  colliders: Collider[],
  staticMeshes: THREE.Object3D[],
  materials: BattlefieldMaterials,
  x: number,
  z: number,
  rotation: number,
  length: number,
): void {
  const count = Math.max(2, Math.round(length / 1.12));
  const direction = new THREE.Vector2(Math.cos(rotation), -Math.sin(rotation));
  for (let row = 0; row < 2; row += 1) {
    for (let index = 0; index < count - row; index += 1) {
      const offset =
        (index - (count - row - 1) / 2) * 1.08 +
        (row % 2) * 0.28;
      const px = x + direction.x * offset;
      const pz = z + direction.y * offset;
      const ground = terrainHeight(px, pz);
      addBox(
        scene,
        colliders,
        staticMeshes,
        materials.sandbag,
        new THREE.Vector3(px, ground + 0.33 + row * 0.54, pz),
        new THREE.Vector3(1.02, 0.5, 0.58),
        {
          rotation,
          collider: row === 0,
          surface: "sand",
          bevel: 0.2,
        },
      );
    }
  }
}

function addFuelTank(
  scene: THREE.Scene,
  colliders: Collider[],
  staticMeshes: THREE.Object3D[],
  materials: BattlefieldMaterials,
  x: number,
  z: number,
  radius: number,
  height: number,
): void {
  const ground = terrainHeight(x, z);
  const tank = addCylinder(
    scene,
    colliders,
    staticMeshes,
    materials.rustedMetal,
    new THREE.Vector3(x, ground + height / 2, z),
    radius,
    radius,
    height,
    28,
    { collider: true, surface: "metal" },
  );
  tank.userData.surface = "metal";
  for (let ringIndex = 1; ringIndex < 4; ringIndex += 1) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(radius + 0.06, 0.075, 6, 36),
      materials.metalDark,
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(x, ground + (height * ringIndex) / 4, z);
    registerMesh(scene, colliders, staticMeshes, ring, {
      collider: false,
      surface: "metal",
      shadows: false,
    });
  }
  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(
      radius,
      28,
      8,
      0,
      Math.PI * 2,
      0,
      Math.PI / 2,
    ),
    materials.metal,
  );
  cap.scale.y = 0.36;
  cap.position.set(x, ground + height, z);
  registerMesh(scene, colliders, staticMeshes, cap, {
    collider: false,
    surface: "metal",
  });
  addCylinder(
    scene,
    colliders,
    staticMeshes,
    materials.orange,
    new THREE.Vector3(x + radius * 0.72, ground + height * 0.54, z + radius * 0.72),
    0.1,
    0.1,
    height * 0.88,
    8,
    { collider: false, surface: "metal", shadows: false },
  );
}

function addRadioTower(
  scene: THREE.Scene,
  colliders: Collider[],
  staticMeshes: THREE.Object3D[],
  materials: BattlefieldMaterials,
  x: number,
  z: number,
): void {
  const ground = terrainHeight(x, z);
  const towerHeight = 30;
  const levels = 7;
  for (let level = 0; level < levels; level += 1) {
    const y0 = (level / levels) * towerHeight;
    const y1 = ((level + 1) / levels) * towerHeight;
    const width0 = 6.4 - (y0 / towerHeight) * 4.5;
    const width1 = 6.4 - (y1 / towerHeight) * 4.5;
    for (const corner of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const) {
      const x0 = x + corner[0] * width0 * 0.5;
      const z0 = z + corner[1] * width0 * 0.5;
      const x1 = x + corner[0] * width1 * 0.5;
      const z1 = z + corner[1] * width1 * 0.5;
      const start = new THREE.Vector3(x0, ground + y0, z0);
      const end = new THREE.Vector3(x1, ground + y1, z1);
      const middle = start.clone().add(end).multiplyScalar(0.5);
      const length = start.distanceTo(end);
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.095, 0.12, length, 6),
        materials.metalDark,
      );
      beam.position.copy(middle);
      beam.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        end.clone().sub(start).normalize(),
      );
      registerMesh(scene, colliders, staticMeshes, beam, {
        collider: false,
        surface: "metal",
      });
    }
    if (level < levels - 1) {
      const y = ground + y1;
      const width = width1;
      for (const horizontal of [
        [x - width / 2, z - width / 2, x + width / 2, z - width / 2],
        [x + width / 2, z - width / 2, x + width / 2, z + width / 2],
        [x + width / 2, z + width / 2, x - width / 2, z + width / 2],
        [x - width / 2, z + width / 2, x - width / 2, z - width / 2],
      ]) {
        const start = new THREE.Vector3(horizontal[0], y, horizontal[1]);
        const end = new THREE.Vector3(horizontal[2], y, horizontal[3]);
        const beam = new THREE.Mesh(
          new THREE.CylinderGeometry(0.065, 0.065, start.distanceTo(end), 6),
          materials.rustedMetal,
        );
        beam.position.copy(start).add(end).multiplyScalar(0.5);
        beam.quaternion.setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          end.clone().sub(start).normalize(),
        );
        registerMesh(scene, colliders, staticMeshes, beam, {
          collider: false,
          surface: "metal",
          shadows: false,
        });
      }
    }
  }
  const dish = new THREE.Mesh(
    new THREE.SphereGeometry(2.9, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2),
    materials.metal,
  );
  dish.scale.y = 0.3;
  dish.rotation.x = -0.95;
  dish.rotation.z = 0.28;
  dish.position.set(x, ground + 27.5, z);
  registerMesh(scene, colliders, staticMeshes, dish, {
    collider: false,
    surface: "metal",
  });

  const beacon = new THREE.PointLight(0xff3a25, 18, 22, 2);
  beacon.position.set(x, ground + 30.5, z);
  scene.add(beacon);
  const beaconLens = new THREE.Mesh(
    new THREE.SphereGeometry(0.17, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xff543f }),
  );
  beaconLens.position.copy(beacon.position);
  beaconLens.name = "towerBeacon";
  scene.add(beaconLens);
  staticMeshes.push(beaconLens);
}

function addStreetLight(
  scene: THREE.Scene,
  colliders: Collider[],
  staticMeshes: THREE.Object3D[],
  materials: BattlefieldMaterials,
  x: number,
  z: number,
  rotation: number,
  lit: boolean,
): void {
  const ground = terrainHeight(x, z);
  addCylinder(
    scene,
    colliders,
    staticMeshes,
    materials.metalDark,
    new THREE.Vector3(x, ground + 4.4, z),
    0.085,
    0.13,
    8.8,
    8,
    { collider: false, surface: "metal" },
  );
  const [armX, armZ] = localToWorld(x, z, rotation, 0.9, 0);
  addBox(
    scene,
    colliders,
    staticMeshes,
    materials.metalDark,
    new THREE.Vector3(armX, ground + 8.55, armZ),
    new THREE.Vector3(1.8, 0.11, 0.11),
    { rotation, collider: false, surface: "metal", shadows: false },
  );
  const [lampX, lampZ] = localToWorld(x, z, rotation, 1.72, 0);
  addBox(
    scene,
    colliders,
    staticMeshes,
    lit ? materials.emissiveWarm : materials.metalDark,
    new THREE.Vector3(lampX, ground + 8.37, lampZ),
    new THREE.Vector3(0.58, 0.18, 0.36),
    { rotation, collider: false, surface: "metal", shadows: false },
  );
  if (lit) {
    const light = new THREE.PointLight(0xffa85e, 12, 18, 2);
    light.position.set(lampX, ground + 8.15, lampZ);
    light.castShadow = false;
    scene.add(light);
  }
}

function addPowerCable(
  scene: THREE.Scene,
  staticMeshes: THREE.Object3D[],
  material: THREE.Material,
  from: THREE.Vector3,
  to: THREE.Vector3,
  sag: number,
): void {
  const midpoint = from.clone().add(to).multiplyScalar(0.5);
  midpoint.y -= sag;
  const curve = new THREE.QuadraticBezierCurve3(from, midpoint, to);
  const cable = new THREE.Mesh(
    new THREE.TubeGeometry(curve, 18, 0.025, 5, false),
    material,
  );
  cable.castShadow = false;
  scene.add(cable);
  staticMeshes.push(cable);
}

function addMarketStalls(
  scene: THREE.Scene,
  colliders: Collider[],
  staticMeshes: THREE.Object3D[],
  materials: BattlefieldMaterials,
): void {
  const stalls = [
    [-61, 11.8, 0.07, 0x735745],
    [-52, 11.9, -0.08, 0x435b55],
    [-36, -11.9, 0.06, 0x7b643e],
    [-27, -12.1, -0.05, 0x52606d],
    [25, 11.8, 0.06, 0x7a4d3c],
    [43, -11.8, -0.07, 0x3f5e5c],
    [52, -11.9, 0.05, 0x806641],
    [70, 11.9, -0.06, 0x565c72],
  ] as const;
  stalls.forEach(([distance, sideOffset, rotationOffset, color], stallIndex) => {
    const [x, z] = axisPoint(distance, sideOffset);
    const rotation =
      streetFacingRotation(sideOffset) + rotationOffset;
    const ground = terrainHeight(x, z);
    const canopyMaterial = materials.fabric.clone();
    canopyMaterial.color.setHex(color);
    for (const corner of [
      [-2.2, -1.45],
      [2.2, -1.45],
      [-2.2, 1.45],
      [2.2, 1.45],
    ] as const) {
      const [postX, postZ] = localToWorld(
        x,
        z,
        rotation,
        corner[0],
        corner[1],
      );
      addCylinder(
        scene,
        colliders,
        staticMeshes,
        materials.wood,
        new THREE.Vector3(postX, ground + 1.45, postZ),
        0.055,
        0.07,
        2.9,
        6,
        { collider: false, surface: "wood", shadows: false },
      );
    }
    const canopy = addBox(
      scene,
      colliders,
      staticMeshes,
      canopyMaterial,
      new THREE.Vector3(x, ground + 3, z),
      new THREE.Vector3(4.8, 0.08, 3.2),
      {
        rotation,
        collider: false,
        surface: "wood",
        bevel: 0.05,
      },
    );
    canopy.rotation.z = stallIndex % 2 ? 0.025 : -0.02;
    const counter = addBox(
      scene,
      colliders,
      staticMeshes,
      materials.wood,
      new THREE.Vector3(x, ground + 0.95, z),
      new THREE.Vector3(4.1, 0.18, 1.15),
      {
        rotation,
        collider: true,
        surface: "wood",
        bevel: 0.06,
      },
    );
    counter.userData.surface = "wood";
    const random = seeded(981 + stallIndex * 71);
    for (let item = 0; item < 11; item += 1) {
      const localX = (random() - 0.5) * 3.5;
      const localZ = (random() - 0.5) * 0.8;
      const [itemX, itemZ] = localToWorld(
        x,
        z,
        rotation,
        localX,
        localZ,
      );
      const itemColor = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHSL(0.05 + random() * 0.2, 0.42, 0.35),
        roughness: 0.88,
      });
      addCylinder(
        scene,
        colliders,
        staticMeshes,
        itemColor,
        new THREE.Vector3(itemX, ground + 1.18, itemZ),
        0.12 + random() * 0.1,
        0.16 + random() * 0.12,
        0.22 + random() * 0.24,
        8,
        { collider: false, shadows: false },
      );
    }
  });
}

function addArcadedMarket(
  scene: THREE.Scene,
  colliders: Collider[],
  staticMeshes: THREE.Object3D[],
  materials: BattlefieldMaterials,
): void {
  const bayDistances = [-120, -101, -82, -63, -44, -25, -6, 13, 32, 51, 70, 89, 108, 127];
  const shopNames = [
    ["QAMAR", "SPICES & TEA", "#38483f"],
    ["NAJMA", "TEXTILES", "#654538"],
    ["SAFA", "RADIO REPAIR", "#354b52"],
    ["HADID", "TOOLS & SUPPLY", "#5a4b34"],
    ["ALLEY 17", "KHARIF MARKET", "#513d45"],
    ["MERIDIAN", "COFFEE HOUSE", "#42503b"],
  ] as const;
  const signMaterials = shopNames.map(([title, subtitle, background]) => {
    const texture = makeSignTexture(title, subtitle, background);
    return new THREE.MeshStandardMaterial({
      map: texture,
      emissiveMap: texture,
      emissive: 0x6a4526,
      emissiveIntensity: 0.36,
      roughness: 0.72,
    });
  });
  const canopyMaterials = [0x775244, 0x3e5a57, 0x8a7043, 0x51596b].map(
    (color) => {
      const material = materials.fabric.clone();
      material.color.setHex(color);
      material.roughness = 0.96;
      return material;
    },
  );
  const litInterior = materials.emissiveWarm.clone();
  litInterior.color.setHex(0x6f4b2c);
  litInterior.emissive.setHex(0xff7e33);
  litInterior.emissiveIntensity = 1.5;
  const darkInterior = materials.windowDark.clone();
  darkInterior.color.setHex(0x101517);
  darkInterior.roughness = 0.84;

  for (const sideOffset of [-14.7, 14.7]) {
    const sideSign = Math.sign(sideOffset);
    bayDistances.forEach((distance, bayIndex) => {
      const [centerX, centerZ] = axisPoint(distance, sideOffset);
      const ground = terrainHeight(centerX, centerZ);
      const rotation = MAIN_ROAD_ROTATION;
      const bayWidth = 6.45;
      const toWorld = (localX: number, localZ: number) =>
        localToWorld(centerX, centerZ, rotation, localX, localZ);
      const roadward = -sideSign;
      const interiorPosition = toWorld(roadward * 0.08, 0);

      addBox(
        scene,
        colliders,
        staticMeshes,
        bayIndex % 4 === 0 ? litInterior : darkInterior,
        new THREE.Vector3(interiorPosition[0], ground + 1.62, interiorPosition[1]),
        new THREE.Vector3(0.16, 3.16, bayWidth - 0.46),
        { rotation, collider: false, shadows: false },
      );

      for (const end of [-1, 1]) {
        const postPosition = toWorld(roadward * 0.34, end * bayWidth * 0.5);
        addBox(
          scene,
          colliders,
          staticMeshes,
          bayIndex % 3 === 0 ? materials.brick : materials.concreteDark,
          new THREE.Vector3(postPosition[0], ground + 1.92, postPosition[1]),
          new THREE.Vector3(0.44, 3.84, 0.42),
          {
            rotation,
            collider: false,
            surface: "concrete",
            bevel: 0.045,
          },
        );
      }

      const lintelPosition = toWorld(roadward * 0.34, 0);
      addBox(
        scene,
        colliders,
        staticMeshes,
        materials.concreteDark,
        new THREE.Vector3(lintelPosition[0], ground + 3.76, lintelPosition[1]),
        new THREE.Vector3(0.48, 0.38, bayWidth + 0.35),
        {
          rotation,
          collider: false,
          surface: "concrete",
          bevel: 0.04,
        },
      );

      const arch = new THREE.Mesh(
        new THREE.TorusGeometry(1.54, 0.17, 7, 20, Math.PI),
        bayIndex % 3 === 0 ? materials.brick : materials.plasterWarm,
      );
      const archPosition = toWorld(roadward * 0.58, 0);
      arch.position.set(archPosition[0], ground + 2.1, archPosition[1]);
      arch.rotation.y =
        MAIN_ROAD_ROTATION + (sideSign > 0 ? -Math.PI / 2 : Math.PI / 2);
      arch.castShadow = true;
      arch.receiveShadow = true;
      scene.add(arch);
      staticMeshes.push(arch);

      const canopyPosition = toWorld(roadward * 1.65, 0);
      const canopy = addBox(
        scene,
        colliders,
        staticMeshes,
        canopyMaterials[(bayIndex + (sideSign > 0 ? 1 : 0)) % canopyMaterials.length],
        new THREE.Vector3(canopyPosition[0], ground + 3.22, canopyPosition[1]),
        new THREE.Vector3(2.75, 0.09, bayWidth - 0.55),
        {
          rotation,
          collider: false,
          surface: "wood",
          bevel: 0.035,
        },
      );
      canopy.rotation.z = roadward * (0.045 + (bayIndex % 3) * 0.012);

      const signPosition = toWorld(roadward * 0.61, 0);
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(3.45, 0.72),
        signMaterials[(bayIndex + (sideSign > 0 ? 2 : 0)) % signMaterials.length],
      );
      sign.position.set(signPosition[0], ground + 3.55, signPosition[1]);
      sign.rotation.y = streetFacingRotation(sideOffset);
      sign.castShadow = false;
      scene.add(sign);
      staticMeshes.push(sign);

      if (bayIndex % 4 === 0) {
        const lightPosition = toWorld(roadward * 1.4, 0);
        const interiorLight = new THREE.PointLight(0xff8f4c, 6.5, 10, 2);
        interiorLight.position.set(
          lightPosition[0],
          ground + 2.45,
          lightPosition[1],
        );
        scene.add(interiorLight);
      }

      const crateCount = 1 + (bayIndex % 3);
      for (let crateIndex = 0; crateIndex < crateCount; crateIndex += 1) {
        const cratePosition = toWorld(
          roadward * (1.05 + crateIndex * 0.48),
          -1.65 + crateIndex * 1.1,
        );
        addBox(
          scene,
          colliders,
          staticMeshes,
          crateIndex % 2 ? materials.wood : materials.rustedMetal,
          new THREE.Vector3(
            cratePosition[0],
            ground + 0.34 + crateIndex * 0.04,
            cratePosition[1],
          ),
          new THREE.Vector3(0.62, 0.68, 0.72),
          {
            rotation: rotation + crateIndex * 0.09,
            collider: false,
            surface: crateIndex % 2 ? "wood" : "metal",
            bevel: 0.035,
          },
        );
      }
    });
  }

  const shadeSpans = [-88, -48, -8, 33, 74, 112] as const;
  shadeSpans.forEach((distance, index) => {
    const [x, z] = axisPoint(distance, 0);
    const ground = terrainHeight(x, z);
    const shade = addBox(
      scene,
      colliders,
      staticMeshes,
      canopyMaterials[(index + 1) % canopyMaterials.length],
      new THREE.Vector3(x, ground + 7.2 + (index % 2) * 0.55, z),
      new THREE.Vector3(27.5, 0.07, 5.8),
      {
        rotation: MAIN_ROAD_ROTATION,
        collider: false,
        shadows: true,
      },
    );
    shade.rotation.z = index % 2 ? 0.018 : -0.024;
    const left = axisPoint(distance, -17.5);
    const right = axisPoint(distance, 17.5);
    addPowerCable(
      scene,
      staticMeshes,
      materials.rubber,
      new THREE.Vector3(left[0], ground + 7.55, left[1]),
      new THREE.Vector3(right[0], ground + 7.55, right[1]),
      0.5,
    );
  });
}

function addUrbanInfill(
  scene: THREE.Scene,
  colliders: Collider[],
  staticMeshes: THREE.Object3D[],
  materials: BattlefieldMaterials,
): void {
  const streetRow = [
    [-138, 23, 15, 11, 8.4, 2, materials.plasterWarm, materials.concreteDark],
    [-103, 23, 14, 12, 11.6, 3, materials.brick, materials.rustedMetal],
    [-49, 23, 14, 11, 9.1, 2, materials.plaster, materials.concreteDark],
    [59, 23, 14, 12, 13.2, 3, materials.concrete, materials.rustedMetal],
    [147, 24, 14, 11, 8.8, 2, materials.plasterWarm, materials.concreteDark],
    [-139, -23, 15, 12, 10.7, 3, materials.brick, materials.concreteDark],
    [-79, -24, 14, 11, 8.7, 2, materials.plaster, materials.rustedMetal],
    [-20, -24, 15, 12, 12.8, 3, materials.concrete, materials.concreteDark],
    [42, -24, 15, 11, 9.4, 2, materials.plasterWarm, materials.rustedMetal],
    [88, -24, 13, 11, 12.2, 3, materials.brick, materials.concreteDark],
    [143, -24, 14, 12, 10.1, 2, materials.plaster, materials.rustedMetal],
  ] as const;
  streetRow.forEach(
    ([distance, sideOffset, width, depth, height, floors, wall, accent], index) => {
      const [x, z] = axisPoint(distance, sideOffset);
      addBuilding(scene, colliders, staticMeshes, materials, {
        x,
        z,
        width,
        depth,
        height,
        floors,
        rotation: streetFacingRotation(sideOffset),
        wall,
        accent,
        awning: index % 3 === 0 ? width * 0.5 : undefined,
        balcony: floors > 2 && index % 2 === 1,
        damaged: index === 1 || index === 8,
      });
    },
  );

  const backRow = [
    [-122, 40, 18, 13, 14.4, 4, materials.concrete],
    [-87, -41, 19, 13, 12.6, 3, materials.plasterWarm],
    [-60, 41, 17, 12, 15.5, 4, materials.brick],
    [-31, -41, 18, 13, 11.4, 3, materials.concrete],
    [22, 41, 19, 14, 14.7, 4, materials.plaster],
    [55, -41, 18, 12, 12.1, 3, materials.brick],
    [116, 42, 20, 14, 16.2, 4, materials.concrete],
    [137, -41, 17, 12, 13.8, 3, materials.plasterWarm],
  ] as const;
  backRow.forEach(
    ([distance, sideOffset, width, depth, height, floors, wall], index) => {
      const [x, z] = axisPoint(distance, sideOffset);
      addBuilding(scene, colliders, staticMeshes, materials, {
        x,
        z,
        width,
        depth,
        height,
        floors,
        rotation: streetFacingRotation(sideOffset),
        wall,
        accent: index % 2 ? materials.concreteDark : materials.rustedMetal,
        balcony: index % 3 !== 1,
        damaged: index === 2 || index === 6,
      });
    },
  );
}

function addPalm(
  scene: THREE.Scene,
  colliders: Collider[],
  staticMeshes: THREE.Object3D[],
  materials: BattlefieldMaterials,
  distance: number,
  sideOffset: number,
  scale: number,
): void {
  const [x, z] = axisPoint(distance, sideOffset);
  const ground = terrainHeight(x, z);
  const height = 6.2 * scale;
  addCylinder(
    scene,
    colliders,
    staticMeshes,
    materials.wood,
    new THREE.Vector3(x, ground + height / 2, z),
    0.13 * scale,
    0.25 * scale,
    height,
    9,
    { collider: false, surface: "wood" },
  );
  const crown = new THREE.Vector3(x, ground + height, z);
  for (let frond = 0; frond < 10; frond += 1) {
    const length = (2.6 + (frond % 3) * 0.32) * scale;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        [
          0,
          0,
          0,
          -0.34 * scale,
          -0.12 * scale,
          length * 0.5,
          0,
          -0.55 * scale,
          length,
          0.34 * scale,
          -0.12 * scale,
          length * 0.5,
        ],
        3,
      ),
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.computeVertexNormals();
    const leaf = new THREE.Mesh(geometry, materials.foliage);
    leaf.position.copy(crown);
    leaf.rotation.y = (frond / 10) * Math.PI * 2 + distance * 0.013;
    leaf.rotation.x = -0.06 - (frond % 2) * 0.08;
    registerMesh(scene, colliders, staticMeshes, leaf, {
      collider: false,
      shadows: frond % 2 === 0,
    });
  }
}

function addStreetDressing(
  scene: THREE.Scene,
  colliders: Collider[],
  staticMeshes: THREE.Object3D[],
  materials: BattlefieldMaterials,
): void {
  const random = seeded(0x1a0c2026);
  const paperMaterial = new THREE.MeshStandardMaterial({
    color: 0xc9b99a,
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide,
    vertexColors: true,
  });
  const paperGeometry = new THREE.PlaneGeometry(0.42, 0.28);
  paperGeometry.rotateX(-Math.PI / 2);
  const litter = new THREE.InstancedMesh(paperGeometry, paperMaterial, 220);
  const dummy = new THREE.Object3D();
  const paperColor = new THREE.Color();
  const paperPalette = [0xc9b99a, 0x8f826e, 0x5e6c69, 0x7a5946];
  for (let index = 0; index < 220; index += 1) {
    const distance = -148 + random() * 296;
    const sideOffset =
      (random() > 0.5 ? 1 : -1) * (8.7 + random() * 11.5);
    const [x, z] = axisPoint(distance, sideOffset);
    dummy.position.set(x, terrainHeight(x, z) + 0.135, z);
    dummy.rotation.set(0, random() * Math.PI * 2, 0);
    dummy.scale.set(0.55 + random() * 1.35, 0.55 + random() * 1.2, 1);
    dummy.updateMatrix();
    litter.setMatrixAt(index, dummy.matrix);
    paperColor
      .setHex(paperPalette[index % paperPalette.length])
      .multiplyScalar(0.78 + random() * 0.24);
    litter.setColorAt(index, paperColor);
  }
  litter.instanceMatrix.needsUpdate = true;
  if (litter.instanceColor) litter.instanceColor.needsUpdate = true;
  litter.receiveShadow = true;
  scene.add(litter);
  staticMeshes.push(litter);

  const barrelClusters = [
    [-119, 13],
    [-92, -16],
    [-63, 16],
    [-42, -14],
    [31, -16],
    [58, 15],
    [84, -15],
    [126, 14],
  ] as const;
  barrelClusters.forEach(([distance, sideOffset]) => {
    for (let barrel = 0; barrel < 3; barrel += 1) {
      const [x, z] = axisPoint(
        distance + (barrel - 1) * 0.72,
        sideOffset + (barrel % 2) * 0.62,
      );
      addCylinder(
        scene,
        colliders,
        staticMeshes,
        barrel % 2 ? materials.metal : materials.rustedMetal,
        new THREE.Vector3(x, terrainHeight(x, z) + 0.56, z),
        0.34,
        0.37,
        1.12,
        14,
        { collider: false, surface: "metal" },
      );
    }
  });

  const tyreSpots = [
    [-108, -13],
    [-72, 14],
    [-15, 14],
    [39, 14],
    [75, -14],
    [132, -13],
  ] as const;
  tyreSpots.forEach(([distance, sideOffset], stackIndex) => {
    const [x, z] = axisPoint(distance, sideOffset);
    for (let tyre = 0; tyre < 2 + (stackIndex % 2); tyre += 1) {
      const mesh = new THREE.Mesh(
        new THREE.TorusGeometry(0.43, 0.13, 7, 14),
        materials.rubber,
      );
      mesh.position.set(
        x,
        terrainHeight(x, z) + 0.14 + tyre * 0.22,
        z,
      );
      mesh.rotation.set(Math.PI / 2, 0, stackIndex * 0.37);
      registerMesh(scene, colliders, staticMeshes, mesh, {
        collider: false,
        surface: "metal",
      });
    }
  });

  const clothMaterials = [0x8a4d3d, 0xb39562, 0x45656a, 0x6e5b72].map(
    (color) => {
      const material = materials.fabric.clone();
      material.color.setHex(color);
      material.side = THREE.DoubleSide;
      return material;
    },
  );
  const overheadSpans = [-67, -39, -11, 27, 57, 83] as const;
  overheadSpans.forEach((distance, spanIndex) => {
    const endA = axisPoint(distance, -19);
    const endB = axisPoint(distance, 19);
    const cableHeight = 7.4 + (spanIndex % 3) * 0.7;
    const from = new THREE.Vector3(
      endA[0],
      terrainHeight(endA[0], endA[1]) + cableHeight,
      endA[1],
    );
    const to = new THREE.Vector3(
      endB[0],
      terrainHeight(endB[0], endB[1]) + cableHeight,
      endB[1],
    );
    addPowerCable(scene, staticMeshes, materials.rubber, from, to, 1.35);
    for (let cloth = 0; cloth < 5; cloth += 1) {
      const sideOffset = -11.5 + cloth * 5.7;
      const [x, z] = axisPoint(distance, sideOffset);
      const centerDrop = 1 - Math.abs(sideOffset) / 19;
      addBox(
        scene,
        colliders,
        staticMeshes,
        clothMaterials[(cloth + spanIndex) % clothMaterials.length],
        new THREE.Vector3(
          x,
          terrainHeight(x, z) + cableHeight - 0.65 - centerDrop * 1.25,
          z,
        ),
        new THREE.Vector3(2.4 + (cloth % 2) * 0.6, 1.25, 0.035),
        {
          rotation: MAIN_ROAD_ROTATION,
          collider: false,
          shadows: true,
        },
      );
    }
  });

  [
    [-128, 31, 1],
    [-95, -31, 0.9],
    [-54, 32, 1.08],
    [-17, -32, 0.95],
    [36, 32, 1.1],
    [73, -32, 0.92],
    [110, 32, 1.04],
    [139, -31, 0.88],
  ].forEach(([distance, sideOffset, scale]) =>
    addPalm(
      scene,
      colliders,
      staticMeshes,
      materials,
      distance,
      sideOffset,
      scale,
    ),
  );
}

function addDebrisField(
  scene: THREE.Scene,
  staticMeshes: THREE.Object3D[],
  materials: BattlefieldMaterials,
): void {
  const random = seeded(20260726);
  const rubbleGeometry = new THREE.DodecahedronGeometry(0.45, 0);
  const rubble = new THREE.InstancedMesh(
    rubbleGeometry,
    materials.concreteDark,
    145,
  );
  const dummy = new THREE.Object3D();
  for (let index = 0; index < 145; index += 1) {
    let x = 0;
    let z = 0;
    let attempts = 0;
    do {
      x = (random() - 0.5) * 246;
      z = (random() - 0.5) * 246;
      attempts += 1;
    } while (
      attempts < 20 &&
      Math.abs(MAIN_SIDE.x * x + MAIN_SIDE.y * z) < 11
    );
    const scale = 0.22 + random() * 0.88;
    dummy.position.set(x, terrainHeight(x, z) + scale * 0.34, z);
    dummy.rotation.set(
      random() * Math.PI,
      random() * Math.PI,
      random() * Math.PI,
    );
    dummy.scale.set(
      scale * (0.65 + random() * 0.7),
      scale * (0.45 + random() * 0.8),
      scale * (0.65 + random() * 0.7),
    );
    dummy.updateMatrix();
    rubble.setMatrixAt(index, dummy.matrix);
  }
  rubble.instanceMatrix.needsUpdate = true;
  rubble.castShadow = true;
  rubble.receiveShadow = true;
  scene.add(rubble);
  staticMeshes.push(rubble);

  const shrubGeometry = new THREE.IcosahedronGeometry(0.62, 1);
  const shrubs = new THREE.InstancedMesh(
    shrubGeometry,
    materials.foliage,
    74,
  );
  for (let index = 0; index < 74; index += 1) {
    const angle = random() * Math.PI * 2;
    const radius = 42 + random() * 78;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const scale = 0.35 + random() * 0.95;
    dummy.position.set(x, terrainHeight(x, z) + scale * 0.38, z);
    dummy.rotation.set(0, random() * Math.PI, 0);
    dummy.scale.set(scale * 1.2, scale * 0.72, scale);
    dummy.updateMatrix();
    shrubs.setMatrixAt(index, dummy.matrix);
  }
  shrubs.instanceMatrix.needsUpdate = true;
  shrubs.castShadow = true;
  shrubs.receiveShadow = true;
  scene.add(shrubs);
  staticMeshes.push(shrubs);
}

function batchStaticGeometry(
  scene: THREE.Scene,
  colliders: Collider[],
  staticMeshes: THREE.Object3D[],
): void {
  const colliderMeshes = new Set(colliders.map((collider) => collider.mesh));
  const groups = new Map<
    string,
    {
      material: THREE.Material;
      castShadow: boolean;
      receiveShadow: boolean;
      meshes: THREE.Mesh[];
    }
  >();

  for (const object of staticMeshes) {
    if (
      !(object instanceof THREE.Mesh) ||
      object instanceof THREE.InstancedMesh ||
      colliderMeshes.has(object) ||
      object.parent !== scene ||
      object.name === "towerBeacon" ||
      Array.isArray(object.material) ||
      object.material.transparent ||
      object.material.opacity < 1 ||
      !object.geometry.attributes.position
    ) {
      continue;
    }
    const attributeSignature = Object.keys(object.geometry.attributes)
      .sort()
      .join(",");
    const key = [
      object.material.uuid,
      attributeSignature,
      object.geometry.index ? "indexed" : "plain",
      object.castShadow ? "cast" : "no-cast",
      object.receiveShadow ? "receive" : "no-receive",
    ].join("|");
    const existing = groups.get(key);
    if (existing) {
      existing.meshes.push(object);
    } else {
      groups.set(key, {
        material: object.material,
        castShadow: object.castShadow,
        receiveShadow: object.receiveShadow,
        meshes: [object],
      });
    }
  }

  const removed = new Set<THREE.Object3D>();
  const additions: THREE.Mesh[] = [];
  for (const group of groups.values()) {
    if (group.meshes.length < 3) continue;
    const geometries = group.meshes.map((mesh) => {
      mesh.updateMatrixWorld(true);
      const geometry = mesh.geometry.clone();
      geometry.applyMatrix4(mesh.matrixWorld);
      return geometry;
    });
    const mergedGeometry = mergeGeometries(geometries, false);
    geometries.forEach((geometry) => geometry.dispose());
    if (!mergedGeometry) continue;
    mergedGeometry.computeBoundingBox();
    mergedGeometry.computeBoundingSphere();
    const merged = new THREE.Mesh(mergedGeometry, group.material);
    merged.castShadow = group.castShadow;
    merged.receiveShadow = group.receiveShadow;
    merged.matrixAutoUpdate = false;
    scene.add(merged);
    additions.push(merged);
    group.meshes.forEach((mesh) => {
      scene.remove(mesh);
      mesh.geometry.dispose();
      removed.add(mesh);
    });
  }

  for (let index = staticMeshes.length - 1; index >= 0; index -= 1) {
    if (removed.has(staticMeshes[index])) staticMeshes.splice(index, 1);
  }
  staticMeshes.push(...additions);
}

function addObjectiveMarker(
  scene: THREE.Scene,
  id: "A" | "B" | "C",
  name: string,
  position: THREE.Vector3,
  capture: number,
): ObjectiveState {
  const group = new THREE.Group();
  group.position.copy(position);

  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.065, 0.095, 7.5, 9),
    new THREE.MeshStandardMaterial({
      color: 0x50575b,
      metalness: 0.82,
      roughness: 0.38,
    }),
  );
  pole.position.y = 3.75;
  pole.castShadow = true;
  group.add(pole);

  const flag = new THREE.Mesh(
    new THREE.PlaneGeometry(3.1, 1.55, 14, 3),
    new THREE.MeshStandardMaterial({
      color: capture < -0.8 ? 0x249fd2 : capture > 0.8 ? 0xdc4937 : 0xb8b0a1,
      side: THREE.DoubleSide,
      roughness: 0.86,
    }),
  );
  flag.position.set(1.55, 6.35, 0);
  flag.name = "flag";
  group.add(flag);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(6.6, 6.78, 72),
    new THREE.MeshBasicMaterial({
      color: capture < 0 ? 0x35bff3 : capture > 0 ? 0xf05242 : 0xd0c6af,
      transparent: true,
      opacity: 0.38,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.11;
  group.add(ring);

  const markerCanvas = document.createElement("canvas");
  markerCanvas.width = markerCanvas.height = 128;
  const markerContext = markerCanvas.getContext("2d")!;
  markerContext.fillStyle = "rgba(8,15,18,.78)";
  markerContext.beginPath();
  markerContext.arc(64, 64, 45, 0, Math.PI * 2);
  markerContext.fill();
  markerContext.strokeStyle =
    capture < 0 ? "#46c7f5" : capture > 0 ? "#ff6958" : "#ddd1b6";
  markerContext.lineWidth = 5;
  markerContext.stroke();
  markerContext.fillStyle = "#ffffff";
  markerContext.font = "800 54px Arial";
  markerContext.textAlign = "center";
  markerContext.textBaseline = "middle";
  markerContext.fillText(id, 64, 67);
  const markerTexture = new THREE.CanvasTexture(markerCanvas);
  markerTexture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: markerTexture,
      transparent: true,
      depthTest: false,
      sizeAttenuation: true,
    }),
  );
  sprite.position.set(0, 9.5, 0);
  sprite.scale.set(0.82, 0.82, 1);
  group.add(sprite);
  scene.add(group);

  return {
    id,
    name,
    position,
    radius: 17,
    capture,
    owner: capture < -0.8 ? "blue" : capture > 0.8 ? "red" : "neutral",
    previousOwner:
      capture < -0.8 ? "blue" : capture > 0.8 ? "red" : "neutral",
    marker: group,
    pulse: ring,
  };
}

export function buildWorld(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
): BuiltWorld {
  const colliders: Collider[] = [];
  const staticMeshes: THREE.Object3D[] = [];
  createSky(scene);
  createMountains(scene, staticMeshes);

  const materials = createBattlefieldMaterials(renderer);
  tintBattlefieldMaterials(materials);

  const terrain = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE, 112, 112);
  terrain.rotateX(-Math.PI / 2);
  const positions = terrain.attributes.position as THREE.BufferAttribute;
  const colors: number[] = [];
  const color = new THREE.Color();
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const z = positions.getZ(index);
    const y = terrainHeight(x, z);
    positions.setY(index, y);
    const roadDistance = Math.abs(MAIN_SIDE.x * x + MAIN_SIDE.y * z);
    const roadDust = THREE.MathUtils.smoothstep(roadDistance, 4, 34);
    const variation =
      0.78 +
      Math.sin(x * 0.095 + z * 0.061) * 0.055 +
      Math.cos(z * 0.037) * 0.035;
    color.setRGB(
      (0.64 + roadDust * 0.12) * variation,
      (0.5 + roadDust * 0.08) * variation,
      (0.33 + roadDust * 0.04) * variation,
    );
    colors.push(color.r, color.g, color.b);
  }
  terrain.setAttribute(
    "color",
    new THREE.Float32BufferAttribute(colors, 3),
  );
  terrain.computeVertexNormals();
  const terrainMaterial = materials.sand.clone();
  terrainMaterial.vertexColors = true;
  const terrainMesh = new THREE.Mesh(terrain, terrainMaterial);
  terrainMesh.receiveShadow = true;
  scene.add(terrainMesh);
  staticMeshes.push(terrainMesh);

  addRoad(
    scene,
    colliders,
    staticMeshes,
    materials,
    0,
    0,
    15.5,
    252,
    MAIN_ROAD_ROTATION,
    true,
  );
  const [crossX, crossZ] = axisPoint(0);
  addRoad(
    scene,
    colliders,
    staticMeshes,
    materials,
    crossX,
    crossZ,
    10,
    96,
    MAIN_ROAD_ROTATION + Math.PI / 2,
    false,
  );
  const [depotCrossX, depotCrossZ] = axisPoint(98);
  addRoad(
    scene,
    colliders,
    staticMeshes,
    materials,
    depotCrossX,
    depotCrossZ,
    8,
    78,
    MAIN_ROAD_ROTATION + Math.PI / 2,
    false,
  );

  const buildings: BuildingOptions[] = [
    {
      x: axisPoint(-73, 23)[0],
      z: axisPoint(-73, 23)[1],
      width: 17,
      depth: 13,
      height: 11.5,
      floors: 3,
      rotation: streetFacingRotation(23),
      wall: materials.plasterWarm,
      accent: materials.concreteDark,
      sign: "AL QAMAR",
      awning: 8,
      balcony: true,
    },
    {
      x: axisPoint(-47, -24)[0],
      z: axisPoint(-47, -24)[1],
      width: 20,
      depth: 15,
      height: 14.2,
      floors: 4,
      rotation: streetFacingRotation(-24),
      wall: materials.brick,
      accent: materials.rustedMetal,
      sign: "MERIDIAN",
      damaged: true,
      balcony: true,
    },
    {
      x: axisPoint(-24, 25)[0],
      z: axisPoint(-24, 25)[1],
      width: 18,
      depth: 14,
      height: 9.2,
      floors: 2,
      rotation: streetFacingRotation(25),
      wall: materials.plaster,
      accent: materials.concreteDark,
      sign: "KHARIF CAFE",
      awning: 9,
    },
    {
      x: axisPoint(18, -25)[0],
      z: axisPoint(18, -25)[1],
      width: 22,
      depth: 16,
      height: 16,
      floors: 4,
      rotation: streetFacingRotation(-25),
      wall: materials.concrete,
      accent: materials.rustedMetal,
      sign: "CIVIC EXCHANGE",
      damaged: true,
      balcony: true,
    },
    {
      x: axisPoint(34, 24)[0],
      z: axisPoint(34, 24)[1],
      width: 18,
      depth: 14,
      height: 12.5,
      floors: 3,
      rotation: streetFacingRotation(24),
      wall: materials.brick,
      accent: materials.concreteDark,
      sign: "SOUK 17",
      awning: 8.5,
    },
    {
      x: axisPoint(61, -25)[0],
      z: axisPoint(61, -25)[1],
      width: 21,
      depth: 15,
      height: 10.5,
      floors: 2,
      rotation: streetFacingRotation(-25),
      wall: materials.plasterWarm,
      accent: materials.rustedMetal,
      sign: "FUEL & SUPPLY",
      damaged: true,
    },
    {
      x: axisPoint(84, 25)[0],
      z: axisPoint(84, 25)[1],
      width: 19,
      depth: 14,
      height: 14.8,
      floors: 4,
      rotation: streetFacingRotation(25),
      wall: materials.concrete,
      accent: materials.metalDark,
      balcony: true,
    },
    {
      x: axisPoint(118, -24)[0],
      z: axisPoint(118, -24)[1],
      width: 17,
      depth: 13,
      height: 9,
      floors: 2,
      rotation: streetFacingRotation(-24),
      wall: materials.brick,
      accent: materials.rustedMetal,
      sign: "DEPOT 3",
      awning: 7,
    },
  ];
  buildings.forEach((building) =>
    addBuilding(
      scene,
      colliders,
      staticMeshes,
      materials,
      building,
    ),
  );
  addUrbanInfill(scene, colliders, staticMeshes, materials);

  const [warehouseX, warehouseZ] = axisPoint(-112, -24);
  addOpenWarehouse(
    scene,
    colliders,
    staticMeshes,
    materials,
    warehouseX,
    warehouseZ,
    streetFacingRotation(-24),
  );
  const [warehouseTwoX, warehouseTwoZ] = axisPoint(132, 28);
  addOpenWarehouse(
    scene,
    colliders,
    staticMeshes,
    materials,
    warehouseTwoX,
    warehouseTwoZ,
    streetFacingRotation(28),
  );

  const [towerX, towerZ] = axisPoint(0, 2);
  addRadioTower(
    scene,
    colliders,
    staticMeshes,
    materials,
    towerX,
    towerZ,
  );

  const tankPositions = [
    axisPoint(102, -38),
    axisPoint(115, -39),
    axisPoint(101, -53),
    axisPoint(116, -54),
  ];
  tankPositions.forEach(([x, z], index) =>
    addFuelTank(
      scene,
      colliders,
      staticMeshes,
      materials,
      x,
      z,
      5.2 + (index % 2) * 0.55,
      9.2 + (index % 3) * 0.8,
    ),
  );

  addArcadedMarket(scene, colliders, staticMeshes, materials);
  addMarketStalls(scene, colliders, staticMeshes, materials);
  addStreetDressing(scene, colliders, staticMeshes, materials);

  const barrierPositions: Array<[number, number, number]> = [
    [-128, 0, MAIN_ROAD_ROTATION + 0.18],
    [-91, 5.5, MAIN_ROAD_ROTATION - 0.2],
    [-35, -4.8, MAIN_ROAD_ROTATION + 0.15],
    [28, 5.2, MAIN_ROAD_ROTATION - 0.14],
    [77, -5.2, MAIN_ROAD_ROTATION + 0.18],
    [137, 0.2, MAIN_ROAD_ROTATION - 0.14],
  ];
  barrierPositions.forEach(([distance, offset, rotation]) => {
    const [x, z] = axisPoint(distance, offset);
    addBarrier(scene, colliders, staticMeshes, materials, x, z, rotation);
  });

  const sandbagPositions: Array<[number, number, number, number]> = [
    [-104, 13, MAIN_ROAD_ROTATION, 8],
    [-91, -12, MAIN_ROAD_ROTATION + 0.12, 7],
    [-7, 12, MAIN_ROAD_ROTATION - 0.1, 9],
    [8, -12, MAIN_ROAD_ROTATION + 0.08, 8],
    [97, 12, MAIN_ROAD_ROTATION - 0.08, 9],
    [111, -11, MAIN_ROAD_ROTATION + 0.16, 7],
  ];
  sandbagPositions.forEach(([distance, offset, rotation, length]) => {
    const [x, z] = axisPoint(distance, offset);
    addSandbagWall(
      scene,
      colliders,
      staticMeshes,
      materials,
      x,
      z,
      rotation,
      length,
    );
  });

  const cratePositions = [
    [-115, 11],
    [-110, 16],
    [-82, -15],
    [-4, -14],
    [5, 13],
    [92, -16],
    [106, 14],
    [125, 11],
  ] as const;
  cratePositions.forEach(([distance, offset], index) => {
    const [x, z] = axisPoint(distance, offset);
    addCrate(
      scene,
      colliders,
      staticMeshes,
      materials,
      x,
      z,
      MAIN_ROAD_ROTATION + (index % 3) * 0.18,
      index % 4 === 0,
    );
  });

  const lampPositions: Array<[number, number, boolean]> = [
    [-82, -10, true],
    [-48, 10, false],
    [-16, -10, true],
    [17, 10, false],
    [51, -10, true],
    [84, 10, false],
  ];
  const lampTops: THREE.Vector3[] = [];
  lampPositions.forEach(([distance, offset, lit], index) => {
    const [x, z] = axisPoint(distance, offset);
    addStreetLight(
      scene,
      colliders,
      staticMeshes,
      materials,
      x,
      z,
      MAIN_ROAD_ROTATION + (offset > 0 ? Math.PI : 0),
      lit,
    );
    lampTops.push(
      new THREE.Vector3(x, terrainHeight(x, z) + 8.65, z),
    );
    if (index > 0) {
      addPowerCable(
        scene,
        staticMeshes,
        materials.rubber,
        lampTops[index - 1],
        lampTops[index],
        2.3,
      );
      addPowerCable(
        scene,
        staticMeshes,
        materials.rubber,
        lampTops[index - 1].clone().add(new THREE.Vector3(0, -0.14, 0.12)),
        lampTops[index].clone().add(new THREE.Vector3(0, -0.14, 0.12)),
        2.45,
      );
    }
  });

  addDebrisField(scene, staticMeshes, materials);

  const objectives: ObjectiveState[] = [
    (() => {
      const [x, z] = axisPoint(-103, 0);
      return addObjectiveMarker(
        scene,
        "A",
        "FOB Atlas",
        new THREE.Vector3(x, terrainHeight(x, z), z),
        -1,
      );
    })(),
    (() => {
      const [x, z] = axisPoint(0, 0);
      return addObjectiveMarker(
        scene,
        "B",
        "Relay Station",
        new THREE.Vector3(x, terrainHeight(x, z), z),
        0,
      );
    })(),
    (() => {
      const [x, z] = axisPoint(105, 0);
      return addObjectiveMarker(
        scene,
        "C",
        "Fuel Depot",
        new THREE.Vector3(x, terrainHeight(x, z), z),
        1,
      );
    })(),
  ];

  batchStaticGeometry(scene, colliders, staticMeshes);

  const [blueX, blueZ] = axisPoint(-151, 0);
  const [redX, redZ] = axisPoint(151, 0);
  const [vehicleX, vehicleZ] = axisPoint(-137, -9);
  return {
    colliders,
    staticMeshes,
    objectives,
    blueSpawn: new THREE.Vector3(
      blueX,
      terrainHeight(blueX, blueZ) + 1.7,
      blueZ,
    ),
    redSpawn: new THREE.Vector3(
      redX,
      terrainHeight(redX, redZ) + 1.7,
      redZ,
    ),
    vehicleSpawn: new THREE.Vector3(
      vehicleX,
      terrainHeight(vehicleX, vehicleZ),
      vehicleZ,
    ),
  };
}
