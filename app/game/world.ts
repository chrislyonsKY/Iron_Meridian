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

const MAP_SIZE = 340;
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
  return [
    MAIN_AXIS.x * distance + MAIN_SIDE.x * sideOffset,
    MAIN_AXIS.y * distance + MAIN_SIDE.y * sideOffset,
  ];
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
        zenith: { value: new THREE.Color(0x17324f) },
        upper: { value: new THREE.Color(0x42647a) },
        horizon: { value: new THREE.Color(0xd5a675) },
        haze: { value: new THREE.Color(0xb58c68) },
        sunDirection: {
          value: new THREE.Vector3(-0.48, 0.46, -0.75).normalize(),
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
          color += vec3(1.0, 0.57, 0.24) * glow * 0.52;
          color += vec3(1.0, 0.91, 0.7) * sun * 7.0;

          vec2 cloudUv = direction.xz / max(0.12, direction.y + 0.34);
          float cloud = noise(cloudUv * 2.1) * 0.62 + noise(cloudUv * 5.3) * 0.38;
          cloud = smoothstep(0.58, 0.75, cloud) * smoothstep(0.07, 0.34, height);
          color = mix(color, vec3(0.83, 0.78, 0.7), cloud * 0.27);

          float horizonDust = exp(-abs(height) * 15.0);
          color = mix(color, vec3(0.61, 0.48, 0.38), horizonDust * 0.34);
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
    [-19, 8, 0.06, 0x735745],
    [-12, 13, -0.16, 0x435b55],
    [11, -10, 0.14, 0x7b643e],
    [18, -5, -0.1, 0x52606d],
  ] as const;
  stalls.forEach(([x, z, rotation, color], stallIndex) => {
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
      x = (random() - 0.5) * 322;
      z = (random() - 0.5) * 322;
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
    const radius = 52 + random() * 110;
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
    330,
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
    126,
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
    102,
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
      rotation: MAIN_ROAD_ROTATION,
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
      rotation: MAIN_ROAD_ROTATION + Math.PI,
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
      rotation: MAIN_ROAD_ROTATION,
      wall: materials.plaster,
      accent: materials.concreteDark,
      sign: "KHARIF CAFE",
      awning: 9,
    },
    {
      x: axisPoint(7, -25)[0],
      z: axisPoint(7, -25)[1],
      width: 22,
      depth: 16,
      height: 16,
      floors: 4,
      rotation: MAIN_ROAD_ROTATION + Math.PI,
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
      rotation: MAIN_ROAD_ROTATION,
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
      rotation: MAIN_ROAD_ROTATION + Math.PI,
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
      rotation: MAIN_ROAD_ROTATION,
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
      rotation: MAIN_ROAD_ROTATION + Math.PI,
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

  const [warehouseX, warehouseZ] = axisPoint(-112, -24);
  addOpenWarehouse(
    scene,
    colliders,
    staticMeshes,
    materials,
    warehouseX,
    warehouseZ,
    MAIN_ROAD_ROTATION + Math.PI,
  );
  const [warehouseTwoX, warehouseTwoZ] = axisPoint(132, 28);
  addOpenWarehouse(
    scene,
    colliders,
    staticMeshes,
    materials,
    warehouseTwoX,
    warehouseTwoZ,
    MAIN_ROAD_ROTATION,
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

  addMarketStalls(scene, colliders, staticMeshes, materials);

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
