import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { BattlefieldAudio } from "./audio";
import {
  CLASS_DEFINITIONS,
  type GameCallbacks,
  type GamePhase,
  type ObjectiveState,
  type SoldierClassDefinition,
  type SoldierClassId,
  type Team,
} from "./types";
import {
  buildWorld,
  MAIN_ROAD_ROTATION,
  terrainHeight,
  type BuiltWorld,
} from "./world";

interface Bot {
  id: number;
  name: string;
  team: Team;
  group: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  muzzle: THREE.Object3D;
  health: number;
  alive: boolean;
  respawnAt: number;
  fireCooldown: number;
  retargetAt: number;
  objectiveIndex: number;
  speed: number;
  stride: number;
  strafe: number;
  target: Bot | "player" | null;
}

interface Vehicle {
  group: THREE.Group;
  turret: THREE.Group;
  wheels: THREE.Mesh[];
  health: number;
  maxHealth: number;
  speed: number;
  yaw: number;
  occupied: boolean;
  fireCooldown: number;
  destroyed: boolean;
  respawnAt: number;
}

interface Grenade {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  fuse: number;
  team: Team;
}

interface Particle {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
  gravity: number;
  grow: number;
}

interface Tracer {
  line: THREE.Line;
  life: number;
}

interface SmokeColumn {
  mesh: THREE.Mesh;
  baseY: number;
  phase: number;
}

interface TouchState {
  move: THREE.Vector2;
  lookPointer: number | null;
  lookX: number;
  lookY: number;
  movePointer: number | null;
}

const PLAYER_HEIGHT = 1.72;
const CROUCH_HEIGHT = 1.12;
const PLAYER_RADIUS = 0.42;
const MAP_BOUNDARY = 153;
const BOT_COUNT_PER_TEAM = 7;
const BLUE = 0x39c4f4;
const RED = 0xff654f;
const NEUTRAL = 0xd9d3c7;

const BOT_NAMES = [
  "Morrow",
  "Vega",
  "Ito",
  "Rook",
  "Bishop",
  "Mills",
  "Hale",
  "Sato",
  "Kane",
  "Reyes",
  "Dunn",
  "Orlov",
  "Park",
  "Nash",
  "Vale",
  "Cross",
];

