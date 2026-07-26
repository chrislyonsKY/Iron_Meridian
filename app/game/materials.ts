import * as THREE from "three";

export type SurfaceKind =
  | "sand"
  | "concrete"
  | "plaster"
  | "brick"
  | "asphalt"
  | "paintedMetal"
  | "rustedMetal"
  | "wood"
  | "fabric";

interface SurfaceSample {
  color: [number, number, number];
  height: number;
  roughness: number;
  metalness: number;
}

interface SurfaceMaps {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
}

export interface BattlefieldMaterials {
  sand: THREE.MeshStandardMaterial;
  concrete: THREE.MeshStandardMaterial;
  concreteDark: THREE.MeshStandardMaterial;
  plaster: THREE.MeshStandardMaterial;
  plasterWarm: THREE.MeshStandardMaterial;
  brick: THREE.MeshStandardMaterial;
  asphalt: THREE.MeshStandardMaterial;
  roadMarking: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  metalDark: THREE.MeshStandardMaterial;
  rustedMetal: THREE.MeshStandardMaterial;
  wood: THREE.MeshStandardMaterial;
  fabric: THREE.MeshStandardMaterial;
  sandbag: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  windowDark: THREE.MeshStandardMaterial;
  orange: THREE.MeshStandardMaterial;
  rubber: THREE.MeshStandardMaterial;
  foliage: THREE.MeshStandardMaterial;
  emissiveWarm: THREE.MeshStandardMaterial;
}

const TEXTURE_SIZE = 256;

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function smooth(value: number): number {
  return value * value * (3 - 2 * value);
}

