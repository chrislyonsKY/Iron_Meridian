export type WeaponSoundProfile =
  | "rifle"
  | "carbine"
  | "lmg"
  | "dmr"
  | "launcher"
  | "vehicle";

export type ImpactSurface =
  | "concrete"
  | "metal"
  | "wood"
  | "sand"
  | "dirt"
  | "glass"
  | "flesh";

export type WeaponAction =
  | "dry"
  | "magout"
  | "magin"
  | "charge"
  | "selector";

interface ShotProfile {
  crack: number;
  body: number;
  sub: number;
  duration: number;
  punch: number;
  tail: number;
  mechanical: number;
}

const SHOT_PROFILES: Record<WeaponSoundProfile, ShotProfile> = {
  rifle: {
    crack: 3800,
    body: 920,
    sub: 112,
    duration: 0.115,
    punch: 0.74,
    tail: 0.34,
    mechanical: 0.12,
  },
  carbine: {
    crack: 4300,
    body: 1180,
    sub: 132,
    duration: 0.09,
    punch: 0.66,
    tail: 0.28,
    mechanical: 0.15,
  },
  lmg: {
    crack: 3300,
    body: 690,
    sub: 82,
    duration: 0.15,
    punch: 0.88,
    tail: 0.4,
    mechanical: 0.18,
  },
  dmr: {
    crack: 3500,
    body: 610,
    sub: 74,
    duration: 0.18,
    punch: 1,
    tail: 0.46,
    mechanical: 0.1,
  },
  launcher: {
    crack: 1480,
    body: 320,
    sub: 46,
    duration: 0.28,
    punch: 1.08,
    tail: 0.62,
    mechanical: 0.08,
  },
  vehicle: {
    crack: 2900,
    body: 510,
    sub: 58,
    duration: 0.2,
    punch: 1.12,
    tail: 0.52,
    mechanical: 0.2,
  },
};

const IMPACT_PROFILE: Record<
  ImpactSurface,
  { frequency: number; decay: number; tone: OscillatorType; grit: number }
> = {
  concrete: { frequency: 980, decay: 0.09, tone: "triangle", grit: 0.2 },
  metal: { frequency: 2350, decay: 0.24, tone: "square", grit: 0.12 },
  wood: { frequency: 560, decay: 0.13, tone: "triangle", grit: 0.19 },
  sand: { frequency: 260, decay: 0.12, tone: "sine", grit: 0.34 },
  dirt: { frequency: 330, decay: 0.1, tone: "sine", grit: 0.3 },
  glass: { frequency: 4200, decay: 0.2, tone: "sine", grit: 0.16 },
  flesh: { frequency: 180, decay: 0.08, tone: "sine", grit: 0.22 },
};

/**
 * Compact procedural combat mix inspired by the reference repository's audio
 * topology: layered transients, separate mix buses, a synthetic convolution
 * tail, distance filtering, mechanical foley and persistent battlefield beds.
 * It intentionally keeps the public API small enough for Iron Meridian's
 * single-engine architecture.
 */
export class BattlefieldAudio {
  private context: AudioContext | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private master: GainNode | null = null;
  private mix: GainNode | null = null;
  private reverbSend: GainNode | null = null;
  private buses: Partial<Record<"weapons" | "foley" | "ambience" | "ui", GainNode>> =
    {};
  private wind: AudioBufferSourceNode[] = [];
  private enabled = true;
  private battlefieldClock = 1.6;
  private randomState = 0x8a5cd789;

  private vehicleGain: GainNode | null = null;
  private vehicleFilter: BiquadFilterNode | null = null;
  private vehicleOscillators: OscillatorNode[] = [];
  private vehicleNoise: AudioBufferSourceNode | null = null;
  private vehicleNoiseGain: GainNode | null = null;

