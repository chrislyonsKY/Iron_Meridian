"use client";

import { useEffect, useRef, useState } from "react";
import type { GameEngine } from "./engine";
import {
  CLASS_DEFINITIONS,
  type GamePhase,
  type SoldierClassId,
} from "./types";

const PHASE_COPY: Record<
  Exclude<GamePhase, "playing">,
  { eyebrow: string; title: string; detail: string }
> = {
  briefing: {
    eyebrow: "OPERATION GLASS HORIZON",
    title: "BREAK THE LINE",
    detail:
      "Coalition forces are pushing through the Kharif Valley. Capture and hold all three sectors before your reinforcement tickets run out.",
  },
  paused: {
    eyebrow: "TACTICAL PAUSE",
    title: "OPERATION HELD",
    detail:
      "The battle is still active. Review your controls, adjust your loadout, then return to the fight.",
  },
  dead: {
    eyebrow: "KILLED IN ACTION",
    title: "REDEPLOY",
    detail:
      "Select a class and re-enter at the most advanced friendly-controlled sector.",
  },
  victory: {
    eyebrow: "OPERATION COMPLETE",
    title: "SECTOR SECURED",
    detail:
      "Enemy reinforcements are exhausted. Your unit controls the Kharif Valley corridor.",
  },
  defeat: {
    eyebrow: "OPERATION FAILED",
    title: "LINE COLLAPSED",
    detail:
      "Coalition reinforcements are exhausted. Regroup and launch a new operation.",
  },
};