function hash(x: number, y: number, seed: number): number {
  let value =
    Math.imul(x ^ (seed * 374761393), 668265263) ^
    Math.imul(y ^ (seed * 1274126177), 2246822519);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicNoise(
  x: number,
  y: number,
  scale: number,
  seed: number,
): number {
  const cells = Math.max(2, Math.round(TEXTURE_SIZE / scale));
  const gx = (x / TEXTURE_SIZE) * cells;
  const gy = (y / TEXTURE_SIZE) * cells;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const tx = smooth(gx - x0);
  const ty = smooth(gy - y0);
  const wrap = (value: number) => ((value % cells) + cells) % cells;
  const a = hash(wrap(x0), wrap(y0), seed);
  const b = hash(wrap(x0 + 1), wrap(y0), seed);
  const c = hash(wrap(x0), wrap(y0 + 1), seed);
  const d = hash(wrap(x0 + 1), wrap(y0 + 1), seed);
  const top = THREE.MathUtils.lerp(a, b, tx);
  const bottom = THREE.MathUtils.lerp(c, d, tx);
  return THREE.MathUtils.lerp(top, bottom, ty);
}

function fbm(x: number, y: number, seed: number): number {
  let value = 0;
  let weight = 0;
  let amplitude = 0.56;
  for (let octave = 0; octave < 5; octave += 1) {
    const scale = 70 / 2 ** octave;
    value += periodicNoise(x, y, scale, seed + octave * 31) * amplitude;
    weight += amplitude;
    amplitude *= 0.5;
  }
  return value / weight;
}

function sampleSurface(
  kind: SurfaceKind,
  x: number,
  y: number,
  seed: number,
): SurfaceSample {
  const fine = periodicNoise(x, y, 3.5, seed + 7);
  const medium = periodicNoise(x, y, 15, seed + 13);
  const broad = periodicNoise(x, y, 62, seed + 23);
  const fractal = fbm(x, y, seed + 41);
  const u = x / TEXTURE_SIZE;
  const v = y / TEXTURE_SIZE;

  if (kind === "brick") {
    const rows = 12;
    const columns = 7;
    const rowFloat = v * rows;
    const row = Math.floor(rowFloat);
    const shiftedU = (u + (row % 2) * 0.5 / columns) * columns;
    const brickU = shiftedU - Math.floor(shiftedU);
    const brickV = rowFloat - row;
    const edge = Math.min(brickU, 1 - brickU, brickV, 1 - brickV);
    const mortar = edge < 0.055;
    const chip = hash(Math.floor(shiftedU), row, seed + 97);
    if (mortar) {
      const mortarNoise = (fine - 0.5) * 17;
      return {
        color: [112 + mortarNoise, 105 + mortarNoise, 92 + mortarNoise],
        height: 0.2 + fine * 0.08,
        roughness: 0.94,
        metalness: 0,
      };
    }
    const soot = Math.max(0, broad - 0.62) * 56;
    const chipShade = chip < 0.08 && edge < 0.16 ? -28 : 0;
    const variation = (medium - 0.5) * 30 + (chip - 0.5) * 16;
    return {
      color: [
        126 + variation - soot + chipShade,
        67 + variation * 0.45 - soot,
        45 + variation * 0.28 - soot,
      ],
      height: 0.58 + fine * 0.17 + Math.min(edge, 0.13) * 1.2,
      roughness: 0.82 + fine * 0.12,
      metalness: 0,
    };
  }

  if (kind === "asphalt") {
    const aggregate = fine > 0.78 ? 25 : fine < 0.15 ? -15 : 0;
    const crackWave =
      Math.abs(
        Math.sin((u * 4.2 + Math.sin(v * 19) * 0.08) * Math.PI * 2),
      ) < 0.025 && broad > 0.54;
    const oil = Math.max(0, medium - 0.7) * 35;
    const base = 48 + (fractal - 0.5) * 22 + aggregate - oil;
    return {
      color: crackWave
        ? [24 + fine * 8, 24 + fine * 8, 23 + fine * 7]
        : [base * 1.03, base, base * 0.94],
      height: crackWave ? 0.15 : 0.46 + fine * 0.24,
      roughness: 0.78 + fine * 0.19 - oil * 0.006,
      metalness: 0,
    };
  }

  if (kind === "sand") {
    const ripple = Math.sin((u * 21 + Math.sin(v * 6) * 0.32) * Math.PI * 2);
    const pebble = fine > 0.88 ? 24 : 0;
    const value = (fractal - 0.5) * 27 + ripple * 4 + pebble;
    return {
      color: [151 + value, 126 + value * 0.78, 88 + value * 0.48],
      height: 0.42 + fractal * 0.35 + ripple * 0.03 + pebble * 0.008,
      roughness: 0.9 + fine * 0.09,
      metalness: 0,
    };
  }

  if (kind === "concrete") {
    const pit = fine < 0.07;
    const streak =
      Math.max(0, Math.sin(u * Math.PI * 10 + broad * 2.2) - 0.94) *
      Math.max(0, v - 0.2);
    const aggregate = fine > 0.83 ? 17 : 0;
    const value = (fractal - 0.5) * 30 + aggregate - streak * 86;
    return {
      color: [
        126 + value,
        122 + value * 0.96,
        111 + value * 0.86,
      ],
      height: pit ? 0.2 : 0.48 + fractal * 0.28 + aggregate * 0.005,
      roughness: 0.78 + medium * 0.18,
      metalness: 0,
    };
  }

  if (kind === "plaster") {
    const hairline =
      Math.abs(
        Math.sin((u * 2.2 + Math.sin(v * 15) * 0.09) * Math.PI * 2),
      ) < 0.018 && broad > 0.55;
    const chipped = medium > 0.76 && fine < 0.24;
    const grime = Math.max(0, broad - 0.62) * 64 + v * 8;
    const value = (fractal - 0.5) * 20 - grime;
    return {
      color: chipped
        ? [91 + value, 83 + value, 71 + value]
        : hairline
          ? [55, 52, 46]
          : [181 + value, 163 + value * 0.86, 131 + value * 0.65],
      height: chipped ? 0.28 : hairline ? 0.18 : 0.61 + fine * 0.14,
      roughness: 0.84 + medium * 0.13,
      metalness: 0,
    };
  }

  if (kind === "paintedMetal" || kind === "rustedMetal") {
    const brushed = Math.sin(v * Math.PI * 120) * 5;
    const scratch =
      Math.abs(Math.sin((u * 14 + medium * 0.4) * Math.PI * 2)) < 0.026;
    const rustField = fbm(x + 37, y + 11, seed + 163);
    const rust =
      kind === "rustedMetal"
        ? THREE.MathUtils.smoothstep(rustField, 0.43, 0.72)
        : THREE.MathUtils.smoothstep(rustField, 0.72, 0.9) * 0.7;
    const paint = [68 + brushed, 79 + brushed, 77 + brushed];
    const rustColor = [119 + fine * 32, 57 + fine * 18, 29 + fine * 11];
    const color: [number, number, number] = [
      THREE.MathUtils.lerp(paint[0], rustColor[0], rust),
      THREE.MathUtils.lerp(paint[1], rustColor[1], rust),
      THREE.MathUtils.lerp(paint[2], rustColor[2], rust),
    ];
    if (scratch) {
      color[0] += 26;
      color[1] += 24;
      color[2] += 20;
    }
    return {
      color,
      height: 0.48 + fine * 0.08 - rust * 0.14 + (scratch ? 0.08 : 0),
      roughness: THREE.MathUtils.lerp(0.37, 0.86, rust),
      metalness: THREE.MathUtils.lerp(0.82, 0.28, rust),
    };
  }

  if (kind === "wood") {
    const knotX = u - 0.72;
    const knotY = v - 0.37;
    const knot = Math.sin(Math.sqrt(knotX * knotX * 11 + knotY * knotY * 28) * 38);
    const grain = Math.sin((u * 19 + medium * 1.3 + knot * 0.08) * Math.PI * 2);
    const value = grain * 12 + (fractal - 0.5) * 18;
    return {
      color: [112 + value, 75 + value * 0.65, 45 + value * 0.36],
      height: 0.48 + grain * 0.08 + fine * 0.13,
      roughness: 0.7 + medium * 0.22,
      metalness: 0,
    };
  }

  const weave =
    Math.sin(u * Math.PI * 128) * Math.sin(v * Math.PI * 128) * 0.5 + 0.5;
  const value = (medium - 0.5) * 18 + weave * 11;
  return {
    color: [92 + value * 0.72, 91 + value * 0.78, 72 + value * 0.54],
    height: 0.42 + weave * 0.22 + fine * 0.08,
    roughness: 0.92 + fine * 0.06,
    metalness: 0,
  };
}

function makeCanvasTexture(
  data: Uint8ClampedArray,
  colorSpace: THREE.ColorSpace,
  repeat: [number, number],
  anisotropy: number,
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;
  const context = canvas.getContext("2d", { alpha: false })!;
  const image = context.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);
  image.data.set(data);
  context.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat[0], repeat[1]);
  texture.colorSpace = colorSpace;
  texture.anisotropy = anisotropy;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function forgeSurface(
  kind: SurfaceKind,
  seed: number,
  repeat: [number, number],
  anisotropy: number,
): SurfaceMaps & { metalness: number } {
  const albedo = new Uint8ClampedArray(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  const height = new Float32Array(TEXTURE_SIZE * TEXTURE_SIZE);
  const roughness = new Uint8ClampedArray(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  let averageMetalness = 0;

  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      const sample = sampleSurface(kind, x, y, seed);
      const index = y * TEXTURE_SIZE + x;
      const offset = index * 4;
      albedo[offset] = clampByte(sample.color[0]);
      albedo[offset + 1] = clampByte(sample.color[1]);
      albedo[offset + 2] = clampByte(sample.color[2]);
      albedo[offset + 3] = 255;
      height[index] = sample.height;
      const rough = clampByte(sample.roughness * 255);
      roughness[offset] = rough;
      roughness[offset + 1] = rough;
      roughness[offset + 2] = rough;
      roughness[offset + 3] = 255;
      averageMetalness += sample.metalness;
    }
  }

  const normal = new Uint8ClampedArray(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  const sampleHeight = (x: number, y: number) =>
    height[
      ((y + TEXTURE_SIZE) % TEXTURE_SIZE) * TEXTURE_SIZE +
        ((x + TEXTURE_SIZE) % TEXTURE_SIZE)
    ];
  const strength =
    kind === "brick"
      ? 5.8
      : kind === "asphalt"
        ? 3.4
        : kind === "sand"
          ? 2.8
          : 4.2;
  const normalVector = new THREE.Vector3();
  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      const dx = sampleHeight(x - 1, y) - sampleHeight(x + 1, y);
      const dy = sampleHeight(x, y - 1) - sampleHeight(x, y + 1);
      normalVector.set(dx * strength, dy * strength, 1).normalize();
      const offset = (y * TEXTURE_SIZE + x) * 4;
      normal[offset] = clampByte((normalVector.x * 0.5 + 0.5) * 255);
      normal[offset + 1] = clampByte((normalVector.y * 0.5 + 0.5) * 255);
      normal[offset + 2] = clampByte((normalVector.z * 0.5 + 0.5) * 255);
      normal[offset + 3] = 255;
    }
  }

  return {
    map: makeCanvasTexture(albedo, THREE.SRGBColorSpace, repeat, anisotropy),
    normalMap: makeCanvasTexture(
      normal,
      THREE.NoColorSpace,
      repeat,
      anisotropy,
    ),
    roughnessMap: makeCanvasTexture(
      roughness,
      THREE.NoColorSpace,
      repeat,
      anisotropy,
    ),
    metalness: averageMetalness / (TEXTURE_SIZE * TEXTURE_SIZE),
  };
}