const CINEMATIC_GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    damage: { value: 0 },
    resolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform float damage;
    uniform vec2 resolution;
    varying vec2 vUv;

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec2 uv = vUv;
      vec2 centered = uv * 2.0 - 1.0;
      float chroma = dot(centered, centered) * 0.00075;
      float red = texture2D(tDiffuse, uv + centered * chroma).r;
      float green = texture2D(tDiffuse, uv).g;
      float blue = texture2D(tDiffuse, uv - centered * chroma).b;
      vec3 color = vec3(red, green, blue);

      float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
      vec3 shadowTint = vec3(0.89, 0.96, 1.03);
      vec3 highlightTint = vec3(1.055, 1.012, 0.945);
      color *= mix(shadowTint, highlightTint, smoothstep(0.12, 0.86, luminance));
      color = (color - 0.5) * 1.055 + 0.5;

      float vignette = smoothstep(1.18, 0.24, length(centered * vec2(0.82, 1.0)));
      color *= mix(0.72, 1.0, vignette);
      float grain = hash12(gl_FragCoord.xy + fract(time) * 913.7) - 0.5;
      color += grain * (0.006 + (1.0 - luminance) * 0.004);
      color = mix(color, color * vec3(0.74, 0.22, 0.16), damage * (0.22 + length(centered) * 0.13));
      gl_FragColor = vec4(color, 1.0);
    }
  `,
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function damp(current: number, target: number, lambda: number, dt: number): number {
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-lambda * dt));
}

export class GameEngine {
  private host: HTMLElement;
  private callbacks: GameCallbacks;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(78, 1, 0.05, 720);
  private viewScene = new THREE.Scene();
  private viewCamera = new THREE.PerspectiveCamera(72, 1, 0.012, 12);
  private composer: EffectComposer;
  private gradePass: ShaderPass;
  private bloomPass: UnrealBloomPass;
  private environmentMap: THREE.Texture | null = null;
  private environmentTarget: THREE.WebGLRenderTarget | null = null;
  private clock = new THREE.Clock();
  private world: BuiltWorld;
  private audio = new BattlefieldAudio();
  private animationFrame = 0;
  private phase: GamePhase = "briefing";
  private touchMode =
    typeof window !== "undefined" &&
    (window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0);

  private keys = new Set<string>();
  private fireHeld = false;
  private adsHeld = false;
  private touch: TouchState = {
    move: new THREE.Vector2(),
    lookPointer: null,
    lookX: 0,
    lookY: 0,
    movePointer: null,
  };
  private cleanup: Array<() => void> = [];

  private playerPosition = new THREE.Vector3();
  private playerVelocity = new THREE.Vector3();
  private yaw = -0.72;
  private pitch = -0.08;
  private grounded = true;
  private crouchAmount = 0;
  private playerHealth = 100;
  private lastDamageAt = -100;
  private currentClass: SoldierClassDefinition = CLASS_DEFINITIONS[0];
  private ammo = this.currentClass.weapon.magazine;
  private reserve = this.currentClass.weapon.reserve;
  private reloadRemaining = 0;
  private fireCooldown = 0;
  private gadgetCooldown = 0;
  private grenadesRemaining = 2;
  private weaponRig = new THREE.Group();
  private weaponKick = 0;
  private muzzleFlash: THREE.PointLight;
  private weaponMuzzle = new THREE.Object3D();
  private muzzleBurst = new THREE.Group();
  private weaponFlashTimer = 0;
  private cameraImpulse = 0;
  private bobTime = 0;
  private stepDistance = 0;
  private inVehicle = false;

  private bots: Bot[] = [];
  private vehicle: Vehicle;
  private grenades: Grenade[] = [];
  private particles: Particle[] = [];
  private tracers: Tracer[] = [];
  private decals: THREE.Mesh[] = [];
  private smokeColumns: SmokeColumn[] = [];
  private raycaster = new THREE.Raycaster();
  private tickets = { blue: 250, red: 250 };
  private ticketClock = 0;
  private elapsed = 0;
  private kills = 0;
  private deaths = 0;
  private objectiveNoticeCooldown = 0;
  private sensorRemaining = 0;
  private minimapClock = 0;
  private hudClock = 0;
  private interactLatch = false;
  private grenadeLatch = false;
  private gadgetLatch = false;
  private jumpLatch = false;
  private menuOrbit = 0;
  private randomState = 0x7a3f29d1;
  private damageDirection = 0;
  private flashTimer = 0;

  private tempA = new THREE.Vector3();
  private tempB = new THREE.Vector3();
  private tempC = new THREE.Vector3();
  private tempBox = new THREE.Box3();

  constructor(host: HTMLElement, callbacks: GameCallbacks) {
    this.host = host;
    this.callbacks = callbacks;
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
      alpha: false,
      logarithmicDepthBuffer: false,
    });
    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio, this.touchMode ? 1.2 : 1.55),
    );
    this.renderer.shadowMap.enabled = !this.touchMode;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.04;
    this.renderer.autoClear = false;
    this.renderer.domElement.className = "game-canvas";
    this.renderer.domElement.setAttribute(
      "aria-label",
      "Interactive three-dimensional battlefield",
    );
    this.renderer.domElement.setAttribute("tabindex", "0");
    this.host.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x17283a);
    this.scene.fog = new THREE.FogExp2(
      0xa1876d,
      this.touchMode ? 0.0068 : 0.00455,
    );
    this.camera.rotation.order = "YXZ";
    this.scene.add(this.camera);
    this.viewScene.add(this.viewCamera);
    this.viewCamera.add(this.weaponRig);

    const hemisphere = new THREE.HemisphereLight(0xbdd8ec, 0x4b392f, 1.18);
    this.scene.add(hemisphere);
    const sun = new THREE.DirectionalLight(0xffd5a2, 4.05);
    sun.position.set(-92, 112, -105);
    sun.castShadow = !this.touchMode;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -150;
    sun.shadow.camera.right = 150;
    sun.shadow.camera.top = 150;
    sun.shadow.camera.bottom = -150;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 360;
    sun.shadow.bias = -0.00012;
    sun.shadow.normalBias = 0.034;
    sun.shadow.radius = 2;
    sun.shadow.blurSamples = 12;
    this.scene.add(sun);
    const warmFill = new THREE.DirectionalLight(0xe39b63, 0.46);
    warmFill.position.set(90, 24, 80);
    this.scene.add(warmFill);
    const coolRim = new THREE.DirectionalLight(0x92b7cf, 0.38);
    coolRim.position.set(34, 42, -90);
    this.scene.add(coolRim);

    this.environmentMap = this.createEnvironmentMap();
    this.scene.environment = this.environmentMap;
    this.viewScene.environment = this.environmentMap;
    this.world = buildWorld(this.scene, this.renderer);

    const viewKey = new THREE.DirectionalLight(0xffd8b0, 3.2);
    viewKey.position.set(-2.5, 4.4, 3);
    this.viewScene.add(viewKey);
    const viewFill = new THREE.DirectionalLight(0x91bed7, 1.35);
    viewFill.position.set(3.5, 1.2, 1.5);
    this.viewScene.add(viewFill);
    const viewAmbient = new THREE.HemisphereLight(0xc6dceb, 0x3b302b, 1.6);
    this.viewScene.add(viewAmbient);

    const renderTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
    });
    renderTarget.samples = this.touchMode ? 0 : 2;
    this.composer = new EffectComposer(this.renderer, renderTarget);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(1, 1),
      this.touchMode ? 0.13 : 0.25,
      0.48,
      0.76,
    );
    this.composer.addPass(this.bloomPass);
    this.gradePass = new ShaderPass(CINEMATIC_GRADE_SHADER);
    this.composer.addPass(this.gradePass);
    this.composer.addPass(new OutputPass());

    this.muzzleFlash = new THREE.PointLight(0xff9f4b, 0, 4.2, 2);
    this.muzzleFlash.position.set(0, 0, -1.18);
    this.weaponRig.add(this.muzzleFlash);
    this.createWeapon();
    this.vehicle = this.createVehicle();
    this.createBots();
    this.createAmbientSmoke();
    this.bindInput();
    this.resize();
    this.callbacks.onPhase("briefing");
    this.animate();
  }

  private createEnvironmentMap(): THREE.Texture {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 256;
    const context = canvas.getContext("2d")!;
    const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, "#193651");
    gradient.addColorStop(0.46, "#607f8d");
    gradient.addColorStop(0.57, "#d8a978");
    gradient.addColorStop(0.68, "#80624c");
    gradient.addColorStop(1, "#302a26");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);

    const sun = context.createRadialGradient(378, 112, 1, 378, 112, 62);
    sun.addColorStop(0, "rgba(255,247,215,1)");
    sun.addColorStop(0.08, "rgba(255,212,151,.92)");
    sun.addColorStop(0.34, "rgba(246,151,81,.25)");
    sun.addColorStop(1, "rgba(246,151,81,0)");
    context.fillStyle = sun;
    context.fillRect(0, 0, canvas.width, canvas.height);

    const texture = new THREE.CanvasTexture(canvas);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    this.environmentTarget = pmrem.fromEquirectangular(texture);
    texture.dispose();
    pmrem.dispose();
    return this.environmentTarget.texture;
  }

  deploy(classId: SoldierClassId): void {
    const selected = CLASS_DEFINITIONS.find((entry) => entry.id === classId);
    if (selected) this.currentClass = selected;
    this.rebuildWeapon();
    this.playerHealth = 100;
    this.ammo = this.currentClass.weapon.magazine;
    this.reserve = this.currentClass.weapon.reserve;
    this.grenadesRemaining = 2;
    this.reloadRemaining = 0;
    this.gadgetCooldown = 0;
    this.playerVelocity.set(0, 0, 0);
    this.inVehicle = false;
    this.vehicle.occupied = false;
    this.weaponRig.visible = true;

    const spawn = this.getForwardSpawn();
    this.playerPosition.copy(spawn);
    // Three.js cameras face local -Z. Aim the deployment view from the
    // selected spawn toward the center of the battlefield.
    this.yaw = Math.atan2(spawn.x, spawn.z);
    this.pitch = -0.03;
    this.phase = "playing";
    this.callbacks.onPhase("playing");
    this.callbacks.onNotice("DEPLOYED", `${this.currentClass.name} · ${this.currentClass.weapon.shortName}`);
    void this.audio.unlock();
    if (!this.touchMode) {
      void this.renderer.domElement.requestPointerLock();
    }
    this.updateHud(true);
  }

  resume(): void {
    if (this.phase !== "paused") return;
    this.phase = "playing";
    this.callbacks.onPhase("playing");
    void this.audio.unlock();
    if (!this.touchMode) void this.renderer.domElement.requestPointerLock();
  }

  restart(classId: SoldierClassId): void {
    this.tickets.blue = 250;
    this.tickets.red = 250;
    this.ticketClock = 0;
    this.elapsed = 0;
    this.kills = 0;
    this.deaths = 0;
    const captures = [-1, 0, 1];
    this.world.objectives.forEach((objective, index) => {
      objective.capture = captures[index];
      objective.owner =
        captures[index] < -0.8
          ? "blue"
          : captures[index] > 0.8
            ? "red"
            : "neutral";
      objective.previousOwner = objective.owner;
      this.updateObjectiveVisual(objective);
    });
    this.bots.forEach((bot, index) => this.respawnBot(bot, index < BOT_COUNT_PER_TEAM));
    this.resetVehicle();
    this.deploy(classId);
  }

  toggleAudio(enabled: boolean): void {
    this.audio.setEnabled(enabled);
  }

  dispose(): void {
    cancelAnimationFrame(this.animationFrame);
    this.cleanup.forEach((dispose) => dispose());
    this.audio.dispose();
    this.composer.dispose();
    this.environmentTarget?.dispose();
    this.environmentMap = null;
    const disposedTextures = new Set<THREE.Texture>();
    const disposedMaterials = new Set<THREE.Material>();
    const disposeRoot = (root: THREE.Object3D) => {
      root.traverse((object) => {
        if (
          object instanceof THREE.Mesh ||
          object instanceof THREE.Line ||
          object instanceof THREE.Sprite
        ) {
          object.geometry?.dispose();
          const materials = Array.isArray(object.material)
            ? object.material
            : [object.material];
          materials.forEach((material) => {
            if (!material || disposedMaterials.has(material)) return;
            disposedMaterials.add(material);
            const candidate = material as THREE.MeshStandardMaterial;
            [
              candidate.map,
              candidate.normalMap,
              candidate.roughnessMap,
              candidate.metalnessMap,
              candidate.aoMap,
              candidate.emissiveMap,
              candidate.alphaMap,
              candidate.bumpMap,
            ].forEach((texture) => {
              if (texture && !disposedTextures.has(texture)) {
                disposedTextures.add(texture);
                texture.dispose();
              }
            });
            material.dispose();
          });
        }
      });
    };
    disposeRoot(this.scene);
    disposeRoot(this.viewScene);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private random(): number {
    this.randomState = (this.randomState * 1664525 + 1013904223) >>> 0;
    return this.randomState / 4294967296;
  }

  private bindInput(): void {
    const onResize = () => this.resize();
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        this.phase === "playing" &&
        ["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(
          event.code,
        )
      ) {
        event.preventDefault();
      }
      this.keys.add(event.code);
      if (event.code === "KeyR") this.startReload();
    };
    const onKeyUp = (event: KeyboardEvent) => this.keys.delete(event.code);
    const onPointerMove = (event: PointerEvent) => {
      if (
        !this.touchMode &&
        document.pointerLockElement === this.renderer.domElement &&
        this.phase === "playing"
      ) {
        this.applyLook(event.movementX, event.movementY, 0.0021);
      } else if (
        this.touchMode &&
        this.touch.lookPointer === event.pointerId &&
        this.phase === "playing"
      ) {
        const dx = event.clientX - this.touch.lookX;
        const dy = event.clientY - this.touch.lookY;
        this.touch.lookX = event.clientX;
        this.touch.lookY = event.clientY;
        this.applyLook(dx, dy, 0.0042);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (this.phase !== "playing") return;
      if (event.pointerType === "touch") {
        if ((event.target as HTMLElement).closest(".touch-control")) return;
        this.touch.lookPointer = event.pointerId;
        this.touch.lookX = event.clientX;
        this.touch.lookY = event.clientY;
        this.renderer.domElement.setPointerCapture(event.pointerId);
        return;
      }
      if (document.pointerLockElement !== this.renderer.domElement) {
        void this.renderer.domElement.requestPointerLock();
        return;
      }
      if (event.button === 0) {
        this.fireHeld = true;
        this.tryFire();
      }
      if (event.button === 2) this.adsHeld = true;
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerType === "touch" && this.touch.lookPointer === event.pointerId) {
        this.touch.lookPointer = null;
      }
      if (event.button === 0) this.fireHeld = false;
      if (event.button === 2) this.adsHeld = false;
    };
    const onPointerLock = () => {
      if (
        !this.touchMode &&
        !document.pointerLockElement &&
        this.phase === "playing"
      ) {
        this.phase = "paused";
        this.fireHeld = false;
        this.adsHeld = false;
        this.callbacks.onPhase("paused");
      }
    };
    const onContext = (event: MouseEvent) => event.preventDefault();

    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", onKeyDown, { passive: false });
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointerlockchange", onPointerLock);
    this.renderer.domElement.addEventListener("pointerdown", onPointerDown);
    this.renderer.domElement.addEventListener("contextmenu", onContext);
    this.cleanup.push(
      () => window.removeEventListener("resize", onResize),
      () => window.removeEventListener("keydown", onKeyDown),
      () => window.removeEventListener("keyup", onKeyUp),
      () => window.removeEventListener("pointermove", onPointerMove),
      () => window.removeEventListener("pointerup", onPointerUp),
      () => document.removeEventListener("pointerlockchange", onPointerLock),
      () => this.renderer.domElement.removeEventListener("pointerdown", onPointerDown),
      () => this.renderer.domElement.removeEventListener("contextmenu", onContext),
    );

    this.bindTouchControls();
  }

  private bindTouchControls(): void {
    const pad = document.getElementById("move-pad");
    const nub = document.getElementById("move-nub");
    if (pad && nub) {
      const updatePad = (event: PointerEvent) => {
        const rect = pad.getBoundingClientRect();
        const x = event.clientX - (rect.left + rect.width / 2);
        const y = event.clientY - (rect.top + rect.height / 2);
        const radius = rect.width * 0.34;
        const length = Math.max(1, Math.hypot(x, y));
        const scale = Math.min(1, radius / length);
        const px = x * scale;
        const py = y * scale;
        nub.style.transform = `translate(${px}px, ${py}px)`;
        this.touch.move.set(px / radius, -py / radius);
      };
      const down = (event: PointerEvent) => {
        this.touch.movePointer = event.pointerId;
        pad.setPointerCapture(event.pointerId);
        updatePad(event);
      };
      const move = (event: PointerEvent) => {
        if (this.touch.movePointer === event.pointerId) updatePad(event);
      };
      const up = (event: PointerEvent) => {
        if (this.touch.movePointer !== event.pointerId) return;
        this.touch.movePointer = null;
        this.touch.move.set(0, 0);
        nub.style.transform = "translate(0px, 0px)";
      };
      pad.addEventListener("pointerdown", down);
      pad.addEventListener("pointermove", move);
      pad.addEventListener("pointerup", up);
      pad.addEventListener("pointercancel", up);
      this.cleanup.push(
        () => pad.removeEventListener("pointerdown", down),
        () => pad.removeEventListener("pointermove", move),
        () => pad.removeEventListener("pointerup", up),
        () => pad.removeEventListener("pointercancel", up),
      );
    }

    const bindHold = (
      id: string,
      onDown: () => void,
      onUp: () => void,
    ) => {
      const element = document.getElementById(id);
      if (!element) return;
      const down = (event: PointerEvent) => {
        event.preventDefault();
        element.setPointerCapture(event.pointerId);
        onDown();
      };
      const up = (event: PointerEvent) => {
        event.preventDefault();
        onUp();
      };
      element.addEventListener("pointerdown", down);
      element.addEventListener("pointerup", up);
      element.addEventListener("pointercancel", up);
      this.cleanup.push(
        () => element.removeEventListener("pointerdown", down),
        () => element.removeEventListener("pointerup", up),
        () => element.removeEventListener("pointercancel", up),
      );
    };
    bindHold(
      "touch-fire",
      () => {
        this.fireHeld = true;
        this.tryFire();
      },
      () => {
        this.fireHeld = false;
      },
    );
    bindHold(
      "touch-ads",
      () => {
        this.adsHeld = true;
      },
      () => {
        this.adsHeld = false;
      },
    );
    bindHold(
      "touch-jump",
      () => {
        this.keys.add("Space");
        window.setTimeout(() => this.keys.delete("Space"), 100);
      },
      () => undefined,
    );
    bindHold(
      "touch-reload",
      () => this.startReload(),
      () => undefined,
    );
    bindHold(
      "touch-use",
      () => {
        this.keys.add("KeyE");
        window.setTimeout(() => this.keys.delete("KeyE"), 110);
      },
      () => undefined,
    );
    bindHold(
      "touch-gadget",
      () => {
        this.keys.add("KeyQ");
        window.setTimeout(() => this.keys.delete("KeyQ"), 110);
      },
      () => undefined,
    );
  }

  private applyLook(dx: number, dy: number, sensitivity: number): void {
    this.yaw -= dx * sensitivity;
    this.pitch = clamp(this.pitch - dy * sensitivity, -1.38, 1.32);
  }

  private resize(): void {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.viewCamera.aspect = width / height;
    this.viewCamera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
    this.gradePass.uniforms.resolution.value.set(width, height);
  }

  private animate = (): void => {
    this.animationFrame = requestAnimationFrame(this.animate);
    const dt = Math.min(0.04, this.clock.getDelta());
    if (this.phase === "playing") {
      this.elapsed += dt;
      this.updateGame(dt);
    } else if (this.phase === "briefing") {
      this.updateMenuCamera(dt);
      this.updateAmbient(dt);
    } else {
      this.updateParticles(dt);
      this.updateAmbient(dt);
    }
    this.gradePass.uniforms.time.value = this.elapsed + this.menuOrbit * 12;
    this.gradePass.uniforms.damage.value = damp(
      this.gradePass.uniforms.damage.value,
      this.flashTimer > 0 ? 1 : 0,
      8,
      dt,
    );
    this.renderer.clear();
    this.composer.render(dt);
    if (this.weaponRig.visible) {
      this.renderer.clearDepth();
      this.renderer.render(this.viewScene, this.viewCamera);
    }
  };

  private updateGame(dt: number): void {
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.gadgetCooldown = Math.max(0, this.gadgetCooldown - dt);
    this.objectiveNoticeCooldown = Math.max(0, this.objectiveNoticeCooldown - dt);
    this.sensorRemaining = Math.max(0, this.sensorRemaining - dt);
    this.flashTimer = Math.max(0, this.flashTimer - dt);

    if (this.reloadRemaining > 0) {
      this.reloadRemaining -= dt;
      if (this.reloadRemaining <= 0) {
        const needed = this.currentClass.weapon.magazine - this.ammo;
        const loaded = Math.min(needed, this.reserve);
        this.ammo += loaded;
        this.reserve -= loaded;
        this.callbacks.onNotice("RELOADED", `${this.ammo} rounds ready`);
      }
    }

    this.handleActionKeys();
    if (this.inVehicle) this.updateVehicle(dt);
    else this.updatePlayer(dt);

    if (
      this.fireHeld &&
      this.currentClass.weapon.automatic &&
      this.reloadRemaining <= 0
    ) {
      this.tryFire();
    }

    if (this.playerHealth < 100 && this.elapsed - this.lastDamageAt > 5) {
      this.playerHealth = Math.min(100, this.playerHealth + dt * 7);
    }

    this.updateWeapon(dt);
    this.updateBots(dt);
    this.updateGrenades(dt);
    this.updateParticles(dt);
    this.updateObjectives(dt);
    this.updateTickets(dt);
    this.updateAmbient(dt);
    this.updateInteractionHint();
    this.updateHud(false);
  }

  private handleActionKeys(): void {
    const use = this.keys.has("KeyE");
    if (use && !this.interactLatch) {
      this.interactLatch = true;
      this.useVehicle();
    }
    if (!use) this.interactLatch = false;

    const grenade = this.keys.has("KeyG");
    if (grenade && !this.grenadeLatch) {
      this.grenadeLatch = true;
      this.throwGrenade();
    }
    if (!grenade) this.grenadeLatch = false;

    const gadget = this.keys.has("KeyQ");
    if (gadget && !this.gadgetLatch) {
      this.gadgetLatch = true;
      this.useGadget();
    }
    if (!gadget) this.gadgetLatch = false;

    const jump = this.keys.has("Space");
    if (jump && !this.jumpLatch && this.grounded && !this.inVehicle) {
      this.playerVelocity.y = 6.2;
      this.grounded = false;
    }
    this.jumpLatch = jump;
  }

  private updateMenuCamera(dt: number): void {
    this.menuOrbit += dt * 0.075;
    const radius = 104;
    this.camera.position.set(
      Math.cos(this.menuOrbit) * radius,
      43 + Math.sin(this.menuOrbit * 1.7) * 5,
      Math.sin(this.menuOrbit) * radius,
    );
    this.camera.lookAt(0, 4, 0);
    this.weaponRig.visible = false;
  }

  private updatePlayer(dt: number): void {
    const crouching = this.keys.has("ControlLeft") || this.keys.has("KeyC");
    this.crouchAmount = damp(this.crouchAmount, crouching ? 1 : 0, 12, dt);
    const eyeHeight = THREE.MathUtils.lerp(
      PLAYER_HEIGHT,
      CROUCH_HEIGHT,
      this.crouchAmount,
    );

    const inputX =
      (this.keys.has("KeyD") ? 1 : 0) -
      (this.keys.has("KeyA") ? 1 : 0) +
      this.touch.move.x;
    const inputZ =
      (this.keys.has("KeyW") ? 1 : 0) -
      (this.keys.has("KeyS") ? 1 : 0) +
      this.touch.move.y;
    const inputLength = Math.hypot(inputX, inputZ);
    const sprinting =
      (this.keys.has("ShiftLeft") || this.touch.move.y > 0.84) &&
      inputZ > 0.2 &&
      !this.adsHeld &&
      !crouching;
    const speed = crouching ? 2.5 : sprinting ? 8.5 : this.adsHeld ? 3.35 : 5.25;

    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    // Camera-local forward is -Z and camera-local right is +X. Keep these
    // basis vectors explicit so forward/strafe input cannot drift out of
    // alignment with the direction the player is looking.
    const forwardX = -sin;
    const forwardZ = -cos;
    const rightX = cos;
    const rightZ = -sin;
    const desiredX =
      inputLength > 0
        ? ((inputX / inputLength) * rightX +
            (inputZ / inputLength) * forwardX) *
          speed
        : 0;
    const desiredZ =
      inputLength > 0
        ? ((inputX / inputLength) * rightZ +
            (inputZ / inputLength) * forwardZ) *
          speed
        : 0;
    this.playerVelocity.x = damp(this.playerVelocity.x, desiredX, groundedLambda(this.grounded), dt);
    this.playerVelocity.z = damp(this.playerVelocity.z, desiredZ, groundedLambda(this.grounded), dt);
    this.playerVelocity.y -= 17.5 * dt;

    const horizontal = this.tempA.set(
      this.playerVelocity.x * dt,
      0,
      this.playerVelocity.z * dt,
    );
    this.movePlayerHorizontal(horizontal, eyeHeight);
    this.playerPosition.y += this.playerVelocity.y * dt;
    const ground = terrainHeight(this.playerPosition.x, this.playerPosition.z) + eyeHeight;
    if (this.playerPosition.y <= ground) {
      if (!this.grounded && this.playerVelocity.y < -6) {
        this.camera.position.y -= 0.08;
      }
      this.playerPosition.y = ground;
      this.playerVelocity.y = 0;
      this.grounded = true;
    }

    const horizontalSpeed = Math.hypot(this.playerVelocity.x, this.playerVelocity.z);
    if (this.grounded && horizontalSpeed > 0.5) {
      this.bobTime += dt * (sprinting ? 12.5 : crouching ? 5 : 8.2);
      this.stepDistance += horizontalSpeed * dt;
      const interval = sprinting ? 2.35 : crouching ? 3.5 : 2.8;
      if (this.stepDistance > interval) {
        this.stepDistance = 0;
        this.audio.footstep(sprinting);
      }
    }

    this.camera.position.copy(this.playerPosition);
    const bob = this.grounded ? Math.sin(this.bobTime * 2) * 0.014 * Math.min(1, horizontalSpeed / 4) : 0;
    this.camera.position.y += bob;
    this.camera.rotation.set(
      this.pitch + this.cameraImpulse * 0.012,
      this.yaw,
      Math.sin(this.bobTime) *
        0.004 *
        Math.min(1, horizontalSpeed / 4) +
        this.cameraImpulse * 0.003,
    );

    const targetFov = this.adsHeld ? 57 : sprinting ? 83 : 76;
    this.camera.fov = damp(this.camera.fov, targetFov, 10, dt);
    this.camera.updateProjectionMatrix();
  }

  private movePlayerHorizontal(delta: THREE.Vector3, eyeHeight: number): void {
    const nextX = clamp(this.playerPosition.x + delta.x, -MAP_BOUNDARY, MAP_BOUNDARY);
    if (!this.playerCollides(nextX, this.playerPosition.z, eyeHeight)) {
      this.playerPosition.x = nextX;
    } else {
      this.playerVelocity.x = 0;
    }
    const nextZ = clamp(this.playerPosition.z + delta.z, -MAP_BOUNDARY, MAP_BOUNDARY);
    if (!this.playerCollides(this.playerPosition.x, nextZ, eyeHeight)) {
      this.playerPosition.z = nextZ;
    } else {
      this.playerVelocity.z = 0;
    }
  }

  private playerCollides(x: number, z: number, eyeHeight: number): boolean {
    const bottom = terrainHeight(x, z);
    const top = bottom + eyeHeight;
    for (const collider of this.world.colliders) {
      const box = collider.box;
      if (
        x > box.min.x - PLAYER_RADIUS &&
        x < box.max.x + PLAYER_RADIUS &&
        z > box.min.z - PLAYER_RADIUS &&
        z < box.max.z + PLAYER_RADIUS &&
        top > box.min.y + 0.08 &&
        bottom < box.max.y
      ) {
        return true;
      }
    }
    return false;
  }

  private createWeapon(): void {
    const weapon = this.currentClass.weapon;
    const marksman = weapon.shortName === "S-14";
    const support = this.currentClass.id === "medic";
    const compact = this.currentClass.id === "engineer";
    const receiverLength = marksman ? 0.76 : support ? 0.71 : compact ? 0.5 : 0.62;
    const handguardLength = marksman ? 0.66 : support ? 0.61 : compact ? 0.39 : 0.54;
    const barrelLength = marksman ? 0.72 : support ? 0.58 : compact ? 0.34 : 0.48;

    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#a1a59e";
    context.fillRect(0, 0, 256, 256);
    let textureState =
      (weapon.color ^ (weapon.magazine * 2654435761)) >>> 0;
    const textureRandom = () => {
      textureState =
        (textureState * 1664525 + 1013904223) >>> 0;
      return textureState / 4294967296;
    };
    for (let index = 0; index < 720; index += 1) {
      const x = textureRandom() * 256;
      const y = textureRandom() * 256;
      const length = 2 + textureRandom() * 24;
      context.strokeStyle =
        textureRandom() > 0.5
          ? `rgba(236,240,232,${0.025 + textureRandom() * 0.08})`
          : `rgba(0,0,0,${0.025 + textureRandom() * 0.08})`;
      context.lineWidth = 0.4 + textureRandom();
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x + length, y + (textureRandom() - 0.5) * 2);
      context.stroke();
    }
    context.fillStyle = "rgba(15,18,18,.22)";
    for (let y = 0; y < 256; y += 32) {
      context.fillRect(0, y, 256, 1);
    }
    const weaponTexture = new THREE.CanvasTexture(canvas);
    weaponTexture.wrapS = weaponTexture.wrapT = THREE.RepeatWrapping;
    weaponTexture.repeat.set(2.2, 2.2);
    weaponTexture.colorSpace = THREE.SRGBColorSpace;
    weaponTexture.anisotropy = Math.min(
      8,
      this.renderer.capabilities.getMaxAnisotropy(),
    );

    const weaponAlbedo = new THREE.Color(weapon.color).lerp(
      new THREE.Color(0x858b84),
      0.44,
    );
    const metal = new THREE.MeshStandardMaterial({
      color: weaponAlbedo,
      map: weaponTexture,
      bumpMap: weaponTexture,
      bumpScale: 0.008,
      metalness: 0.66,
      roughness: 0.4,
      envMapIntensity: 1.15,
    });
    const exposedMetal = new THREE.MeshStandardMaterial({
      color: 0x2c3233,
      metalness: 0.86,
      roughness: 0.26,
      envMapIntensity: 1.35,
    });
    const dark = new THREE.MeshStandardMaterial({
      color: 0x111718,
      metalness: 0.6,
      roughness: 0.38,
      envMapIntensity: 1.1,
    });
    const polymer = new THREE.MeshStandardMaterial({
      color: 0x252a28,
      metalness: 0.04,
      roughness: 0.64,
      envMapIntensity: 0.58,
    });
    const glove = new THREE.MeshStandardMaterial({
      color: 0x514f42,
      roughness: 0.94,
      metalness: 0,
    });
    const fabric = new THREE.MeshStandardMaterial({
      color: 0x4c594d,
      roughness: 0.97,
      metalness: 0,
    });
    const glass = new THREE.MeshPhysicalMaterial({
      color: 0x7ad2e2,
      roughness: 0.06,
      transmission: 0.22,
      transparent: true,
      opacity: 0.7,
      emissive: 0x143d46,
      emissiveIntensity: 0.5,
      side: THREE.DoubleSide,
    });
    const marking = new THREE.MeshBasicMaterial({
      color: 0xd4c7a4,
      transparent: true,
      opacity: 0.72,
      side: THREE.DoubleSide,
    });

    const addPart = (
      geometry: THREE.BufferGeometry,
      material: THREE.Material,
      position: [number, number, number],
      rotation: [number, number, number] = [0, 0, 0],
      name?: string,
    ) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(...position);
      mesh.rotation.set(...rotation);
      if (name) mesh.name = name;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.weaponRig.add(mesh);
      return mesh;
    };

    addPart(
      new RoundedBoxGeometry(0.18, 0.18, receiverLength, 3, 0.022),
      metal,
      [0, 0, -0.22],
    );
    addPart(
      new RoundedBoxGeometry(
        0.145,
        0.12,
        receiverLength * 0.92,
        3,
        0.018,
      ),
      dark,
      [0, 0.115, -0.235],
    );
    addPart(
      new RoundedBoxGeometry(
        0.155,
        0.155,
        handguardLength,
        3,
        0.025,
      ),
      polymer,
      [0, -0.005, -0.22 - receiverLength / 2 - handguardLength / 2 + 0.025],
    );

    const handguardCenter =
      -0.22 - receiverLength / 2 - handguardLength / 2 + 0.025;
    const railLength = receiverLength + handguardLength * 0.82;
    addPart(
      new THREE.BoxGeometry(0.105, 0.025, railLength),
      exposedMetal,
      [0, 0.205, -0.22 - handguardLength * 0.34],
    );
    const railSegments = 13;
    for (let index = 0; index < railSegments; index += 1) {
      addPart(
        new THREE.BoxGeometry(0.142, 0.018, 0.035),
        exposedMetal,
        [
          0,
          0.223,
          -0.22 -
            handguardLength * 0.34 -
            railLength / 2 +
            ((index + 0.5) * railLength) / railSegments,
        ],
      );
    }
    for (const side of [-1, 1]) {
      for (let index = 0; index < 5; index += 1) {
        addPart(
          new RoundedBoxGeometry(0.008, 0.035, 0.075, 2, 0.008),
          dark,
          [
            side * 0.081,
            0.025,
            handguardCenter -
              handguardLength * 0.34 +
              index * (handguardLength * 0.15),
          ],
          [0, 0, side * 0.08],
        );
      }
    }

    const barrelCenter =
      handguardCenter - handguardLength / 2 - barrelLength / 2 + 0.02;
    addPart(
      new THREE.CylinderGeometry(0.023, 0.029, barrelLength, 14),
      exposedMetal,
      [0, 0.018, barrelCenter],
      [Math.PI / 2, 0, 0],
    );
    addPart(
      new THREE.CylinderGeometry(0.047, 0.045, 0.13, 12),
      dark,
      [0, 0.018, barrelCenter - barrelLength / 2 + 0.045],
      [Math.PI / 2, 0, 0],
    );
    const muzzleZ = barrelCenter - barrelLength / 2 - 0.055;
    addPart(
      new THREE.CylinderGeometry(0.04, 0.045, 0.13, 12),
      exposedMetal,
      [0, 0.018, muzzleZ],
      [Math.PI / 2, 0, 0],
    );
    for (const side of [-1, 1]) {
      addPart(
        new THREE.BoxGeometry(0.018, 0.026, 0.055),
        dark,
        [side * 0.04, 0.018, muzzleZ - 0.018],
      );
    }

    addPart(
      new RoundedBoxGeometry(0.12, 0.22, 0.14, 3, 0.025),
      polymer,
      [0, -0.205, -0.08],
      [-0.19, 0, 0],
    );
    addPart(
      new THREE.TorusGeometry(0.061, 0.009, 7, 18, Math.PI * 1.42),
      exposedMetal,
      [0, -0.13, -0.02],
      [Math.PI / 2, 0, -0.65],
    );
    addPart(
      new THREE.BoxGeometry(0.012, 0.085, 0.018),
      exposedMetal,
      [0, -0.13, -0.045],
      [0.28, 0, 0],
    );

    const magazineDepth = support ? 0.28 : marksman ? 0.22 : 0.2;
    addPart(
      new RoundedBoxGeometry(
        support ? 0.18 : 0.115,
        support ? 0.3 : 0.285,
        magazineDepth,
        3,
        0.025,
      ),
      polymer,
      [0, -0.225, -0.27],
      [-0.13, 0, 0],
      "magazine",
    );
    if (support) {
      addPart(
        new THREE.CylinderGeometry(0.16, 0.16, 0.19, 16),
        polymer,
        [0, -0.225, -0.32],
        [0, 0, Math.PI / 2],
      );
    }

    addPart(
      new RoundedBoxGeometry(0.12, 0.12, 0.34, 3, 0.022),
      polymer,
      [0, 0.015, 0.27],
      [0.015, 0, 0],
    );
    for (const side of [-1, 1]) {
      addPart(
        new THREE.CylinderGeometry(0.015, 0.018, 0.42, 8),
        exposedMetal,
        [side * 0.055, 0.05, 0.42],
        [Math.PI / 2, 0, 0],
      );
    }
    addPart(
      new RoundedBoxGeometry(0.155, 0.21, 0.09, 3, 0.025),
      polymer,
      [0, 0.02, 0.64],
      [0.03, 0, 0],
    );
    addPart(
      new RoundedBoxGeometry(0.17, 0.22, 0.035, 3, 0.012),
      dark,
      [0, 0.02, 0.69],
      [0.03, 0, 0],
    );

    if (marksman) {
      addPart(
        new THREE.CylinderGeometry(0.068, 0.068, 0.42, 20),
        dark,
        [0, 0.29, -0.23],
        [Math.PI / 2, 0, 0],
      );
      addPart(
        new THREE.CylinderGeometry(0.082, 0.074, 0.055, 20),
        dark,
        [0, 0.29, -0.455],
        [Math.PI / 2, 0, 0],
      );
      const scopeLens = addPart(
        new THREE.CircleGeometry(0.061, 24),
        glass,
        [0, 0.29, -0.486],
      );
      scopeLens.rotation.y = Math.PI;
      for (const z of [-0.12, -0.35]) {
        addPart(
          new THREE.TorusGeometry(0.072, 0.012, 8, 20),
          exposedMetal,
          [0, 0.29, z],
          [0, 0, 0],
        );
      }
    } else {
      addPart(
        new RoundedBoxGeometry(0.115, 0.105, 0.19, 3, 0.018),
        dark,
        [0, 0.29, -0.26],
      );
      addPart(
        new RoundedBoxGeometry(0.16, 0.17, 0.055, 3, 0.015),
        dark,
        [0, 0.345, -0.35],
      );
      const lens = addPart(
        new THREE.PlaneGeometry(0.102, 0.104),
        glass,
        [0, 0.35, -0.381],
      );
      lens.rotation.y = Math.PI;
      addPart(
        new THREE.CircleGeometry(0.007, 12),
        new THREE.MeshBasicMaterial({
          color: 0xff5239,
          transparent: true,
          opacity: 0.92,
          depthWrite: false,
        }),
        [0, 0.35, -0.387],
      );
    }

    for (const side of [-1, 1]) {
      for (const z of [-0.1, -0.31]) {
        addPart(
          new THREE.CylinderGeometry(0.013, 0.013, 0.012, 12),
          exposedMetal,
          [side * 0.094, 0.08, z],
          [0, 0, Math.PI / 2],
        );
      }
    }

    const serialCanvas = document.createElement("canvas");
    serialCanvas.width = 256;
    serialCanvas.height = 64;
    const serialContext = serialCanvas.getContext("2d")!;
    serialContext.clearRect(0, 0, 256, 64);
    serialContext.fillStyle = "#ddd2b8";
    serialContext.font = "700 21px monospace";
    serialContext.fillText(`IM // ${weapon.shortName} // 07`, 8, 38);
    const serialTexture = new THREE.CanvasTexture(serialCanvas);
    serialTexture.colorSpace = THREE.SRGBColorSpace;
    const serialMaterial = marking.clone();
    serialMaterial.map = serialTexture;
    addPart(
      new THREE.PlaneGeometry(0.23, 0.055),
      serialMaterial,
      [0.091, 0.005, -0.17],
      [0, Math.PI / 2, 0],
    );

    const addHand = (
      position: [number, number, number],
      rotation: [number, number, number],
      supportHand: boolean,
    ) => {
      const hand = new THREE.Group();
      hand.position.set(...position);
      hand.rotation.set(...rotation);
      const palm = new THREE.Mesh(
        new RoundedBoxGeometry(0.145, 0.13, 0.2, 3, 0.035),
        glove,
      );
      palm.rotation.x = supportHand ? 0.08 : -0.1;
      hand.add(palm);
      for (let finger = 0; finger < 4; finger += 1) {
        const segment = new THREE.Mesh(
          new THREE.CapsuleGeometry(0.019, 0.075, 3, 7),
          glove,
        );
        segment.rotation.x = Math.PI / 2 + (supportHand ? 0.18 : -0.08);
        segment.position.set(
          (finger - 1.5) * 0.032,
          -0.047,
          supportHand ? -0.095 : -0.085,
        );
        hand.add(segment);
      }
      const thumb = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.022, 0.075, 3, 7),
        glove,
      );
      thumb.rotation.set(Math.PI / 2, 0, supportHand ? -0.68 : 0.68);
      thumb.position.set(supportHand ? 0.077 : -0.077, -0.015, -0.015);
      hand.add(thumb);
      const knuckle = new THREE.Mesh(
        new RoundedBoxGeometry(0.12, 0.035, 0.08, 3, 0.014),
        polymer,
      );
      knuckle.position.set(0, 0.072, -0.025);
      hand.add(knuckle);
      this.weaponRig.add(hand);

      const sleeve = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.095, supportHand ? 0.43 : 0.38, 5, 9),
        fabric,
      );
      sleeve.position.copy(hand.position).add(
        new THREE.Vector3(
          supportHand ? -0.18 : 0.18,
          -0.22,
          supportHand ? 0.16 : 0.2,
        ),
      );
      sleeve.rotation.z = supportHand ? 0.72 : -0.72;
      sleeve.rotation.x = supportHand ? -0.16 : 0.12;
      this.weaponRig.add(sleeve);
    };

    addHand([0.12, -0.2, 0.015], [-0.08, 0.1, -0.3], false);
    addHand(
      [-0.1, -0.13, handguardCenter + handguardLength * 0.06],
      [0.08, -0.08, 0.2],
      true,
    );

    this.weaponMuzzle.position.set(0, 0.018, muzzleZ - 0.09);
    this.weaponRig.add(this.weaponMuzzle);

    this.muzzleBurst = new THREE.Group();
    this.muzzleBurst.position.copy(this.weaponMuzzle.position);
    const flashMaterial = new THREE.MeshBasicMaterial({
      color: 0xffbd65,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    for (let index = 0; index < 3; index += 1) {
      const flare = new THREE.Mesh(
        new THREE.PlaneGeometry(0.23, 0.62),
        flashMaterial.clone(),
      );
      flare.rotation.z = (index / 3) * Math.PI;
      flare.rotation.y = index === 1 ? Math.PI / 2 : 0;
      flare.position.z = -0.22;
      this.muzzleBurst.add(flare);
    }
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.075, 8, 6),
      new THREE.MeshBasicMaterial({
        color: 0xfff0ba,
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity: 1,
        depthWrite: false,
      }),
    );
    core.position.z = -0.08;
    this.muzzleBurst.add(core);
    this.muzzleBurst.visible = false;
    this.weaponRig.add(this.muzzleBurst);

    this.weaponRig.scale.setScalar(0.7);
    this.weaponRig.position.set(0.39, -0.4, -0.84);
    this.weaponRig.rotation.set(-0.015, -0.055, -0.01);
    this.weaponRig.visible = this.phase !== "briefing";
  }

  private rebuildWeapon(): void {
    const keep = new Set<THREE.Object3D>([this.muzzleFlash]);
    [...this.weaponRig.children].forEach((child) => {
      if (keep.has(child)) return;
      this.weaponRig.remove(child);
      child.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.dispose();
        const materials = Array.isArray(object.material)
          ? object.material
          : [object.material];
        materials.forEach((material) => {
          const candidate = material as THREE.MeshStandardMaterial;
          candidate.map?.dispose();
          candidate.bumpMap?.dispose();
          material.dispose();
        });
      });
    });
    this.createWeapon();
  }

  private updateWeapon(dt: number): void {
    if (!this.weaponRig.visible) return;
    this.weaponKick = damp(this.weaponKick, 0, 18, dt);
    this.cameraImpulse = damp(this.cameraImpulse, 0, 15, dt);
    this.weaponFlashTimer = Math.max(0, this.weaponFlashTimer - dt);
    this.muzzleBurst.visible = this.weaponFlashTimer > 0;
    if (this.muzzleBurst.visible) {
      const flashScale =
        0.82 + Math.sin(this.elapsed * 920 + this.ammo * 1.7) * 0.2;
      this.muzzleBurst.scale.set(
        flashScale,
        0.82 + Math.cos(this.elapsed * 730) * 0.14,
        flashScale,
      );
      this.muzzleBurst.rotation.z += dt * 31;
    }
    const moving = Math.hypot(this.playerVelocity.x, this.playerVelocity.z);
    const ads = this.adsHeld ? 1 : 0;
    const reloadProgress =
      this.reloadRemaining > 0
        ? 1 - this.reloadRemaining / this.currentClass.weapon.reloadTime
        : 0;
    const reloadArc =
      this.reloadRemaining > 0 ? Math.sin(reloadProgress * Math.PI) : 0;
    const swayX = Math.sin(this.bobTime) * 0.012 * Math.min(1, moving / 4);
    const swayY = Math.abs(Math.cos(this.bobTime)) * 0.009 * Math.min(1, moving / 4);
    const targetX = THREE.MathUtils.lerp(0.39, 0, ads) + swayX;
    const targetY =
      THREE.MathUtils.lerp(-0.4, -0.23, ads) -
      swayY -
      reloadArc * 0.18;
    const targetZ =
      THREE.MathUtils.lerp(-0.84, -0.62, ads) + this.weaponKick * 0.1;
    this.weaponRig.position.x = damp(this.weaponRig.position.x, targetX, 14, dt);
    this.weaponRig.position.y = damp(this.weaponRig.position.y, targetY, 14, dt);
    this.weaponRig.position.z = damp(this.weaponRig.position.z, targetZ, 18, dt);
    this.weaponRig.rotation.x = damp(
      this.weaponRig.rotation.x,
      -0.015 + this.weaponKick * 0.1 + reloadArc * 0.75,
      13,
      dt,
    );
    this.weaponRig.rotation.z = damp(
      this.weaponRig.rotation.z,
      reloadArc * -0.65,
      13,
      dt,
    );
    const magazine = this.weaponRig.getObjectByName("magazine");
    if (magazine) {
      const drop =
        this.reloadRemaining > 0
          ? Math.sin(Math.min(1, reloadProgress * 1.35) * Math.PI) * 0.22
          : 0;
      magazine.position.y = -0.225 - drop;
      magazine.rotation.z = -reloadArc * 0.32;
    }
    this.muzzleFlash.intensity = Math.max(0, this.muzzleFlash.intensity - dt * 80);
  }

  private startReload(): void {
    if (
      this.phase !== "playing" ||
      this.inVehicle ||
      this.reloadRemaining > 0 ||
      this.ammo >= this.currentClass.weapon.magazine ||
      this.reserve <= 0
    ) {
      return;
    }
    this.reloadRemaining = this.currentClass.weapon.reloadTime;
    this.fireHeld = false;
    this.callbacks.onNotice("RELOADING", this.currentClass.weapon.shortName);
  }

  private tryFire(): void {
    if (this.phase !== "playing" || this.fireCooldown > 0) return;
    if (this.inVehicle) {
      this.fireVehicleWeapon();
      return;
    }
    if (this.reloadRemaining > 0) return;
    if (this.ammo <= 0) {
      this.fireCooldown = 0.2;
      this.startReload();
      return;
    }

    const weapon = this.currentClass.weapon;
    this.ammo -= 1;
    this.fireCooldown = 60 / weapon.fireRate;
    this.weaponKick = Math.min(1, this.weaponKick + 0.52);
    this.cameraImpulse = Math.min(1, this.cameraImpulse + 0.62);
    this.pitch += weapon.shortName === "S-14" ? 0.035 : 0.012 + this.random() * 0.009;
    this.yaw += (this.random() - 0.5) * 0.006;
    this.muzzleFlash.intensity = 42;
    this.weaponFlashTimer = weapon.shortName === "S-14" ? 0.064 : 0.044;
    this.audio.gunshot(weapon.shortName === "S-14");

    const origin = this.camera.getWorldPosition(this.tempA);
    const direction = this.camera.getWorldDirection(this.tempB);
    const spread = this.adsHeld ? weapon.adsSpread : weapon.spread;
    direction.x += (this.random() - 0.5) * spread;
    direction.y += (this.random() - 0.5) * spread;
    direction.z += (this.random() - 0.5) * spread;
    direction.normalize();

    this.raycaster.set(origin, direction);
    this.raycaster.far = weapon.range;
    const worldHit = this.raycaster.intersectObjects(this.world.staticMeshes, false)[0];
    let hitDistance = worldHit?.distance ?? weapon.range;
    let hitPoint = origin.clone().addScaledVector(direction, hitDistance);
    let hitBot: Bot | null = null;
    let headshot = false;

    for (const bot of this.bots) {
      if (!bot.alive || bot.team === "blue") continue;
      const center = this.tempC.copy(bot.group.position).add(new THREE.Vector3(0, 1.05, 0));
      const along = center.clone().sub(origin).dot(direction);
      if (along < 0 || along > hitDistance) continue;
      const closest = origin.clone().addScaledVector(direction, along);
      const verticalTarget = center.distanceToSquared(closest);
      if (verticalTarget < 0.48 * 0.48) {
        hitDistance = along;
        hitPoint = closest;
        hitBot = bot;
        headshot = closest.y > bot.group.position.y + 1.48;
      }
    }

    const muzzle = origin
      .clone()
      .addScaledVector(direction, 0.92)
      .add(
        new THREE.Vector3(
          Math.cos(this.yaw) * 0.13,
          -0.17,
          -Math.sin(this.yaw) * 0.13,
        ),
      );
    this.createTracer(muzzle, hitPoint, 0xffca72);
    this.ejectCasing();
    if (hitBot) {
      const damage = weapon.damage * (headshot ? 1.72 : 1);
      this.damageBot(hitBot, damage, headshot, "player");
      this.showHitmarker(headshot, !hitBot.alive);
    } else {
      const impactNormal = worldHit?.face
        ? worldHit.face.normal
            .clone()
            .transformDirection(worldHit.object.matrixWorld)
        : new THREE.Vector3(0, 1, 0);
      this.createImpact(hitPoint, impactNormal);
    }

    if (this.ammo === 0 && this.reserve > 0) {
      window.setTimeout(() => this.startReload(), 180);
    }
  }

  private createBots(): void {
    for (let i = 0; i < BOT_COUNT_PER_TEAM * 2; i += 1) {
      const team: Team = i < BOT_COUNT_PER_TEAM ? "blue" : "red";
      const group = this.createBotModel(team);
      const bot: Bot = {
        id: i,
        name: BOT_NAMES[i % BOT_NAMES.length],
        team,
        group,
        leftArm: group.getObjectByName("leftArm") as THREE.Group,
        rightArm: group.getObjectByName("rightArm") as THREE.Group,
        leftLeg: group.getObjectByName("leftLeg") as THREE.Group,
        rightLeg: group.getObjectByName("rightLeg") as THREE.Group,
        muzzle: group.getObjectByName("muzzle")!,
        health: 100,
        alive: true,
        respawnAt: 0,
        fireCooldown: this.random(),
        retargetAt: 0,
        objectiveIndex: team === "blue" ? Math.min(2, i % 3) : Math.max(0, 2 - (i % 3)),
        speed: 3.2 + this.random() * 0.8,
        stride: this.random() * Math.PI * 2,
        strafe: this.random() > 0.5 ? 1 : -1,
        target: null,
      };
      this.bots.push(bot);
      this.respawnBot(bot, true);
    }
  }

  private createBotModel(team: Team): THREE.Group {
    const group = new THREE.Group();
    const uniform = new THREE.MeshStandardMaterial({
      color: team === "blue" ? 0x4f625d : 0x615246,
      roughness: 0.92,
      metalness: 0,
    });
    const armor = new THREE.MeshStandardMaterial({
      color: team === "blue" ? 0x263b3e : 0x40302c,
      roughness: 0.68,
      metalness: 0.08,
      envMapIntensity: 0.52,
    });
    const accent = new THREE.MeshStandardMaterial({
      color: team === "blue" ? BLUE : RED,
      emissive: team === "blue" ? 0x0d4c63 : 0x641c13,
      emissiveIntensity: 0.62,
      roughness: 0.58,
    });
    const skin = new THREE.MeshStandardMaterial({
      color: 0x8c6b52,
      roughness: 0.88,
    });
    const weapon = new THREE.MeshStandardMaterial({
      color: 0x171c1c,
      metalness: 0.7,
      roughness: 0.36,
      envMapIntensity: 0.9,
    });
    const rubber = new THREE.MeshStandardMaterial({
      color: 0x101515,
      roughness: 0.86,
    });

    const addBotMesh = (
      geometry: THREE.BufferGeometry,
      material: THREE.Material,
      position: [number, number, number],
      rotation: [number, number, number] = [0, 0, 0],
      parent: THREE.Object3D = group,
    ) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(...position);
      mesh.rotation.set(...rotation);
      mesh.castShadow = !this.touchMode;
      mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };

    addBotMesh(
      new RoundedBoxGeometry(0.57, 0.68, 0.34, 3, 0.11),
      uniform,
      [0, 1.17, 0],
    );
    addBotMesh(
      new RoundedBoxGeometry(0.64, 0.51, 0.43, 3, 0.075),
      armor,
      [0, 1.18, -0.035],
    );
    addBotMesh(
      new RoundedBoxGeometry(0.5, 0.12, 0.45, 3, 0.025),
      armor,
      [0, 0.9, -0.025],
    );
    for (let pouch = -1; pouch <= 1; pouch += 1) {
      addBotMesh(
        new RoundedBoxGeometry(0.14, 0.19, 0.09, 2, 0.025),
        armor,
        [pouch * 0.17, 1.04, -0.245],
      );
    }
    addBotMesh(
      new RoundedBoxGeometry(0.4, 0.52, 0.16, 3, 0.05),
      armor,
      [0, 1.2, 0.24],
    );
    addBotMesh(
      new THREE.CapsuleGeometry(0.12, 0.08, 4, 9),
      uniform,
      [0, 1.55, 0],
    );
    const head = addBotMesh(
      new THREE.SphereGeometry(0.19, 14, 10),
      skin,
      [0, 1.72, -0.005],
    );
    head.scale.set(0.9, 1.05, 0.92);
    addBotMesh(
      new RoundedBoxGeometry(0.33, 0.16, 0.23, 3, 0.055),
      armor,
      [0, 1.66, -0.02],
    );
    const helmet = new THREE.Mesh(
      new THREE.SphereGeometry(
        0.225,
        16,
        8,
        0,
        Math.PI * 2,
        0,
        Math.PI / 1.82,
      ),
      armor,
    );
    helmet.position.set(0, 1.82, 0);
    helmet.castShadow = !this.touchMode;
    group.add(helmet);
    addBotMesh(
      new THREE.BoxGeometry(0.3, 0.035, 0.25),
      armor,
      [0, 1.82, -0.075],
    );
    addBotMesh(
      new RoundedBoxGeometry(0.32, 0.09, 0.055, 2, 0.018),
      rubber,
      [0, 1.75, -0.185],
    );
    for (const side of [-1, 1]) {
      const lens = addBotMesh(
        new THREE.CircleGeometry(0.055, 12),
        new THREE.MeshPhysicalMaterial({
          color: 0x607a7d,
          roughness: 0.12,
          metalness: 0.15,
          transparent: true,
          opacity: 0.8,
        }),
        [side * 0.071, 1.755, -0.216],
      );
      lens.rotation.y = Math.PI;
    }

    addBotMesh(
      new RoundedBoxGeometry(0.22, 0.095, 0.025, 2, 0.01),
      accent,
      [0, 1.29, -0.255],
    );
    for (const shoulder of [-1, 1]) {
      addBotMesh(
        new THREE.SphereGeometry(0.15, 10, 7),
        armor,
        [shoulder * 0.36, 1.43, 0],
      ).scale.set(1.15, 0.75, 1);
    }

    const createLimb = (name: string, x: number, y: number, leg: boolean) => {
      const limb = new THREE.Group();
      limb.name = name;
      limb.position.set(x, y, 0);
      const upper = new THREE.Mesh(
        new THREE.CapsuleGeometry(
          leg ? 0.115 : 0.09,
          leg ? 0.31 : 0.25,
          4,
          8,
        ),
        uniform,
      );
      upper.position.y = leg ? -0.23 : -0.19;
      upper.castShadow = !this.touchMode;
      limb.add(upper);
      const lower = new THREE.Mesh(
        new THREE.CapsuleGeometry(
          leg ? 0.105 : 0.082,
          leg ? 0.29 : 0.24,
          4,
          8,
        ),
        leg ? uniform : armor,
      );
      lower.position.y = leg ? -0.62 : -0.51;
      lower.castShadow = !this.touchMode;
      limb.add(lower);
      if (leg) {
        const knee = new THREE.Mesh(
          new RoundedBoxGeometry(0.19, 0.17, 0.11, 2, 0.035),
          armor,
        );
        knee.position.set(0, -0.43, -0.07);
        limb.add(knee);
        const boot = new THREE.Mesh(
          new RoundedBoxGeometry(0.2, 0.15, 0.31, 3, 0.05),
          rubber,
        );
        boot.position.set(0, -0.88, -0.07);
        limb.add(boot);
      } else {
        const glove = new THREE.Mesh(
          new RoundedBoxGeometry(0.13, 0.14, 0.13, 3, 0.04),
          rubber,
        );
        glove.position.set(0, -0.72, -0.02);
        limb.add(glove);
      }
      group.add(limb);
      return limb;
    };
    createLimb("leftLeg", -0.17, 0.84, true);
    createLimb("rightLeg", 0.17, 0.84, true);
    createLimb("leftArm", -0.39, 1.43, false);
    createLimb("rightArm", 0.39, 1.43, false);

    addBotMesh(
      new RoundedBoxGeometry(0.115, 0.115, 0.82, 3, 0.018),
      weapon,
      [0.2, 1.2, -0.42],
      [-0.08, -0.04, 0],
    );
    addBotMesh(
      new THREE.CylinderGeometry(0.025, 0.03, 0.43, 9),
      weapon,
      [0.2, 1.235, -1.02],
      [Math.PI / 2, 0, 0],
    );
    addBotMesh(
      new RoundedBoxGeometry(0.1, 0.22, 0.16, 2, 0.02),
      rubber,
      [0.2, 1.02, -0.42],
      [-0.16, 0, 0],
    );
    addBotMesh(
      new RoundedBoxGeometry(0.14, 0.14, 0.26, 3, 0.02),
      rubber,
      [0.2, 1.21, 0.05],
    );
    const muzzle = new THREE.Object3D();
    muzzle.name = "muzzle";
    muzzle.position.set(0.2, 1.235, -1.26);
    group.add(muzzle);
    group.scale.setScalar(1.04);
    this.scene.add(group);
    return group;
  }

  private respawnBot(bot: Bot, initial = false): void {
    const spawn = bot.team === "blue" ? this.world.blueSpawn : this.world.redSpawn;
    const angle = this.random() * Math.PI * 2;
    const radius = initial ? 6 + this.random() * 16 : 5 + this.random() * 8;
    bot.group.position.set(
      spawn.x + Math.cos(angle) * radius,
      0,
      spawn.z + Math.sin(angle) * radius,
    );
    bot.group.position.y = terrainHeight(bot.group.position.x, bot.group.position.z);
    bot.group.visible = true;
    bot.health = 100;
    bot.alive = true;
    bot.target = null;
    bot.fireCooldown = 0.6 + this.random();
    bot.objectiveIndex =
      bot.team === "blue"
        ? Math.floor(this.random() * 3)
        : 2 - Math.floor(this.random() * 3);
  }

  private updateBots(dt: number): void {
    for (const bot of this.bots) {
      if (!bot.alive) {
        if (this.elapsed >= bot.respawnAt && this.phase === "playing") {
          this.respawnBot(bot);
        }
        continue;
      }
      bot.fireCooldown -= dt;
      bot.retargetAt -= dt;
      if (bot.retargetAt <= 0) {
        bot.retargetAt = 0.5 + this.random() * 0.55;
        bot.target = this.findBotTarget(bot);
        if (!bot.target) bot.objectiveIndex = this.chooseObjective(bot.team);
      }

      const objective = this.world.objectives[bot.objectiveIndex];
      let targetPosition = objective.position;
      let targetDistance = bot.group.position.distanceTo(objective.position);
      if (bot.target === "player" && this.phase === "playing") {
        targetPosition = this.playerPosition;
        targetDistance = bot.group.position.distanceTo(this.playerPosition);
      } else if (bot.target && bot.target !== "player" && bot.target.alive) {
        targetPosition = bot.target.group.position;
        targetDistance = bot.group.position.distanceTo(targetPosition);
      }

      const hasCombatTarget = bot.target !== null && targetDistance < 62;
      const shouldMove = !hasCombatTarget || targetDistance > 19;
      const direction = this.tempA.copy(targetPosition).sub(bot.group.position);
      direction.y = 0;
      const distance = Math.max(0.001, direction.length());
      direction.divideScalar(distance);
      let moveX = direction.x;
      let moveZ = direction.z;
      if (hasCombatTarget && targetDistance < 36) {
        moveX += direction.z * bot.strafe * 0.42;
        moveZ -= direction.x * bot.strafe * 0.42;
      }

      if (shouldMove) {
        const speed = bot.speed * (hasCombatTarget ? 0.72 : 1);
        const nextX = clamp(bot.group.position.x + moveX * speed * dt, -150, 150);
        const nextZ = clamp(bot.group.position.z + moveZ * speed * dt, -150, 150);
        if (!this.botCollides(nextX, bot.group.position.z)) bot.group.position.x = nextX;
        else bot.strafe *= -1;
        if (!this.botCollides(bot.group.position.x, nextZ)) bot.group.position.z = nextZ;
        else bot.strafe *= -1;
        bot.stride += dt * speed * 2.7;
        bot.leftLeg.rotation.x = Math.sin(bot.stride) * 0.58;
        bot.rightLeg.rotation.x = Math.sin(bot.stride + Math.PI) * 0.58;
        bot.leftArm.rotation.x = Math.sin(bot.stride + Math.PI) * 0.22 - 0.72;
        bot.rightArm.rotation.x = Math.sin(bot.stride) * 0.22 - 0.72;
      } else {
        bot.leftLeg.rotation.x = damp(bot.leftLeg.rotation.x, 0, 8, dt);
        bot.rightLeg.rotation.x = damp(bot.rightLeg.rotation.x, 0, 8, dt);
        bot.leftArm.rotation.x = damp(bot.leftArm.rotation.x, -0.72, 8, dt);
        bot.rightArm.rotation.x = damp(bot.rightArm.rotation.x, -0.72, 8, dt);
      }
      bot.group.position.y = terrainHeight(bot.group.position.x, bot.group.position.z);
      bot.group.rotation.y = Math.atan2(direction.x, direction.z) + Math.PI;

      if (hasCombatTarget && targetDistance < 58 && bot.fireCooldown <= 0) {
        bot.fireCooldown = 0.28 + this.random() * 0.42;
        this.botFire(bot, targetPosition, targetDistance);
      }
    }
  }

  private findBotTarget(bot: Bot): Bot | "player" | null {
    let closestDistance = 68;
    let closest: Bot | "player" | null = null;
    if (bot.team === "red" && this.phase === "playing") {
      const distance = bot.group.position.distanceTo(this.playerPosition);
      if (distance < closestDistance) {
        closestDistance = distance;
        closest = "player";
      }
    }
    for (const candidate of this.bots) {
      if (!candidate.alive || candidate.team === bot.team) continue;
      const distance = candidate.group.position.distanceTo(bot.group.position);
      if (distance < closestDistance) {
        closestDistance = distance;
        closest = candidate;
      }
    }
    return closest;
  }

  private chooseObjective(team: Team): number {
    const desired = this.world.objectives
      .map((objective, index) => ({
        index,
        score:
          (objective.owner === team ? 0.2 : 2) +
          (index === 1 ? 0.35 : 0) +
          this.random() * 0.35,
      }))
      .sort((a, b) => b.score - a.score);
    return desired[0].index;
  }

  private botCollides(x: number, z: number): boolean {
    for (const collider of this.world.colliders) {
      if (
        x > collider.box.min.x - 0.32 &&
        x < collider.box.max.x + 0.32 &&
        z > collider.box.min.z - 0.32 &&
        z < collider.box.max.z + 0.32
      ) {
        return true;
      }
    }
    return false;
  }

  private botFire(bot: Bot, targetPosition: THREE.Vector3, distance: number): void {
    const origin = bot.muzzle.getWorldPosition(new THREE.Vector3());
    const target = targetPosition
      .clone()
      .add(new THREE.Vector3(0, bot.target === "player" ? 0 : 1.15, 0));
    target.x += (this.random() - 0.5) * (0.45 + distance * 0.018);
    target.y += (this.random() - 0.5) * (0.3 + distance * 0.01);
    target.z += (this.random() - 0.5) * (0.45 + distance * 0.018);
    const direction = target.clone().sub(origin).normalize();
    const end = origin.clone().addScaledVector(direction, Math.min(80, distance + 8));
    this.createTracer(origin, end, bot.team === "red" ? 0xff896b : 0x74d9ff);
    const relative = bot.group.position.clone().sub(this.playerPosition);
    const side = Math.sin(Math.atan2(relative.x, relative.z) - this.yaw);
    this.audio.enemyShot(bot.group.position.distanceTo(this.playerPosition), side);

    const hitChance = clamp(0.66 - distance * 0.008, 0.16, 0.58);
    if (bot.target === "player" && this.random() < hitChance) {
      this.damagePlayer(7 + this.random() * 7, bot.group.position);
    } else if (bot.target && bot.target !== "player" && this.random() < hitChance) {
      this.damageBot(bot.target, 9 + this.random() * 9, false, bot);
    }
  }

  private damageBot(
    bot: Bot,
    amount: number,
    headshot: boolean,
    source: "player" | Bot | "explosion",
  ): void {
    if (!bot.alive) return;
    bot.health -= amount;
    this.createBloodMist(bot.group.position.clone().add(new THREE.Vector3(0, 1.2, 0)));
    if (bot.health > 0) return;
    bot.alive = false;
    bot.group.visible = false;
    bot.respawnAt = this.elapsed + 5.5 + this.random() * 2;
    this.tickets[bot.team] = Math.max(0, this.tickets[bot.team] - 1);
    const killer =
      source === "player"
        ? "YOU"
        : source === "explosion"
          ? "EXPLOSIVE"
          : source.name.toUpperCase();
    this.addKillfeed(killer, bot.name.toUpperCase(), headshot);
    if (source === "player") {
      this.kills += 1;
      this.callbacks.onNotice(
        headshot ? "HEADSHOT" : "ENEMY KILLED",
        `+${headshot ? 140 : 100}`,
      );
    }
  }

  private damagePlayer(amount: number, from: THREE.Vector3): void {
    if (this.phase !== "playing") return;
    if (this.inVehicle) {
      this.vehicle.health -= amount * 0.68;
      this.lastDamageAt = this.elapsed;
      this.showDamageFeedback(from, true);
      if (this.vehicle.health <= 0) this.destroyVehicle();
      return;
    }
    this.playerHealth -= amount;
    this.lastDamageAt = this.elapsed;
    this.showDamageFeedback(from, false);
    if (this.playerHealth <= 0) this.killPlayer();
  }

  private showDamageFeedback(from: THREE.Vector3, armor: boolean): void {
    const angle = Math.atan2(
      from.x - this.playerPosition.x,
      from.z - this.playerPosition.z,
    );
    this.damageDirection = THREE.MathUtils.radToDeg(angle - this.yaw);
    const indicator = document.getElementById("damage-indicator");
    if (indicator) {
      indicator.style.setProperty("--damage-angle", `${this.damageDirection}deg`);
      indicator.classList.remove("is-active");
      void indicator.offsetWidth;
      indicator.classList.add("is-active");
    }
    const vignette = document.getElementById("damage-vignette");
    if (vignette) {
      vignette.style.opacity = armor ? "0.38" : "0.72";
      window.setTimeout(() => {
        vignette.style.opacity = "0";
      }, 170);
    }
  }

  private killPlayer(): void {
    this.playerHealth = 0;
    this.deaths += 1;
    this.tickets.blue = Math.max(0, this.tickets.blue - 1);
    this.phase = "dead";
    this.fireHeld = false;
    this.adsHeld = false;
    if (document.pointerLockElement) document.exitPointerLock();
    this.callbacks.onPhase("dead");
    this.callbacks.onNotice("KILLED IN ACTION", "Choose a class and redeploy");
  }

  private getForwardSpawn(): THREE.Vector3 {
    const owned = this.world.objectives.filter((objective) => objective.owner === "blue");
    if (owned.length === 0) return this.world.blueSpawn.clone();
    owned.sort((a, b) => b.position.x - a.position.x);
    const objective = owned[0];
    const angle = this.random() * Math.PI * 2;
    return objective.position
      .clone()
      .add(new THREE.Vector3(Math.cos(angle) * 8, PLAYER_HEIGHT, Math.sin(angle) * 8));
  }

  private updateObjectives(dt: number): void {
    for (const objective of this.world.objectives) {
      let blueCount = 0;
      let redCount = 0;
      for (const bot of this.bots) {
        if (!bot.alive) continue;
        if (bot.group.position.distanceToSquared(objective.position) > objective.radius ** 2)
          continue;
        if (bot.team === "blue") blueCount += 1;
        else redCount += 1;
      }
      const playerInside =
        this.phase === "playing" &&
        this.playerPosition.distanceToSquared(objective.position) < objective.radius ** 2;
      if (playerInside) blueCount += this.inVehicle ? 2 : 1;

      const balance = redCount - blueCount;
      if (balance !== 0) {
        objective.capture = clamp(
          objective.capture + balance * dt * 0.055,
          -1,
          1,
        );
      }
      objective.owner =
        objective.capture <= -0.92
          ? "blue"
          : objective.capture >= 0.92
            ? "red"
            : Math.abs(objective.capture) < 0.08
              ? "neutral"
              : objective.owner;

      if (objective.owner !== objective.previousOwner) {
        const capturedBy = objective.owner;
        if (capturedBy !== "neutral") {
          this.callbacks.onNotice(
            capturedBy === "blue" ? "OBJECTIVE SECURED" : "OBJECTIVE LOST",
            `${objective.id} · ${objective.name}`,
          );
          this.audio.uiTone(capturedBy === "blue");
          this.addKillfeed(
            capturedBy === "blue" ? "FRIENDLY FORCES" : "HOSTILE FORCES",
            `CAPTURED ${objective.id}`,
            false,
            true,
          );
        }
        objective.previousOwner = objective.owner;
      }
      this.updateObjectiveVisual(objective);

      if (playerInside) {
        const panel = document.getElementById("capture-status");
        const label = document.getElementById("capture-label");
        const bar = document.getElementById("capture-bar");
        if (panel && label && bar) {
          panel.classList.add("is-visible");
          const contested = blueCount > 0 && redCount > 0;
          label.textContent = contested
            ? `OBJECTIVE ${objective.id} CONTESTED`
            : objective.owner === "blue"
              ? `DEFENDING ${objective.id} · ${objective.name.toUpperCase()}`
              : `CAPTURING ${objective.id} · ${objective.name.toUpperCase()}`;
          bar.style.width = `${Math.abs(objective.capture) * 100}%`;
          bar.dataset.team = objective.capture < 0 ? "blue" : "red";
        }
      }
    }

    const insideAny = this.world.objectives.some(
      (objective) =>
        this.playerPosition.distanceToSquared(objective.position) < objective.radius ** 2,
    );
    if (!insideAny) document.getElementById("capture-status")?.classList.remove("is-visible");
  }

  private updateObjectiveVisual(objective: ObjectiveState): void {
    const color =
      objective.owner === "blue" ? BLUE : objective.owner === "red" ? RED : NEUTRAL;
    const flag = objective.marker.getObjectByName("flag") as THREE.Mesh | undefined;
    if (flag && flag.material instanceof THREE.MeshStandardMaterial) {
      flag.material.color.setHex(color);
      const positions = flag.geometry.attributes.position as THREE.BufferAttribute;
      const time = this.elapsed;
      for (let index = 0; index < positions.count; index += 1) {
        const x = positions.getX(index);
        positions.setZ(index, Math.sin(x * 2.8 + time * 2.4) * 0.1 * (x / 3.2));
      }
      positions.needsUpdate = true;
    }
    if (objective.pulse.material instanceof THREE.MeshBasicMaterial) {
      objective.pulse.material.color.setHex(color);
      objective.pulse.material.opacity = 0.28 + Math.sin(this.elapsed * 2.4) * 0.12;
    }
  }

  private updateTickets(dt: number): void {
    this.ticketClock += dt;
    if (this.ticketClock < 1) return;
    this.ticketClock -= 1;
    const blueOwned = this.world.objectives.filter(
      (objective) => objective.owner === "blue",
    ).length;
    const redOwned = this.world.objectives.filter(
      (objective) => objective.owner === "red",
    ).length;
    if (blueOwned > redOwned) {
      this.tickets.red = Math.max(0, this.tickets.red - (blueOwned - redOwned));
    } else if (redOwned > blueOwned) {
      this.tickets.blue = Math.max(0, this.tickets.blue - (redOwned - blueOwned));
    }
    if (this.tickets.blue <= 0 || this.tickets.red <= 0) {
      const won = this.tickets.red <= 0;
      this.phase = won ? "victory" : "defeat";
      this.fireHeld = false;
      if (document.pointerLockElement) document.exitPointerLock();
      this.callbacks.onPhase(this.phase);
      this.callbacks.onNotice(
        won ? "SECTOR SECURED" : "OPERATION FAILED",
        `${this.kills} eliminations · ${this.deaths} deaths`,
      );
      this.audio.uiTone(won);
    }
  }

  private createVehicle(): Vehicle {
    const group = new THREE.Group();
    const armor = new THREE.MeshStandardMaterial({
      color: 0x4e6255,
      metalness: 0.48,
      roughness: 0.54,
      envMapIntensity: 0.8,
    });
    const armorDark = new THREE.MeshStandardMaterial({
      color: 0x202b29,
      metalness: 0.68,
      roughness: 0.4,
      envMapIntensity: 0.95,
    });
    const glass = new THREE.MeshPhysicalMaterial({
      color: 0x263f45,
      metalness: 0.12,
      roughness: 0.1,
      transmission: 0.08,
      transparent: true,
      opacity: 0.78,
      envMapIntensity: 1.3,
    });
    const rubber = new THREE.MeshStandardMaterial({
      color: 0x0e1110,
      roughness: 0.96,
      metalness: 0,
    });
    const lightMaterial = new THREE.MeshStandardMaterial({
      color: 0xe0c08b,
      emissive: 0xffbd62,
      emissiveIntensity: 2.8,
      roughness: 0.32,
    });
    const addVehiclePart = (
      geometry: THREE.BufferGeometry,
      material: THREE.Material,
      position: [number, number, number],
      rotation: [number, number, number] = [0, 0, 0],
    ) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(...position);
      mesh.rotation.set(...rotation);
      mesh.castShadow = !this.touchMode;
      mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    };

    addVehiclePart(
      new RoundedBoxGeometry(3.2, 0.9, 5.25, 4, 0.18),
      armor,
      [0, 1.08, 0],
    );
    addVehiclePart(
      new RoundedBoxGeometry(2.86, 0.58, 1.72, 4, 0.15),
      armor,
      [0, 1.48, -2.02],
      [-0.1, 0, 0],
    );
    addVehiclePart(
      new RoundedBoxGeometry(2.52, 1.2, 2.22, 4, 0.15),
      armorDark,
      [0, 1.9, 0.18],
    );
    addVehiclePart(
      new RoundedBoxGeometry(2.25, 0.23, 2.35, 3, 0.08),
      armor,
      [0, 2.57, 0.2],
    );
    addVehiclePart(
      new THREE.PlaneGeometry(1.92, 0.72),
      glass,
      [0, 2.02, -0.948],
      [-0.08, 0, 0],
    );
    for (const side of [-1, 1]) {
      addVehiclePart(
        new THREE.PlaneGeometry(0.82, 0.68),
        glass,
        [side * 1.266, 2.02, -0.03],
        [0, side * Math.PI / 2, 0],
      );
      addVehiclePart(
        new RoundedBoxGeometry(0.18, 0.28, 4.72, 3, 0.05),
        armorDark,
        [side * 1.66, 1.08, 0.05],
      );
      addVehiclePart(
        new RoundedBoxGeometry(0.32, 0.3, 1.4, 3, 0.09),
        armor,
        [side * 1.62, 1.52, 0.23],
      );
      addVehiclePart(
        new THREE.CylinderGeometry(0.055, 0.055, 0.4, 8),
        armorDark,
        [side * 1.53, 2.18, -0.94],
        [0, 0, Math.PI / 2],
      );
      addVehiclePart(
        new RoundedBoxGeometry(0.4, 0.18, 0.24, 3, 0.05),
        armorDark,
        [side * 1.72, 2.18, -0.94],
      );
    }

    addVehiclePart(
      new RoundedBoxGeometry(3.26, 0.22, 0.36, 3, 0.07),
      armorDark,
      [0, 0.7, -2.62],
    );
    addVehiclePart(
      new RoundedBoxGeometry(2.4, 0.38, 0.15, 3, 0.045),
      armorDark,
      [0, 1.35, -2.87],
    );
    for (let grille = -4; grille <= 4; grille += 1) {
      addVehiclePart(
        new THREE.BoxGeometry(0.09, 0.28, 0.035),
        rubber,
        [grille * 0.22, 1.35, -2.96],
      );
    }
    for (const side of [-1, 1]) {
      addVehiclePart(
        new RoundedBoxGeometry(0.42, 0.24, 0.09, 3, 0.05),
        lightMaterial,
        [side * 1.03, 1.57, -2.88],
      );
      addVehiclePart(
        new THREE.TorusGeometry(0.67, 0.08, 8, 22, Math.PI),
        armor,
        [side * 1.58, 0.78, -1.62],
        [0, Math.PI / 2, Math.PI / 2],
      );
      addVehiclePart(
        new THREE.TorusGeometry(0.67, 0.08, 8, 22, Math.PI),
        armor,
        [side * 1.58, 0.78, 1.63],
        [0, Math.PI / 2, Math.PI / 2],
      );
    }

    const wheels: THREE.Mesh[] = [];
    const wheelGeometry = new THREE.CylinderGeometry(0.65, 0.65, 0.42, 20);
    [
      [-1.62, 0.66, -1.65],
      [1.62, 0.66, -1.65],
      [-1.62, 0.66, 1.62],
      [1.62, 0.66, 1.62],
    ].forEach(([x, y, z]) => {
      const wheel = new THREE.Mesh(wheelGeometry, rubber);
      wheel.position.set(x, y, z);
      wheel.rotation.z = Math.PI / 2;
      wheel.castShadow = !this.touchMode;
      group.add(wheel);
      const rim = new THREE.Mesh(
        new THREE.CylinderGeometry(0.32, 0.32, 0.435, 16),
        armorDark,
      );
      rim.position.copy(wheel.position);
      rim.rotation.z = Math.PI / 2;
      group.add(rim);
      for (let tread = 0; tread < 12; tread += 1) {
        const angle = (tread / 12) * Math.PI * 2;
        const treadBlock = new THREE.Mesh(
          new RoundedBoxGeometry(0.47, 0.1, 0.18, 2, 0.035),
          rubber,
        );
        treadBlock.position.set(
          x,
          y + Math.cos(angle) * 0.65,
          z + Math.sin(angle) * 0.65,
        );
        treadBlock.rotation.x = angle;
        treadBlock.castShadow = !this.touchMode;
        group.add(treadBlock);
      }
      wheels.push(wheel);
    });

    const turret = new THREE.Group();
    turret.position.set(0, 2.78, 0.28);
    const turretBase = new THREE.Mesh(
      new THREE.CylinderGeometry(0.68, 0.82, 0.36, 16),
      armorDark,
    );
    turret.add(turretBase);
    const shield = new THREE.Mesh(
      new RoundedBoxGeometry(0.92, 0.7, 0.52, 3, 0.09),
      armor,
    );
    shield.position.set(0, 0.43, -0.08);
    turret.add(shield);
    const optics = new THREE.Mesh(
      new RoundedBoxGeometry(0.28, 0.24, 0.28, 3, 0.055),
      armorDark,
    );
    optics.position.set(0.46, 0.58, -0.14);
    turret.add(optics);
    const opticLens = new THREE.Mesh(
      new THREE.CircleGeometry(0.08, 14),
      glass,
    );
    opticLens.position.set(0.46, 0.58, -0.292);
    opticLens.rotation.y = Math.PI;
    turret.add(opticLens);
    const gun = new THREE.Mesh(
      new THREE.CylinderGeometry(0.058, 0.082, 2.45, 12),
      armorDark,
    );
    gun.rotation.x = Math.PI / 2;
    gun.position.set(-0.16, 0.44, -1.27);
    turret.add(gun);
    const muzzleBrake = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.1, 0.2, 12),
      armorDark,
    );
    muzzleBrake.rotation.x = Math.PI / 2;
    muzzleBrake.position.set(-0.16, 0.44, -2.53);
    turret.add(muzzleBrake);
    const ammoBox = new THREE.Mesh(
      new RoundedBoxGeometry(0.42, 0.48, 0.62, 3, 0.06),
      armor,
    );
    ammoBox.position.set(-0.6, 0.34, 0.02);
    turret.add(ammoBox);
    group.add(turret);

    addVehiclePart(
      new THREE.CylinderGeometry(0.018, 0.025, 2.65, 7),
      armorDark,
      [0.82, 3.42, 0.72],
      [0.08, 0, -0.04],
    );
    const teamPanel = addVehiclePart(
      new THREE.PlaneGeometry(0.58, 0.32),
      new THREE.MeshStandardMaterial({
        color: BLUE,
        emissive: 0x0f5369,
        emissiveIntensity: 0.42,
        roughness: 0.72,
      }),
      [1.611, 1.46, 0.58],
      [0, Math.PI / 2, 0],
    );
    teamPanel.castShadow = false;

    group.position.copy(this.world.vehicleSpawn);
    group.rotation.y = MAIN_ROAD_ROTATION;
    this.scene.add(group);
    return {
      group,
      turret,
      wheels,
      health: 260,
      maxHealth: 260,
      speed: 0,
      yaw: MAIN_ROAD_ROTATION,
      occupied: false,
      fireCooldown: 0,
      destroyed: false,
      respawnAt: 0,
    };
  }

  private updateVehicle(dt: number): void {
    if (this.vehicle.destroyed) return;
    const throttle =
      (this.keys.has("KeyW") ? 1 : 0) -
      (this.keys.has("KeyS") ? 1 : 0) +
      this.touch.move.y;
    const steering =
      (this.keys.has("KeyA") ? 1 : 0) -
      (this.keys.has("KeyD") ? 1 : 0) -
      this.touch.move.x;
    const targetSpeed = throttle >= 0 ? throttle * 17 : throttle * 8;
    this.vehicle.speed = damp(this.vehicle.speed, targetSpeed, throttle ? 2.2 : 3.6, dt);
    if (Math.abs(this.vehicle.speed) > 0.25) {
      this.vehicle.yaw +=
        steering * dt * 0.9 * clamp(Math.abs(this.vehicle.speed) / 7, 0.25, 1) *
        Math.sign(this.vehicle.speed);
    }

    const forward = this.tempA.set(
      -Math.sin(this.vehicle.yaw),
      0,
      -Math.cos(this.vehicle.yaw),
    );
    const next = this.tempB
      .copy(this.vehicle.group.position)
      .addScaledVector(forward, this.vehicle.speed * dt);
    next.x = clamp(next.x, -148, 148);
    next.z = clamp(next.z, -148, 148);
    if (!this.vehicleCollides(next.x, next.z)) {
      this.vehicle.group.position.x = next.x;
      this.vehicle.group.position.z = next.z;
    } else {
      this.vehicle.speed *= -0.16;
    }
    this.vehicle.group.position.y =
      terrainHeight(this.vehicle.group.position.x, this.vehicle.group.position.z) + 0.05;
    this.vehicle.group.rotation.y = this.vehicle.yaw;
    const wheelSpin = this.vehicle.speed * dt * 1.6;
    this.vehicle.wheels.forEach((wheel) => {
      wheel.rotation.x += wheelSpin;
    });

    this.vehicle.fireCooldown = Math.max(0, this.vehicle.fireCooldown - dt);
    this.vehicle.turret.rotation.y = this.yaw - this.vehicle.yaw;
    this.playerPosition.copy(this.vehicle.group.position).add(new THREE.Vector3(0, 2.25, 0));
    this.camera.position.copy(this.playerPosition);
    this.camera.rotation.set(this.pitch, this.yaw, 0);
    this.camera.fov = damp(this.camera.fov, this.adsHeld ? 55 : 78, 8, dt);
    this.camera.updateProjectionMatrix();
  }

  private vehicleCollides(x: number, z: number): boolean {
    for (const collider of this.world.colliders) {
      if (
        x > collider.box.min.x - 1.65 &&
        x < collider.box.max.x + 1.65 &&
        z > collider.box.min.z - 2.35 &&
        z < collider.box.max.z + 2.35
      ) {
        return true;
      }
    }
    return false;
  }

  private useVehicle(): void {
    if (this.vehicle.destroyed) return;
    if (this.inVehicle) {
      this.inVehicle = false;
      this.vehicle.occupied = false;
      this.weaponRig.visible = true;
      const side = this.tempA.set(Math.cos(this.vehicle.yaw), 0, -Math.sin(this.vehicle.yaw));
      this.playerPosition
        .copy(this.vehicle.group.position)
        .addScaledVector(side, 2.5);
      this.playerPosition.y =
        terrainHeight(this.playerPosition.x, this.playerPosition.z) + PLAYER_HEIGHT;
      this.callbacks.onNotice("DISMOUNTED", "KITE LRV");
      return;
    }
    if (this.playerPosition.distanceTo(this.vehicle.group.position) < 5.2) {
      this.inVehicle = true;
      this.vehicle.occupied = true;
      this.weaponRig.visible = false;
      this.yaw = this.vehicle.yaw;
      this.pitch = -0.04;
      this.callbacks.onNotice("VEHICLE READY", "KITE LRV · 12.7 MM RWS");
    }
  }

  private fireVehicleWeapon(): void {
    if (this.vehicle.fireCooldown > 0 || this.vehicle.destroyed) return;
    this.vehicle.fireCooldown = 0.11;
    this.audio.gunshot(true);
    const origin = this.camera.position.clone();
    const direction = this.camera.getWorldDirection(new THREE.Vector3());
    direction.x += (this.random() - 0.5) * 0.007;
    direction.y += (this.random() - 0.5) * 0.007;
    direction.z += (this.random() - 0.5) * 0.007;
    direction.normalize();
    this.raycaster.set(origin, direction);
    this.raycaster.far = 180;
    const worldHit = this.raycaster.intersectObjects(this.world.staticMeshes, false)[0];
    let distance = worldHit?.distance ?? 180;
    let point = origin.clone().addScaledVector(direction, distance);
    let target: Bot | null = null;
    for (const bot of this.bots) {
      if (!bot.alive || bot.team === "blue") continue;
      const center = bot.group.position.clone().add(new THREE.Vector3(0, 1, 0));
      const along = center.clone().sub(origin).dot(direction);
      if (along < 0 || along > distance) continue;
      const closest = origin.clone().addScaledVector(direction, along);
      if (closest.distanceToSquared(center) < 0.65 ** 2) {
        target = bot;
        distance = along;
        point = closest;
      }
    }
    this.createTracer(origin, point, 0xffdc8a);
    if (target) {
      this.damageBot(target, 42, false, "player");
      this.showHitmarker(false, !target.alive);
    } else {
      const impactNormal = worldHit?.face
        ? worldHit.face.normal
            .clone()
            .transformDirection(worldHit.object.matrixWorld)
        : new THREE.Vector3(0, 1, 0);
      this.createImpact(point, impactNormal);
    }
  }

  private destroyVehicle(): void {
    this.vehicle.destroyed = true;
    this.vehicle.group.visible = false;
    this.vehicle.respawnAt = this.elapsed + 25;
    this.createExplosion(this.vehicle.group.position.clone().add(new THREE.Vector3(0, 1, 0)), 1.45);
    this.inVehicle = false;
    this.weaponRig.visible = true;
    this.playerHealth = 0;
    this.killPlayer();
  }

  private resetVehicle(): void {
    this.vehicle.group.position.copy(this.world.vehicleSpawn);
    this.vehicle.group.visible = true;
    this.vehicle.health = this.vehicle.maxHealth;
    this.vehicle.speed = 0;
    this.vehicle.yaw = MAIN_ROAD_ROTATION;
    this.vehicle.group.rotation.y = MAIN_ROAD_ROTATION;
    this.vehicle.destroyed = false;
    this.vehicle.occupied = false;
  }

  private throwGrenade(): void {
    if (this.inVehicle || this.grenadesRemaining <= 0 || this.phase !== "playing") return;
    this.grenadesRemaining -= 1;
    const material = new THREE.MeshStandardMaterial({
      color: 0x3c4638,
      metalness: 0.5,
      roughness: 0.58,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), material);
    mesh.position.copy(this.camera.position);
    const direction = this.camera.getWorldDirection(new THREE.Vector3());
    const velocity = direction.multiplyScalar(14);
    velocity.y += 4.2;
    this.scene.add(mesh);
    this.grenades.push({ mesh, velocity, fuse: 2.35, team: "blue" });
    this.callbacks.onNotice("GRENADE OUT", `${this.grenadesRemaining} remaining`);
  }

  private updateGrenades(dt: number): void {
    for (let index = this.grenades.length - 1; index >= 0; index -= 1) {
      const grenade = this.grenades[index];
      grenade.fuse -= dt;
      grenade.velocity.y -= 12.5 * dt;
      grenade.mesh.position.addScaledVector(grenade.velocity, dt);
      grenade.mesh.rotation.x += dt * 8;
      grenade.mesh.rotation.z += dt * 5;
      const ground =
        terrainHeight(grenade.mesh.position.x, grenade.mesh.position.z) + 0.1;
      if (grenade.mesh.position.y < ground) {
        grenade.mesh.position.y = ground;
        grenade.velocity.y = Math.abs(grenade.velocity.y) * 0.38;
        grenade.velocity.x *= 0.74;
        grenade.velocity.z *= 0.74;
      }
      if (grenade.fuse <= 0) {
        this.explodeGrenade(grenade);
        this.grenades.splice(index, 1);
      }
    }
  }

  private explodeGrenade(grenade: Grenade): void {
    const point = grenade.mesh.position.clone();
    this.scene.remove(grenade.mesh);
    grenade.mesh.geometry.dispose();
    (grenade.mesh.material as THREE.Material).dispose();
    this.createExplosion(point, 1);
    for (const bot of this.bots) {
      if (!bot.alive || bot.team === "blue") continue;
      const distance = bot.group.position.distanceTo(point);
      if (distance < 10) {
        this.damageBot(bot, Math.max(15, 125 * (1 - distance / 10)), false, "explosion");
      }
    }
    const playerDistance = this.playerPosition.distanceTo(point);
    if (playerDistance < 6) this.damagePlayer(28 * (1 - playerDistance / 6), point);
  }

  private useGadget(): void {
    if (this.gadgetCooldown > 0 || this.phase !== "playing") return;
    switch (this.currentClass.id) {
      case "medic":
        this.playerHealth = Math.min(100, this.playerHealth + 48);
        this.gadgetCooldown = 18;
        this.callbacks.onNotice("FIELD DRESSING", "+48 health");
        this.audio.uiTone(true);
        break;
      case "engineer": {
        const origin = this.camera.position.clone();
        const direction = this.camera.getWorldDirection(new THREE.Vector3());
        this.raycaster.set(origin, direction);
        this.raycaster.far = 115;
        const hit = this.raycaster.intersectObjects(this.world.staticMeshes, false)[0];
        const point = hit?.point ?? origin.addScaledVector(direction, 100);
        this.createTracer(this.camera.position, point, 0xffb34e);
        window.setTimeout(() => {
          this.createExplosion(point, 1.3);
          this.bots.forEach((bot) => {
            if (
              bot.alive &&
              bot.team === "red" &&
              bot.group.position.distanceTo(point) < 13
            ) {
              const distance = bot.group.position.distanceTo(point);
              this.damageBot(
                bot,
                Math.max(28, 140 * (1 - distance / 13)),
                false,
                "explosion",
              );
            }
          });
        }, 180);
        this.gadgetCooldown = 24;
        this.audio.gunshot(true);
        this.callbacks.onNotice("M3 LAUNCHED", "Impact");
        break;
      }
      case "recon":
        this.sensorRemaining = 14;
        this.gadgetCooldown = 22;
        this.callbacks.onNotice("SENSOR ACTIVE", "Hostiles marked for 14 seconds");
        this.audio.uiTone(true);
        break;
      default:
        this.reserve = Math.min(
          this.currentClass.weapon.reserve,
          this.reserve + this.currentClass.weapon.magazine * 2,
        );
        this.gadgetCooldown = 20;
        this.callbacks.onNotice("AMMO PACK", "Primary ammunition replenished");
        this.audio.uiTone(true);
    }
  }

  private createTracer(from: THREE.Vector3, to: THREE.Vector3, color: number): void {
    const geometry = new THREE.BufferGeometry().setFromPoints([from.clone(), to.clone()]);
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.92,
    });
    const line = new THREE.Line(geometry, material);
    this.scene.add(line);
    this.tracers.push({ line, life: 0.075 });
  }

  private ejectCasing(): void {
    const material = new THREE.MeshStandardMaterial({
      color: 0xa97b36,
      metalness: 0.82,
      roughness: 0.32,
      transparent: true,
    });
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.014, 0.018, 0.055, 8),
      material,
    );
    const forward = this.camera.getWorldDirection(new THREE.Vector3());
    const right = new THREE.Vector3(forward.z, 0, -forward.x).normalize();
    mesh.position
      .copy(this.camera.position)
      .addScaledVector(forward, 0.48)
      .addScaledVector(right, 0.18);
    mesh.position.y -= 0.11;
    mesh.rotation.set(
      this.random() * Math.PI,
      this.random() * Math.PI,
      this.random() * Math.PI,
    );
    this.scene.add(mesh);
    this.particles.push({
      mesh,
      velocity: right
        .multiplyScalar(1.8 + this.random() * 1.2)
        .add(
          new THREE.Vector3(
            (this.random() - 0.5) * 0.35,
            1.1 + this.random() * 0.8,
            (this.random() - 0.5) * 0.35,
          ),
        ),
      life: 0.85,
      maxLife: 0.85,
      gravity: 7.5,
      grow: 0,
    });
  }

  private createImpact(point: THREE.Vector3, normal: THREE.Vector3): void {
    this.audio.impact();
    const decalMaterial = new THREE.MeshBasicMaterial({
      color: 0x171512,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      side: THREE.DoubleSide,
    });
    const decal = new THREE.Mesh(
      new THREE.CircleGeometry(0.065 + this.random() * 0.055, 10),
      decalMaterial,
    );
    decal.position.copy(point).addScaledVector(normal, 0.012);
    decal.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      normal.clone().normalize(),
    );
    decal.rotation.z = this.random() * Math.PI;
    this.scene.add(decal);
    this.decals.push(decal);
    if (this.decals.length > 54) {
      const oldest = this.decals.shift();
      if (oldest) {
        this.scene.remove(oldest);
        oldest.geometry.dispose();
        if (oldest.material instanceof THREE.Material) {
          oldest.material.dispose();
        }
      }
    }
    for (let i = 0; i < 5; i += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: i < 2 ? 0xffc069 : 0x8a7358,
        transparent: true,
      });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.025 + this.random() * 0.035, 5, 4), material);
      mesh.position.copy(point);
      this.scene.add(mesh);
      const velocity = normal
        .clone()
        .multiplyScalar(1.2 + this.random() * 2)
        .add(
          new THREE.Vector3(
            (this.random() - 0.5) * 2,
            this.random() * 1.5,
            (this.random() - 0.5) * 2,
          ),
        );
      this.particles.push({
        mesh,
        velocity,
        life: 0.45,
        maxLife: 0.45,
        gravity: 5,
        grow: 0,
      });
    }
  }

  private createBloodMist(point: THREE.Vector3): void {
    for (let i = 0; i < 4; i += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: 0x7d3028,
        transparent: true,
      });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.035, 5, 4), material);
      mesh.position.copy(point);
      this.scene.add(mesh);
      this.particles.push({
        mesh,
        velocity: new THREE.Vector3(
          (this.random() - 0.5) * 2.2,
          this.random() * 1.8,
          (this.random() - 0.5) * 2.2,
        ),
        life: 0.38,
        maxLife: 0.38,
        gravity: 3,
        grow: 0.3,
      });
    }
  }

  private createExplosion(point: THREE.Vector3, scale: number): void {
    this.audio.explosion(scale);
    const colors = [0xffd27a, 0xff7b37, 0x3d3832];
    for (let i = 0; i < 26; i += 1) {
      const smoke = i > 11;
      const material = new THREE.MeshBasicMaterial({
        color: colors[smoke ? 2 : i % 2],
        transparent: true,
        opacity: smoke ? 0.5 : 0.95,
        depthWrite: false,
      });
      const size = (smoke ? 0.28 : 0.1) * scale * (0.6 + this.random());
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(size, 6, 5), material);
      mesh.position.copy(point);
      this.scene.add(mesh);
      const direction = new THREE.Vector3(
        this.random() - 0.5,
        this.random() * 0.9 + 0.2,
        this.random() - 0.5,
      )
        .normalize()
        .multiplyScalar((smoke ? 2.5 : 8) * scale * (0.55 + this.random()));
      this.particles.push({
        mesh,
        velocity: direction,
        life: smoke ? 1.5 + this.random() : 0.45 + this.random() * 0.25,
        maxLife: smoke ? 2.2 : 0.7,
        gravity: smoke ? -0.15 : 7.5,
        grow: smoke ? 1.4 : -0.2,
      });
    }
  }

  private updateParticles(dt: number): void {
    for (let index = this.particles.length - 1; index >= 0; index -= 1) {
      const particle = this.particles[index];
      particle.life -= dt;
      particle.velocity.y -= particle.gravity * dt;
      particle.mesh.position.addScaledVector(particle.velocity, dt);
      const material = particle.mesh.material as THREE.MeshBasicMaterial;
      material.opacity = clamp(particle.life / particle.maxLife, 0, 1);
      if (particle.grow !== 0) {
        const scale = Math.max(0.08, particle.mesh.scale.x + particle.grow * dt);
        particle.mesh.scale.setScalar(scale);
      }
      if (particle.life <= 0) {
        this.scene.remove(particle.mesh);
        particle.mesh.geometry.dispose();
        material.dispose();
        this.particles.splice(index, 1);
      }
    }
    for (let index = this.tracers.length - 1; index >= 0; index -= 1) {
      const tracer = this.tracers[index];
      tracer.life -= dt;
      const material = tracer.line.material as THREE.LineBasicMaterial;
      material.opacity = clamp(tracer.life / 0.075, 0, 1);
      if (tracer.life <= 0) {
        this.scene.remove(tracer.line);
        tracer.line.geometry.dispose();
        material.dispose();
        this.tracers.splice(index, 1);
      }
    }
  }

  private createAmbientSmoke(): void {
    const material = new THREE.MeshBasicMaterial({
      color: 0x6e675f,
      transparent: true,
      opacity: 0.085,
      depthWrite: false,
    });
    const sources = [
      [116, -91],
      [-28, -18],
      [45, 64],
    ];
    sources.forEach(([x, z], sourceIndex) => {
      for (let i = 0; i < 7; i += 1) {
        const mesh = new THREE.Mesh(
          new THREE.SphereGeometry(1.65 + i * 0.3, 9, 7),
          material.clone(),
        );
        const baseY = terrainHeight(x, z) + 5 + i * 4.2;
        mesh.position.set(x, baseY, z);
        this.scene.add(mesh);
        this.smokeColumns.push({
          mesh,
          baseY,
          phase: sourceIndex * 1.8 + i * 0.44,
        });
      }
    });
  }

  private updateAmbient(dt: number): void {
    for (const smoke of this.smokeColumns) {
      smoke.phase += dt * 0.22;
      smoke.mesh.position.x += Math.sin(smoke.phase) * dt * 0.25;
      smoke.mesh.position.z += Math.cos(smoke.phase * 0.7) * dt * 0.12;
      smoke.mesh.position.y =
        smoke.baseY + Math.sin(smoke.phase * 1.2) * 0.9;
      smoke.mesh.rotation.y += dt * 0.08;
    }
    if (this.vehicle.destroyed && this.elapsed >= this.vehicle.respawnAt) {
      this.resetVehicle();
      this.callbacks.onNotice("VEHICLE AVAILABLE", "KITE LRV redeployed at FOB Atlas");
    }
  }

  private updateInteractionHint(): void {
    const hint = document.getElementById("interaction-hint");
    if (!hint) return;
    if (this.inVehicle) {
      hint.textContent = "E  EXIT KITE LRV";
      hint.classList.add("is-visible");
    } else if (
      !this.vehicle.destroyed &&
      this.playerPosition.distanceTo(this.vehicle.group.position) < 5.2
    ) {
      hint.textContent = "E  ENTER KITE LRV";
      hint.classList.add("is-visible");
    } else {
      hint.classList.remove("is-visible");
    }
  }

  private showHitmarker(headshot: boolean, killed: boolean): void {
    const marker = document.getElementById("hitmarker");
    if (!marker) return;
    marker.dataset.type = killed ? "kill" : headshot ? "headshot" : "hit";
    marker.classList.remove("is-active");
    void marker.offsetWidth;
    marker.classList.add("is-active");
  }

  private addKillfeed(
    killer: string,
    victim: string,
    headshot = false,
    system = false,
  ): void {
    const feed = document.getElementById("killfeed");
    if (!feed) return;
    const row = document.createElement("div");
    row.className = system ? "kill-row system" : "kill-row";
    row.innerHTML = system
      ? `<span>${killer}</span><strong>${victim}</strong>`
      : `<span>${killer}</span><b>${headshot ? "◆" : "▸"}</b><strong>${victim}</strong>`;
    feed.prepend(row);
    while (feed.children.length > 5) feed.lastElementChild?.remove();
    window.setTimeout(() => row.remove(), 5200);
  }

  private updateHud(force: boolean): void {
    if (!force) {
      this.hudClock += 1 / 60;
      if (this.hudClock < 0.05) return;
    }
    this.hudClock = 0;
    this.setText("score-blue", Math.ceil(this.tickets.blue).toString().padStart(3, "0"));
    this.setText("score-red", Math.ceil(this.tickets.red).toString().padStart(3, "0"));
    this.setText("hud-kills", this.kills.toString());
    this.setText("hud-deaths", this.deaths.toString());
    this.setText(
      "health-value",
      Math.max(
        0,
        Math.ceil(this.inVehicle ? this.vehicle.health : this.playerHealth),
      ).toString(),
    );
    this.setText("health-label", this.inVehicle ? "ARMOR" : "HEALTH");
    const healthBar = document.getElementById("health-bar");
    if (healthBar) {
      const maximum = this.inVehicle ? this.vehicle.maxHealth : 100;
      healthBar.style.width = `${clamp(
        ((this.inVehicle ? this.vehicle.health : this.playerHealth) / maximum) * 100,
        0,
        100,
      )}%`;
    }
    this.setText("ammo-current", this.inVehicle ? "∞" : this.ammo.toString());
    this.setText("ammo-reserve", this.inVehicle ? "12.7 MM" : `/ ${this.reserve}`);
    this.setText(
      "weapon-name",
      this.inVehicle ? "KITE LRV RWS" : this.currentClass.weapon.shortName,
    );
    this.setText("grenade-count", this.inVehicle ? "—" : `× ${this.grenadesRemaining}`);
    this.setText(
      "gadget-state",
      this.gadgetCooldown > 0 ? `${Math.ceil(this.gadgetCooldown)}s` : "READY",
    );
    const heading = ((THREE.MathUtils.radToDeg(-this.yaw) % 360) + 360) % 360;
    const cardinal =
      heading < 22.5 || heading >= 337.5
        ? "N"
        : heading < 67.5
          ? "NE"
          : heading < 112.5
            ? "E"
            : heading < 157.5
              ? "SE"
              : heading < 202.5
                ? "S"
                : heading < 247.5
                  ? "SW"
                  : heading < 292.5
                    ? "W"
                    : "NW";
    this.setText("compass-heading", `${Math.round(heading).toString().padStart(3, "0")}° ${cardinal}`);

    this.world.objectives.forEach((objective) => {
      const element = document.getElementById(`objective-${objective.id}`);
      if (element) element.dataset.owner = objective.owner;
    });

    this.minimapClock += 0.05;
    if (this.minimapClock >= 0.1 || force) {
      this.minimapClock = 0;
      this.drawMinimap();
    }
  }

  private drawMinimap(): void {
    const canvas = document.getElementById("minimap") as HTMLCanvasElement | null;
    if (!canvas) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const cssSize = 188;
    if (canvas.width !== cssSize * ratio) {
      canvas.width = cssSize * ratio;
      canvas.height = cssSize * ratio;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, cssSize, cssSize);
    ctx.fillStyle = "rgba(12, 20, 23, .82)";
    ctx.fillRect(0, 0, cssSize, cssSize);
    ctx.strokeStyle = "rgba(203, 190, 154, .16)";
    ctx.lineWidth = 1;
    for (let i = 18; i < cssSize; i += 25) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, cssSize);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(cssSize, i);
      ctx.stroke();
    }
    ctx.save();
    ctx.translate(cssSize / 2, cssSize / 2);
    ctx.rotate(this.yaw);
    const scale = 0.58;
    const toMap = (position: THREE.Vector3) => ({
      x: (position.x - this.playerPosition.x) * scale,
      y: (position.z - this.playerPosition.z) * scale,
    });
    ctx.strokeStyle = "rgba(205, 192, 159, .3)";
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(-90, 55);
    ctx.lineTo(90, -58);
    ctx.stroke();
    for (const objective of this.world.objectives) {
      const point = toMap(objective.position);
      if (Math.abs(point.x) > 100 || Math.abs(point.y) > 100) continue;
      ctx.fillStyle =
        objective.owner === "blue"
          ? "#39c4f4"
          : objective.owner === "red"
            ? "#ff654f"
            : "#d9d3c7";
      ctx.beginPath();
      ctx.arc(point.x, point.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#081114";
      ctx.font = "700 9px Arial";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(objective.id, point.x, point.y + 0.5);
    }
    for (const bot of this.bots) {
      if (!bot.alive) continue;
      const point = toMap(bot.group.position);
      if (Math.abs(point.x) > 94 || Math.abs(point.y) > 94) continue;
      if (
        bot.team === "red" &&
        this.sensorRemaining <= 0 &&
        bot.group.position.distanceTo(this.playerPosition) > 42
      ) {
        continue;
      }
      ctx.fillStyle = bot.team === "blue" ? "#52cfff" : "#ff6756";
      ctx.fillRect(point.x - 2, point.y - 2, 4, 4);
    }
    if (!this.vehicle.destroyed && !this.inVehicle) {
      const point = toMap(this.vehicle.group.position);
      ctx.fillStyle = "#8be5ff";
      ctx.fillRect(point.x - 4, point.y - 3, 8, 6);
    }
    ctx.restore();
    ctx.save();
    ctx.translate(cssSize / 2, cssSize / 2);
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(5, 7);
    ctx.lineTo(0, 4);
    ctx.lineTo(-5, 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = "rgba(255,255,255,.34)";
    ctx.strokeRect(0.5, 0.5, cssSize - 1, cssSize - 1);
  }

  private setText(id: string, value: string): void {
    const element = document.getElementById(id);
    if (element && element.textContent !== value) element.textContent = value;
  }
}

function groundedLambda(grounded: boolean): number {
  return grounded ? 13 : 3.5;
}