export default function GameClient() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const [phase, setPhase] = useState<GamePhase>("briefing");
  const [selectedClass, setSelectedClass] =
    useState<SoldierClassId>("assault");
  const [notice, setNotice] = useState({
    title: "CONQUEST",
    detail: "250 TICKETS",
    visible: false,
  });
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [engineReady, setEngineReady] = useState(false);
  const [graphicsUnavailable, setGraphicsUnavailable] = useState(false);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let engine: GameEngine | null = null;
    let graphicsFallbackTimer: number | null = null;
    let disposed = false;

    const markGraphicsUnavailable = () => {
      if (disposed) return;
      graphicsFallbackTimer = window.setTimeout(
        () => setGraphicsUnavailable(true),
        0,
      );
    };

    void import("./engine")
      .then(({ GameEngine: BrowserGameEngine }) => {
        if (disposed) return;
        try {
          engine = new BrowserGameEngine(viewport, {
            onPhase: setPhase,
            onNotice: (title, detail) => {
              setNotice({ title, detail: detail ?? "", visible: true });
              if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
              noticeTimer.current = window.setTimeout(() => {
                setNotice((current) => ({ ...current, visible: false }));
              }, 2400);
            },
          });
          engineRef.current = engine;
          setEngineReady(true);
        } catch {
          markGraphicsUnavailable();
        }
      })
      .catch(markGraphicsUnavailable);

    return () => {
      disposed = true;
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
      if (graphicsFallbackTimer) window.clearTimeout(graphicsFallbackTimer);
      engine?.dispose();
      engineRef.current = null;
    };
  }, []);

  const launch = () => {
    if (phase === "paused") {
      engineRef.current?.resume();
      return;
    }
    if (phase === "victory" || phase === "defeat") {
      engineRef.current?.restart(selectedClass);
      return;
    }
    engineRef.current?.deploy(selectedClass);
  };

  const selectedDefinition =
    CLASS_DEFINITIONS.find((entry) => entry.id === selectedClass) ??
    CLASS_DEFINITIONS[0];
  const overlayCopy = phase === "playing" ? null : PHASE_COPY[phase];
  const actionLabel =
    phase === "briefing"
      ? "DEPLOY TO BATTLE"
      : phase === "paused"
        ? "RESUME OPERATION"
        : phase === "dead"
          ? "REDEPLOY NOW"
          : "NEW OPERATION";

  return (
    <main className="game-shell">
      <div ref={viewportRef} className="game-viewport" />
      {graphicsUnavailable && (
        <div className="graphics-warning" role="status">
          <strong>WEBGL 2 GRAPHICS UNAVAILABLE</strong>
          <span>
            Open Iron Meridian in a current hardware-accelerated browser to deploy.
          </span>
        </div>
      )}

      <div id="damage-vignette" className="damage-vignette" aria-hidden="true" />
      <div id="damage-indicator" className="damage-indicator" aria-hidden="true">
        <span />
      </div>

      <section
        className={`battle-hud ${phase === "playing" ? "is-active" : ""}`}
        aria-label="Battle status"
      >
        <div className="hud-brand">
          <span className="brand-mark" aria-hidden="true">
            IM
          </span>
          <div>
            <strong>IRON MERIDIAN</strong>
            <span>Kharif Valley · 18:42</span>
          </div>
        </div>

        <div className="scoreboard" aria-label="Reinforcement tickets">
          <div className="team-score blue">
            <span>COALITION</span>
            <strong id="score-blue">250</strong>
          </div>
          <div className="sector-strip" aria-label="Control sectors">
            <span id="objective-A" className="objective-chip" data-owner="blue">
              A
            </span>
            <span id="objective-B" className="objective-chip" data-owner="neutral">
              B
            </span>
            <span id="objective-C" className="objective-chip" data-owner="red">
              C
            </span>
          </div>
          <div className="team-score red">
            <span>VANGUARD</span>
            <strong id="score-red">250</strong>
          </div>
        </div>

        <div className="compass">
          <span>W</span>
          <i />
          <strong id="compass-heading">000° N</strong>
          <i />
          <span>E</span>
        </div>

        <div id="killfeed" className="killfeed" aria-live="polite" />

        <div className="squad-panel">
          <div className="squad-heading">
            <span>ALPHA SQUAD</span>
            <b>4 / 4</b>
          </div>
          <ul>
            <li>
              <span className="squad-class">A</span>
              <span>YOU</span>
              <small>LIVE</small>
            </li>
            <li>
              <span className="squad-class">M</span>
              <span>MORROW</span>
              <small>LIVE</small>
            </li>
            <li>
              <span className="squad-class">E</span>
              <span>VEGA</span>
              <small>LIVE</small>
            </li>
            <li>
              <span className="squad-class">R</span>
              <span>ITO</span>
              <small>LIVE</small>
            </li>
          </ul>
        </div>

        <div className="minimap-wrap">
          <canvas id="minimap" aria-label="Tactical minimap" />
          <div className="map-coordinate">
            <span>GRID</span>
            <strong>KH-07</strong>
          </div>
          <div className="combat-stats">
            <span>
              K <strong id="hud-kills">0</strong>
            </span>
            <span>
              D <strong id="hud-deaths">0</strong>
            </span>
          </div>
        </div>

        <div className="health-module">
          <div className="module-label">
            <span id="health-label">HEALTH</span>
            <b>ALPHA 1</b>
          </div>
          <div className="health-value">
            <strong id="health-value">100</strong>
            <span>%</span>
          </div>
          <div className="meter">
            <i id="health-bar" />
          </div>
        </div>

        <div className="ammo-module">
          <div className="weapon-line">
            <span id="weapon-name">ARX-21</span>
            <b>AUTO</b>
          </div>
          <div className="ammo-line">
            <strong id="ammo-current">30</strong>
            <span id="ammo-reserve">/ 150</span>
          </div>
          <div className="equipment-line">
            <span>FRAG <b id="grenade-count">× 2</b></span>
            <span>GADGET <b id="gadget-state">READY</b></span>
          </div>
        </div>

        <div
          id="scope-overlay"
          className="scope-overlay"
          data-optic="combat"
          aria-hidden="true"
        >
          <div className="scope-frame">
            <div className="scope-glass">
              <svg
                className="scope-reticle"
                viewBox="0 0 200 200"
                role="presentation"
              >
                <circle cx="100" cy="100" r="94" className="scope-edge-line" />
                <line x1="13" y1="100" x2="78" y2="100" />
                <line x1="122" y1="100" x2="187" y2="100" />
                <line x1="100" y1="13" x2="100" y2="77" />
                <line x1="100" y1="123" x2="100" y2="187" />
                <path className="scope-chevron" d="M92 92 L100 102 L108 92" />
                <g className="scope-stadia">
                  <line x1="84" y1="116" x2="116" y2="116" />
                  <line x1="89" y1="130" x2="111" y2="130" />
                  <line x1="93" y1="144" x2="107" y2="144" />
                  <circle cx="100" cy="158" r="1.8" />
                  <circle cx="100" cy="172" r="1.5" />
                </g>
              </svg>
              <span className="scope-zoom">1.75×</span>
              <span className="scope-zero">ZERO 100 M</span>
            </div>
          </div>
        </div>

        <div className="vehicle-overlay" aria-hidden="true">
          <div className="vehicle-topline">
            <span>MARAUDER 6×6</span>
            <b>RWS / STABILIZED</b>
          </div>
          <div className="vehicle-reticle">
            <i />
            <i />
            <span />
          </div>
          <div className="vehicle-telemetry">
            <span>
              SPD <b id="vehicle-speed">00</b> KPH
            </span>
            <span>
              HDG <b id="vehicle-bearing">000°</b>
            </span>
            <span>
              AP <b>12.7×99</b>
            </span>
          </div>
        </div>

        <div className="crosshair" aria-hidden="true">
          <i className="crosshair-top" />
          <i className="crosshair-right" />
          <i className="crosshair-bottom" />
          <i className="crosshair-left" />
          <span />
        </div>
        <div id="hitmarker" className="hitmarker" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </div>

        <div id="capture-status" className="capture-status">
          <span id="capture-label">CAPTURING OBJECTIVE</span>
          <div>
            <i id="capture-bar" data-team="blue" />
          </div>
        </div>

        <div id="interaction-hint" className="interaction-hint">
          E&nbsp; ENTER VEHICLE
        </div>

        <div className="desktop-controls">
          <span>
            <kbd>WASD</kbd> MOVE
          </span>
          <span>
            <kbd>SHIFT</kbd> SPRINT
          </span>
          <span>
            <kbd>RMB</kbd> AIM
          </span>
          <span>
            <kbd>G</kbd> GRENADE
          </span>
          <span>
            <kbd>Q</kbd> GADGET
          </span>
          <span>
            <kbd>E</kbd> VEHICLE
          </span>
        </div>
      </section>

      <div className={`battle-notice ${notice.visible ? "is-visible" : ""}`} aria-live="polite">
        <span>{notice.title}</span>
        {notice.detail && <strong>{notice.detail}</strong>}
      </div>

      <div className="touch-interface" aria-label="Touch controls">
        <div id="move-pad" className="touch-control move-pad" aria-label="Movement joystick">
          <i />
          <span id="move-nub" />
        </div>
        <button id="touch-gadget" className="touch-control touch-gadget" aria-label="Use gadget">
          Q
        </button>
        <button id="touch-use" className="touch-control touch-use" aria-label="Interact">
          USE
        </button>
        <button id="touch-reload" className="touch-control touch-reload" aria-label="Reload">
          R
        </button>
        <button id="touch-jump" className="touch-control touch-jump" aria-label="Jump">
          ↑
        </button>
        <button id="touch-ads" className="touch-control touch-ads" aria-label="Aim down sights">
          ADS
        </button>
        <button id="touch-fire" className="touch-control touch-fire" aria-label="Fire weapon">
          FIRE
        </button>
      </div>

      {overlayCopy && (
        <section className={`deployment-overlay phase-${phase}`}>
          <header className="deployment-header">
            <div className="deployment-logo">
              <span className="brand-mark">IM</span>
              <div>
                <strong>IRON MERIDIAN</strong>
                <small>COMBINED ARMS COMMAND</small>
              </div>
            </div>
            <div className="header-status">
              <span>EU EAST</span>
              <i />
              <strong>CONQUEST 16</strong>
              <button
                type="button"
                className="sound-toggle"
                aria-pressed={soundEnabled}
                onClick={() => {
                  const next = !soundEnabled;
                  setSoundEnabled(next);
                  engineRef.current?.toggleAudio(next);
                }}
              >
                SOUND {soundEnabled ? "ON" : "OFF"}
              </button>
            </div>
          </header>

          <div className="deployment-grid">
            <div className="mission-panel">
              <span className="eyebrow">{overlayCopy.eyebrow}</span>
              <h1>{overlayCopy.title}</h1>
              <p>{overlayCopy.detail}</p>

              <div className="mission-data">
                <div>
                  <span>MODE</span>
                  <strong>CONQUEST</strong>
                </div>
                <div>
                  <span>THEATER</span>
                  <strong>KHARIF VALLEY</strong>
                </div>
                <div>
                  <span>FORCE</span>
                  <strong>ALPHA SQUAD</strong>
                </div>
              </div>

              <div className="sector-route" aria-label="Mission sectors">
                <div className="route-sector blue">
                  <b>A</b>
                  <span>FOB ATLAS</span>
                </div>
                <i />
                <div className="route-sector neutral">
                  <b>B</b>
                  <span>RELAY STATION</span>
                </div>
                <i />
                <div className="route-sector red">
                  <b>C</b>
                  <span>FUEL DEPOT</span>
                </div>
              </div>
            </div>

            <aside className="loadout-panel">
              <div className="panel-heading">
                <span>SELECT LOADOUT</span>
                <small>01 / 04</small>
              </div>
              <div className="class-grid">
                {CLASS_DEFINITIONS.map((entry, index) => (
                  <button
                    type="button"
                    key={entry.id}
                    className={`class-card ${selectedClass === entry.id ? "is-selected" : ""}`}
                    onClick={() => setSelectedClass(entry.id)}
                    aria-pressed={selectedClass === entry.id}
                  >
                    <span className="class-index">0{index + 1}</span>
                    <span className="class-icon" aria-hidden="true">
                      {entry.name.charAt(0)}
                    </span>
                    <span className="class-copy">
                      <strong>{entry.name}</strong>
                      <small>{entry.role}</small>
                    </span>
                  </button>
                ))}
              </div>

              <div className="weapon-preview">
                <div className="weapon-silhouette" aria-hidden="true">
                  <i className="stock" />
                  <i className="receiver" />
                  <i className="barrel" />
                  <i className="mag" />
                  <i className="sight" />
                </div>
                <div className="weapon-data">
                  <span>PRIMARY WEAPON</span>
                  <strong>{selectedDefinition.weapon.name}</strong>
                  <small>{selectedDefinition.description}</small>
                </div>
                <div className="stat-bars">
                  <span>
                    DAMAGE <i style={{ width: `${selectedDefinition.weapon.damage * 1.15}%` }} />
                  </span>
                  <span>
                    CONTROL{" "}
                    <i
                      style={{
                        width: `${Math.max(36, 92 - selectedDefinition.weapon.spread * 2200)}%`,
                      }}
                    />
                  </span>
                  <span>
                    RANGE{" "}
                    <i
                      style={{
                        width: `${Math.min(100, selectedDefinition.weapon.range * 0.65)}%`,
                      }}
                    />
                  </span>
                </div>
                <div className="gadget-readout">
                  <span>GADGET</span>
                  <strong>{selectedDefinition.gadget}</strong>
                </div>
              </div>

              <div className="spawn-readout">
                <span>SPAWN POINT</span>
                <strong>AUTO · FURTHEST FRIENDLY SECTOR</strong>
                <small>Squad spawn safe · Vehicle available at FOB Atlas</small>
              </div>

              <button
                type="button"
                className="deploy-button"
                onClick={launch}
                disabled={graphicsUnavailable || !engineReady}
              >
                <span>
                  {graphicsUnavailable
                    ? "WEBGL 2 REQUIRED"
                    : engineReady
                      ? actionLabel
                      : "INITIALIZING BATTLEFIELD"}
                </span>
                <b>↗</b>
              </button>
            </aside>
          </div>

          <footer className="deployment-footer">
            <span>
              <b>WASD</b> MOVE
            </span>
            <span>
              <b>MOUSE</b> LOOK
            </span>
            <span>
              <b>LMB</b> FIRE
            </span>
            <span>
              <b>RMB</b> AIM
            </span>
            <span>
              <b>R</b> RELOAD
            </span>
            <span>
              <b>SPACE</b> JUMP
            </span>
            <span className="build-label">
              FIELD BUILD 1.4.0 · COMBAT SYSTEMS PASS
            </span>
          </footer>
        </section>
      )}
    </main>
  );
}