  async unlock(): Promise<void> {
    if (!this.enabled) return;
    if (!this.context) this.createContext();
    if (this.context?.state === "suspended") await this.context.resume();
    if (this.wind.length === 0) this.startWind();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!this.master || !this.context) return;
    this.master.gain.setTargetAtTime(
      enabled ? 0.78 : 0.0001,
      this.context.currentTime,
      0.035,
    );
  }

  gunshot(profileName: WeaponSoundProfile = "rifle"): void {
    if (!this.ready()) return;
    const ctx = this.context!;
    const now = ctx.currentTime;
    const profile = SHOT_PROFILES[profileName];

    // Supersonic muzzle crack: short, bright and directional in perception.
    this.noiseBurst({
      when: now,
      duration: 0.024,
      frequency: profile.crack,
      type: "highpass",
      gain: profile.punch * 0.78,
      attack: 0.0004,
      rate: 1.22,
      bus: "weapons",
      send: profile.tail * 0.16,
    });

    // Propellant body: a wider band that gives each weapon its calibre.
    this.noiseBurst({
      when: now + 0.002,
      duration: profile.duration,
      frequency: profile.body,
      type: "bandpass",
      q: 0.62,
      gain: profile.punch,
      attack: 0.0008,
      rate: profileName === "vehicle" ? 0.62 : 0.82,
      bus: "weapons",
      send: profile.tail,
    });

    // Low pressure pulse. The short pitch dive prevents a synthetic sine read.
    this.tone({
      when: now,
      duration: profile.duration + 0.055,
      from: profile.sub * 1.45,
      to: profile.sub * 0.5,
      gain: profile.punch * 0.38,
      type: "triangle",
      bus: "weapons",
      send: 0,
    });

    // Bolt/receiver action arrives just behind the gas transient.
    this.noiseBurst({
      when: now + 0.014,
      duration: 0.032,
      frequency: 2650,
      type: "bandpass",
      q: 2.8,
      gain: profile.mechanical,
      attack: 0.001,
      rate: 1.75,
      bus: "foley",
      send: 0.035,
    });

    // Two early-reflection taps give an outdoor street-canyon slap without
    // waiting for the longer convolution return to become audible.
    for (const [delay, gain, pan] of [
      [0.058, profile.tail * 0.12, -0.32],
      [0.104, profile.tail * 0.075, 0.38],
    ] as const) {
      this.noiseBurst({
        when: now + delay,
        duration: 0.07,
        frequency: Math.max(420, profile.body * 0.72),
        type: "bandpass",
        q: 0.8,
        gain,
        attack: 0.002,
        rate: 0.72,
        pan,
        bus: "weapons",
        send: profile.tail * 0.42,
      });
    }
  }

  enemyShot(
    distance: number,
    pan: number,
    profileName: WeaponSoundProfile = "rifle",
  ): void {
    if (!this.ready() || distance > 170) return;
    const ctx = this.context!;
    const now = ctx.currentTime;
    const profile = SHOT_PROFILES[profileName];
    const side = Math.max(-1, Math.min(1, pan));
    const attenuation = Math.max(0.04, 1 / (1 + distance * 0.035));
    const airCutoff = Math.max(620, 6400 - distance * 36);

    // The near supersonic snap reaches the player before the distant report.
    if (distance < 68) {
      this.noiseBurst({
        when: now,
        duration: 0.018,
        frequency: Math.max(3200, airCutoff),
        type: "highpass",
        gain: 0.16 * (1 - distance / 100),
        attack: 0.0003,
        rate: 1.7,
        pan: side * 0.72,
        bus: "weapons",
        send: 0.05,
      });
    }

    const arrival = now + Math.min(0.42, distance / 343);
    this.noiseBurst({
      when: arrival,
      duration: profile.duration * 1.4,
      frequency: Math.min(profile.body, airCutoff),
      type: "bandpass",
      q: 0.72,
      gain: profile.punch * attenuation * 0.9,
      attack: 0.001,
      rate: 0.68,
      pan: side,
      bus: "weapons",
      send: 0.34 + Math.min(0.46, distance / 220),
    });
    this.tone({
      when: arrival,
      duration: 0.12,
      from: profile.sub,
      to: profile.sub * 0.55,
      gain: attenuation * 0.13,
      type: "triangle",
      pan: side,
      bus: "weapons",
      send: 0.18,
    });
  }

  explosion(intensity = 1): void {
    if (!this.ready()) return;
    const ctx = this.context!;
    const now = ctx.currentTime;
    const strength = Math.max(0.25, Math.min(1.65, intensity));

    this.noiseBurst({
      when: now,
      duration: 0.82 + strength * 0.18,
      frequency: 1180,
      endFrequency: 105,
      type: "lowpass",
      gain: 0.78 * strength,
      attack: 0.001,
      rate: 0.42,
      bus: "weapons",
      send: 0.72,
    });
    this.noiseBurst({
      when: now + 0.006,
      duration: 0.14,
      frequency: 2700,
      type: "bandpass",
      q: 0.46,
      gain: 0.34 * strength,
      attack: 0.0005,
      rate: 1.12,
      bus: "weapons",
      send: 0.3,
    });
    this.tone({
      when: now,
      duration: 0.74,
      from: 78,
      to: 24,
      gain: 0.7 * strength,
      type: "triangle",
      bus: "weapons",
      send: 0.06,
    });

    // Rolling secondary return.
    this.noiseBurst({
      when: now + 0.22,
      duration: 0.74,
      frequency: 260,
      type: "lowpass",
      gain: 0.26 * strength,
      attack: 0.03,
      rate: 0.34,
      pan: (this.random() - 0.5) * 0.9,
      bus: "weapons",
      send: 0.86,
    });
  }

  impact(surface: ImpactSurface = "concrete", pan = 0): void {
    if (!this.ready()) return;
    const ctx = this.context!;
    const now = ctx.currentTime;
    const profile = IMPACT_PROFILE[surface] ?? IMPACT_PROFILE.concrete;
    const soft = surface === "sand" || surface === "dirt" || surface === "flesh";

    this.noiseBurst({
      when: now,
      duration: profile.decay,
      frequency: profile.frequency,
      type: soft ? "lowpass" : "bandpass",
      q: soft ? 0.5 : 2.1,
      gain: profile.grit,
      attack: 0.0008,
      rate: soft ? 0.62 : 1.28,
      pan,
      bus: "foley",
      send: soft ? 0.08 : 0.24,
    });
    this.tone({
      when: now,
      duration: profile.decay,
      from: profile.frequency * (surface === "metal" ? 1.2 : 0.62),
      to: Math.max(90, profile.frequency * 0.3),
      gain: soft ? 0.025 : 0.08,
      type: profile.tone,
      pan,
      bus: "foley",
      send: surface === "metal" ? 0.38 : 0.1,
    });

    if (surface === "glass") {
      for (let index = 0; index < 3; index += 1) {
        this.tone({
          when: now + 0.012 + index * 0.018,
          duration: 0.12,
          from: 3100 + index * 870,
          to: 1700 + index * 420,
          gain: 0.028,
          type: "sine",
          pan: Math.max(-1, Math.min(1, pan + (this.random() - 0.5) * 0.5)),
          bus: "foley",
          send: 0.32,
        });
      }
    }
  }

  weaponAction(action: WeaponAction): void {
    if (!this.ready()) return;
    const ctx = this.context!;
    const now = ctx.currentTime;

    if (action === "dry") {
      this.tone({
        when: now,
        duration: 0.035,
        from: 1850,
        to: 920,
        gain: 0.075,
        type: "square",
        bus: "foley",
        send: 0.015,
      });
      return;
    }

    const timing: Record<Exclude<WeaponAction, "dry">, [number, number, number]> = {
      magout: [560, 0.11, 0.12],
      magin: [740, 0.09, 0.16],
      charge: [1280, 0.105, 0.17],
      selector: [2150, 0.025, 0.07],
    };
    const [frequency, duration, level] = timing[action];
    this.noiseBurst({
      when: now,
      duration,
      frequency,
      type: "bandpass",
      q: 2.4,
      gain: level,
      attack: 0.001,
      rate: action === "charge" ? 0.74 : 1.1,
      bus: "foley",
      send: 0.08,
    });
    this.tone({
      when: now + duration * 0.46,
      duration: Math.min(0.055, duration),
      from: frequency * 1.25,
      to: frequency * 0.62,
      gain: level * 0.38,
      type: "triangle",
      bus: "foley",
      send: 0.02,
    });
  }

  footstep(
    running: boolean,
    surface: ImpactSurface = "sand",
  ): void {
    if (!this.ready()) return;
    const ctx = this.context!;
    const now = ctx.currentTime;
    const hard = surface === "metal" || surface === "concrete" || surface === "wood";
    const level = running ? 0.13 : 0.082;
    this.noiseBurst({
      when: now,
      duration: running ? 0.095 : 0.075,
      frequency: hard ? 640 : 220,
      type: "lowpass",
      gain: level,
      attack: 0.002,
      rate: hard ? 1.05 : 0.62,
      pan: (this.random() - 0.5) * 0.12,
      bus: "foley",
      send: hard ? 0.09 : 0.025,
    });
    this.tone({
      when: now,
      duration: 0.065,
      from: running ? 96 : 78,
      to: 46,
      gain: level * 0.55,
      type: "sine",
      bus: "foley",
      send: 0,
    });
  }

  uiTone(success = true): void {
    if (!this.ready()) return;
    const ctx = this.context!;
    const now = ctx.currentTime;
    [0, 0.055].forEach((offset, index) => {
      this.tone({
        when: now + offset,
        duration: 0.105,
        from: success ? 520 + index * 210 : 310 - index * 70,
        to: success ? 570 + index * 230 : 250 - index * 50,
        gain: 0.075,
        type: "sine",
        bus: "ui",
        send: 0.025,
      });
    });
  }

  /**
   * Maintains a multi-layer diesel loop. Calling this every frame is cheap:
   * only AudioParam targets move after the graph is created.
   */
  setVehicleEngine(active: boolean, speed = 0, throttle = 0): void {
    if (!this.ready()) return;
    if (!active && !this.vehicleGain) return;
    if (!this.vehicleGain) this.startVehicleEngine();
    if (!this.vehicleGain || !this.vehicleFilter || !this.context) return;
    const now = this.context.currentTime;
    const load = Math.max(0, Math.min(1, Math.abs(speed) / 18));
    const pedal = Math.max(0, Math.min(1, Math.abs(throttle)));
    const rpm = 34 + load * 54 + pedal * 16;
    const level = active ? 0.055 + load * 0.09 + pedal * 0.045 : 0.0001;

    this.vehicleGain.gain.setTargetAtTime(level, now, active ? 0.07 : 0.22);
    this.vehicleFilter.frequency.setTargetAtTime(260 + load * 820 + pedal * 260, now, 0.09);
    this.vehicleOscillators.forEach((oscillator, index) => {
      const harmonic = index === 0 ? 1 : index === 1 ? 2.03 : 5.7;
      oscillator.frequency.setTargetAtTime(rpm * harmonic, now, 0.08);
    });
    this.vehicleNoiseGain?.gain.setTargetAtTime(
      active ? 0.012 + load * 0.035 : 0.0001,
      now,
      0.12,
    );
  }

  /**
   * Schedules distant artillery and rifle exchanges so the level never drops
   * into an acoustically empty state between nearby firefights.
   */
  updateBattlefield(dt: number, intensity = 0.45): void {
    if (!this.ready()) return;
    this.battlefieldClock -= dt;
    if (this.battlefieldClock > 0) return;
    const combat = Math.max(0.12, Math.min(1, intensity));
    this.battlefieldClock = (2.4 + this.random() * 4.2) / (0.55 + combat);
    const side = this.random() * 2 - 1;

    if (this.random() < 0.36) {
      const ctx = this.context!;
      const now = ctx.currentTime;
      this.noiseBurst({
        when: now,
        duration: 1.15,
        frequency: 210,
        endFrequency: 74,
        type: "lowpass",
        gain: 0.055 + combat * 0.055,
        attack: 0.018,
        rate: 0.32,
        pan: side,
        bus: "ambience",
        send: 0.82,
      });
      this.tone({
        when: now,
        duration: 0.72,
        from: 54,
        to: 28,
        gain: 0.045 + combat * 0.035,
        type: "sine",
        pan: side,
        bus: "ambience",
        send: 0.3,
      });
      return;
    }

    const shots = 2 + Math.floor(this.random() * 4);
    for (let index = 0; index < shots; index += 1) {
      const delay = index * (0.095 + this.random() * 0.16);
      this.noiseBurst({
        when: this.context!.currentTime + delay,
        duration: 0.13,
        frequency: 520 + this.random() * 680,
        type: "bandpass",
        q: 0.72,
        gain: 0.025 + combat * 0.035,
        attack: 0.001,
        rate: 0.62,
        pan: Math.max(-1, Math.min(1, side + (this.random() - 0.5) * 0.35)),
        bus: "ambience",
        send: 0.68,
      });
    }
  }

  dispose(): void {
    this.wind.forEach((source) => {
      try {
        source.stop();
      } catch {
        // Already stopped by the audio context.
      }
    });
    this.wind = [];
    this.vehicleOscillators.forEach((oscillator) => {
      try {
        oscillator.stop();
      } catch {
        // Already stopped by the audio context.
      }
    });
    this.vehicleOscillators = [];
    try {
      this.vehicleNoise?.stop();
    } catch {
      // Already stopped by the audio context.
    }
    this.vehicleNoise = null;
    void this.context?.close();
    this.context = null;
    this.master = null;
    this.mix = null;
    this.reverbSend = null;
    this.buses = {};
  }

  private ready(): boolean {
    return Boolean(
      this.enabled &&
        this.context &&
        this.context.state === "running" &&
        this.master &&
        this.mix &&
        this.noiseBuffer,
    );
  }

  private createContext(): void {
    this.context = new AudioContext({ latencyHint: "interactive" });
    const ctx = this.context;

    this.mix = ctx.createGain();
    this.mix.gain.value = 0.88;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -15;
    compressor.knee.value = 14;
    compressor.ratio.value = 5.5;
    compressor.attack.value = 0.002;
    compressor.release.value = 0.16;
    this.master = ctx.createGain();
    this.master.gain.value = 0.78;
    this.mix.connect(compressor).connect(this.master).connect(ctx.destination);

    const busLevels = {
      weapons: 0.92,
      foley: 0.72,
      ambience: 0.52,
      ui: 0.58,
    } as const;
    (Object.keys(busLevels) as Array<keyof typeof busLevels>).forEach((name) => {
      const bus = ctx.createGain();
      bus.gain.value = busLevels[name];
      bus.connect(this.mix!);
      this.buses[name] = bus;
    });

    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.72;
    const sendHighpass = ctx.createBiquadFilter();
    sendHighpass.type = "highpass";
    sendHighpass.frequency.value = 105;
    const convolver = ctx.createConvolver();
    convolver.buffer = this.createImpulse(ctx, 2.2);
    const returnFilter = ctx.createBiquadFilter();
    returnFilter.type = "lowpass";
    returnFilter.frequency.value = 5600;
    const returnGain = ctx.createGain();
    returnGain.gain.value = 0.48;
    this.reverbSend
      .connect(sendHighpass)
      .connect(convolver)
      .connect(returnFilter)
      .connect(returnGain)
      .connect(this.mix);

    const length = ctx.sampleRate * 4;
    this.noiseBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    let seed = 918273;
    let previous = 0;
    for (let index = 0; index < data.length; index += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const white = (seed / 4294967296) * 2 - 1;
      previous = previous * 0.12 + white * 0.88;
      data[index] = previous;
    }
  }

  private createImpulse(ctx: AudioContext, seconds: number): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * seconds);
    const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
    let seed = 0xa11ce55;
    for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
      const data = impulse.getChannelData(channel);
      let low = 0;
      for (let index = 0; index < length; index += 1) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const white = (seed / 4294967296) * 2 - 1;
        low += (white - low) * (0.19 - channel * 0.025);
        const time = index / ctx.sampleRate;
        const decay = Math.exp((-6.9 * time) / seconds);
        const build = Math.min(1, time / 0.018);
        data[index] = (white * 0.45 + low * 0.55) * decay * build * 0.38;
      }
      for (const delay of [0.031, 0.058, 0.094, 0.143]) {
        const sample = Math.floor((delay + channel * 0.003) * ctx.sampleRate);
        if (sample < length) data[sample] += 0.25 / (1 + delay * 16);
      }
    }
    return impulse;
  }

  private startWind(): void {
    if (!this.ready()) return;
    const ctx = this.context!;
    const layers = [
      { type: "lowpass" as BiquadFilterType, frequency: 380, gain: 0.022, rate: 0.24 },
      { type: "bandpass" as BiquadFilterType, frequency: 1320, gain: 0.006, rate: 0.43 },
    ];
    layers.forEach((layer, index) => {
      const source = ctx.createBufferSource();
      source.buffer = this.noiseBuffer;
      source.loop = true;
      source.playbackRate.value = layer.rate;
      const filter = ctx.createBiquadFilter();
      filter.type = layer.type;
      filter.frequency.value = layer.frequency;
      filter.Q.value = index === 0 ? 0.35 : 0.72;
      const gain = ctx.createGain();
      gain.gain.value = layer.gain;
      const pan = ctx.createStereoPanner();
      pan.pan.value = index === 0 ? -0.18 : 0.22;
      source
        .connect(filter)
        .connect(gain)
        .connect(pan)
        .connect(this.buses.ambience!);
      source.start(0, index * 0.77);
      this.wind.push(source);
    });
  }

  private startVehicleEngine(): void {
    if (!this.ready() || !this.context) return;
    const ctx = this.context;
    this.vehicleGain = ctx.createGain();
    this.vehicleGain.gain.value = 0.0001;
    this.vehicleFilter = ctx.createBiquadFilter();
    this.vehicleFilter.type = "lowpass";
    this.vehicleFilter.frequency.value = 360;
    this.vehicleFilter.Q.value = 1.2;
    this.vehicleFilter.connect(this.vehicleGain).connect(this.buses.foley!);

    (["sawtooth", "square", "triangle"] as OscillatorType[]).forEach(
      (type, index) => {
        const oscillator = ctx.createOscillator();
        oscillator.type = type;
        oscillator.frequency.value = [36, 73, 210][index];
        const trim = ctx.createGain();
        trim.gain.value = [0.7, 0.18, 0.055][index];
        oscillator.connect(trim).connect(this.vehicleFilter!);
        oscillator.start();
        this.vehicleOscillators.push(oscillator);
      },
    );

    this.vehicleNoise = ctx.createBufferSource();
    this.vehicleNoise.buffer = this.noiseBuffer;
    this.vehicleNoise.loop = true;
    this.vehicleNoise.playbackRate.value = 0.38;
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.value = 720;
    noiseFilter.Q.value = 0.7;
    this.vehicleNoiseGain = ctx.createGain();
    this.vehicleNoiseGain.gain.value = 0.0001;
    this.vehicleNoise
      .connect(noiseFilter)
      .connect(this.vehicleNoiseGain)
      .connect(this.buses.foley!);
    this.vehicleNoise.start();
  }

  private noiseBurst(options: {
    when: number;
    duration: number;
    frequency: number;
    endFrequency?: number;
    type: BiquadFilterType;
    q?: number;
    gain: number;
    attack: number;
    rate: number;
    pan?: number;
    bus: "weapons" | "foley" | "ambience" | "ui";
    send: number;
  }): void {
    if (!this.context || !this.noiseBuffer) return;
    const ctx = this.context;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.playbackRate.value = options.rate;
    const filter = ctx.createBiquadFilter();
    filter.type = options.type;
    filter.frequency.setValueAtTime(
      Math.max(25, options.frequency),
      options.when,
    );
    if (options.endFrequency) {
      filter.frequency.exponentialRampToValueAtTime(
        Math.max(25, options.endFrequency),
        options.when + options.duration,
      );
    }
    filter.Q.value = options.q ?? 0.7;
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0.0001, options.when);
    envelope.gain.exponentialRampToValueAtTime(
      Math.max(0.0002, options.gain),
      options.when + Math.max(0.0003, options.attack),
    );
    envelope.gain.exponentialRampToValueAtTime(
      0.0001,
      options.when + options.duration,
    );
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, options.pan ?? 0));
    source
      .connect(filter)
      .connect(envelope)
      .connect(panner)
      .connect(this.buses[options.bus]!);
    if (options.send > 0 && this.reverbSend) {
      const send = ctx.createGain();
      send.gain.value = options.send;
      envelope.connect(send).connect(this.reverbSend);
    }
    const offset =
      (this.random() * Math.max(0.1, this.noiseBuffer.duration - options.duration)) %
      this.noiseBuffer.duration;
    source.start(options.when, offset, options.duration + 0.012);
    source.stop(options.when + options.duration + 0.02);
  }

  private tone(options: {
    when: number;
    duration: number;
    from: number;
    to: number;
    gain: number;
    type: OscillatorType;
    pan?: number;
    bus: "weapons" | "foley" | "ambience" | "ui";
    send: number;
  }): void {
    if (!this.context) return;
    const ctx = this.context;
    const oscillator = ctx.createOscillator();
    oscillator.type = options.type;
    oscillator.frequency.setValueAtTime(Math.max(20, options.from), options.when);
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(20, options.to),
      options.when + options.duration,
    );
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(Math.max(0.0002, options.gain), options.when);
    envelope.gain.exponentialRampToValueAtTime(
      0.0001,
      options.when + options.duration,
    );
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, options.pan ?? 0));
    oscillator
      .connect(envelope)
      .connect(panner)
      .connect(this.buses[options.bus]!);
    if (options.send > 0 && this.reverbSend) {
      const send = ctx.createGain();
      send.gain.value = options.send;
      envelope.connect(send).connect(this.reverbSend);
    }
    oscillator.start(options.when);
    oscillator.stop(options.when + options.duration + 0.01);
  }

  private random(): number {
    this.randomState = (this.randomState * 1664525 + 1013904223) >>> 0;
    return this.randomState / 4294967296;
  }
}