function surfaceMaterial(
  kind: SurfaceKind,
  seed: number,
  repeat: [number, number],
  anisotropy: number,
  options: {
    color?: number;
    roughness?: number;
    metalness?: number;
    normalScale?: number;
  } = {},
): THREE.MeshStandardMaterial {
  const surface = forgeSurface(kind, seed, repeat, anisotropy);
  return new THREE.MeshStandardMaterial({
    color: options.color ?? 0xffffff,
    map: surface.map,
    normalMap: surface.normalMap,
    normalScale: new THREE.Vector2(
      options.normalScale ?? 0.72,
      options.normalScale ?? 0.72,
    ),
    roughnessMap: surface.roughnessMap,
    roughness: options.roughness ?? 0.92,
    metalness: options.metalness ?? surface.metalness,
    envMapIntensity: kind.includes("Metal") ? 0.9 : 0.42,
  });
}

export function createBattlefieldMaterials(
  renderer: THREE.WebGLRenderer,
): BattlefieldMaterials {
  const anisotropy = Math.min(
    8,
    renderer.capabilities.getMaxAnisotropy(),
  );

  const concrete = surfaceMaterial(
    "concrete",
    219,
    [4, 4],
    anisotropy,
    { normalScale: 0.62 },
  );
  const plaster = surfaceMaterial(
    "plaster",
    773,
    [3, 3],
    anisotropy,
    { normalScale: 0.48 },
  );
  const paintedMetal = surfaceMaterial(
    "paintedMetal",
    991,
    [3, 3],
    anisotropy,
    { metalness: 0.68, roughness: 0.58, normalScale: 0.3 },
  );

  return {
    sand: surfaceMaterial("sand", 431, [26, 26], anisotropy, {
      normalScale: 0.64,
    }),
    concrete,
    concreteDark: concrete.clone(),
    plaster,
    plasterWarm: plaster.clone(),
    brick: surfaceMaterial("brick", 613, [4, 4], anisotropy, {
      normalScale: 0.94,
    }),
    asphalt: surfaceMaterial("asphalt", 717, [22, 22], anisotropy, {
      normalScale: 0.72,
      roughness: 0.94,
    }),
    roadMarking: new THREE.MeshStandardMaterial({
      color: 0xb6aa82,
      roughness: 0.88,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    }),
    metal: paintedMetal,
    metalDark: paintedMetal.clone(),
    rustedMetal: surfaceMaterial(
      "rustedMetal",
      1447,
      [3, 3],
      anisotropy,
      { metalness: 0.42, roughness: 0.78, normalScale: 0.56 },
    ),
    wood: surfaceMaterial("wood", 343, [3, 3], anisotropy, {
      normalScale: 0.5,
    }),
    fabric: surfaceMaterial("fabric", 877, [8, 8], anisotropy, {
      normalScale: 0.4,
    }),
    sandbag: surfaceMaterial("fabric", 1181, [2, 2], anisotropy, {
      color: 0x8d8066,
      normalScale: 0.68,
    }),
    glass: new THREE.MeshPhysicalMaterial({
      color: 0x46636a,
      roughness: 0.2,
      metalness: 0,
      transmission: 0.12,
      transparent: true,
      opacity: 0.72,
      envMapIntensity: 1.3,
      side: THREE.DoubleSide,
    }),
    windowDark: new THREE.MeshStandardMaterial({
      color: 0x101b20,
      roughness: 0.24,
      metalness: 0.18,
      envMapIntensity: 1.15,
    }),
    orange: new THREE.MeshStandardMaterial({
      color: 0xc85e20,
      roughness: 0.58,
      metalness: 0.22,
    }),
    rubber: new THREE.MeshStandardMaterial({
      color: 0x101111,
      roughness: 0.92,
      metalness: 0,
    }),
    foliage: new THREE.MeshStandardMaterial({
      color: 0x48543a,
      roughness: 0.96,
      metalness: 0,
      side: THREE.DoubleSide,
    }),
    emissiveWarm: new THREE.MeshStandardMaterial({
      color: 0x6d4f32,
      emissive: 0xffa45a,
      emissiveIntensity: 2.4,
      roughness: 0.4,
    }),
  };
}

export function tintBattlefieldMaterials(
  materials: BattlefieldMaterials,
): void {
  materials.concreteDark.color.setHex(0x6f716d);
  materials.plasterWarm.color.setHex(0xd1b989);
  materials.metalDark.color.setHex(0x465052);
}
