import type * as THREE from "three";

export type Team = "blue" | "red";
export type GamePhase =
  | "briefing"
  | "playing"
  | "paused"
  | "dead"
  | "victory"
  | "defeat";

export type SoldierClassId = "assault" | "medic" | "engineer" | "recon";

export interface WeaponDefinition {
  name: string;
  shortName: string;
  damage: number;
  fireRate: number;
  magazine: number;
  reserve: number;
  reloadTime: number;
  spread: number;
  adsSpread: number;
  range: number;
  automatic: boolean;
  color: number;
}

export interface SoldierClassDefinition {
  id: SoldierClassId;
  name: string;
  role: string;
  description: string;
  weapon: WeaponDefinition;
  gadget: string;
}

export interface ObjectiveState {
  id: "A" | "B" | "C";
  name: string;
  position: THREE.Vector3;
  radius: number;
  capture: number;
  owner: Team | "neutral";
  previousOwner: Team | "neutral";
  marker: THREE.Group;
  pulse: THREE.Mesh;
}

export interface Collider {
  box: THREE.Box3;
  mesh: THREE.Object3D;
  surface: "concrete" | "metal" | "wood" | "sand" | "glass";
}

export interface GameCallbacks {
  onPhase: (phase: GamePhase) => void;
  onNotice: (title: string, detail?: string) => void;
}

export const CLASS_DEFINITIONS: SoldierClassDefinition[] = [
  {
    id: "assault",
    name: "Assault",
    role: "Frontline",
    description: "Balanced rifle, fragmentation grenade, fast handling.",
    gadget: "M67 Frag",
    weapon: {
      name: "ARX-21 Service Rifle",
      shortName: "ARX-21",
      damage: 31,
      fireRate: 720,
      magazine: 30,
      reserve: 150,
      reloadTime: 2.25,
      spread: 0.012,
      adsSpread: 0.0025,
      range: 115,
      automatic: true,
      color: 0x2b302f,
    },
  },
  {
    id: "medic",
    name: "Medic",
    role: "Combat support",
    description: "Stable carbine, self-heal field, rapid recovery.",
    gadget: "Field Medkit",
    weapon: {
      name: "K7 Compact Carbine",
      shortName: "K7",
      damage: 25,
      fireRate: 850,
      magazine: 36,
      reserve: 180,
      reloadTime: 1.9,
      spread: 0.016,
      adsSpread: 0.003,
      range: 88,
      automatic: true,
      color: 0x25333a,
    },
  },
  {
    id: "engineer",
    name: "Engineer",
    role: "Vehicle denial",
    description: "Heavy SMG, anti-armor launcher, resilient armor.",
    gadget: "M3 Launcher",
    weapon: {
      name: "Vektor-9 PDW",
      shortName: "VEKTOR-9",
      damage: 23,
      fireRate: 930,
      magazine: 40,
      reserve: 200,
      reloadTime: 2.1,
      spread: 0.019,
      adsSpread: 0.004,
      range: 72,
      automatic: true,
      color: 0x30312c,
    },
  },
  {
    id: "recon",
    name: "Recon",
    role: "Precision",
    description: "Semi-auto marksman rifle, sensor flare, long reach.",
    gadget: "Motion Sensor",
    weapon: {
      name: "S-14 Marksman Rifle",
      shortName: "S-14",
      damage: 58,
      fireRate: 270,
      magazine: 12,
      reserve: 72,
      reloadTime: 2.7,
      spread: 0.006,
      adsSpread: 0.0007,
      range: 180,
      automatic: false,
      color: 0x34312a,
    },
  },
];

