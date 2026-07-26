export class BattlefieldAudio {
  private context: AudioContext | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private master: GainNode | null = null;
  private wind: AudioBufferSourceNode | null = null;
  private enabled = true;

  async unlock(): Promise<void> {
    if (!this.enabled) return;
    if (!this.context) this.createContext();
    if (this.context?.state === "suspended") await this.context.resume();
    if (!this.wind) this.startWind();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (this.master) this.master.gain.value = enabled ? 0.72 : 0;
  }

  gunshot(heavy = false): void {
    if (!this.ready()) return;
    const ctx = this.context!;
    const now = ctx.currentTime;

    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.setValueAtTime(heavy ? 680 : 1050, now);
    band.Q.value = 0.55;
    const crack = ctx.createGain();
    crack.gain.setValueAtTime(heavy ? 1.2 : 0.78, now);
    crack.gain.exponentialRampToValueAtTime(0.001, now + (heavy ? 0.19 : 0.11));
    noise.connect(band).connect(crack).connect(this.master!);
    noise.start(now);
    noise.stop(now + 0.22);

    const thump = ctx.createOscillator();
    thump.type = "triangle";
    thump.frequency.setValueAtTime(heavy ? 105 : 150, now);
    thump.frequency.exponentialRampToValueAtTime(48, now + 0.12);
    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(heavy ? 0.68 : 0.34, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
    thump.connect(thumpGain).connect(this.master!);
    thump.start(now);
    thump.stop(now + 0.17);
  }

  enemyShot(distance: number, pan: number): void {
    if (!this.ready() || distance > 95) return;
    const ctx = this.context!;
    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = Math.max(480, 1500 - distance * 10);
    const gain = ctx.createGain();
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    gain.gain.setValueAtTime(Math.max(0.025, 0.36 * (1 - distance / 110)), now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    source.connect(filter).connect(gain).connect(panner).connect(this.master!);
    source.start(now);
    source.stop(now + 0.13);
  }

  explosion(intensity = 1): void {
    if (!this.ready()) return;
    const ctx = this.context!;
    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.playbackRate.value = 0.48;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(900, now);
    filter.frequency.exponentialRampToValueAtTime(90, now + 0.7);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.9 * intensity, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.9);
    source.connect(filter).connect(gain).connect(this.master!);
    source.start(now);
    source.stop(now + 1);
  }

  impact(): void {
    if (!this.ready()) return;
    const ctx = this.context!;
    const now = ctx.currentTime;
    const oscillator = ctx.createOscillator();
    oscillator.type = "square";
    oscillator.frequency.setValueAtTime(2400, now);
    oscillator.frequency.exponentialRampToValueAtTime(700, now + 0.035);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.075, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
    oscillator.connect(gain).connect(this.master!);
    oscillator.start(now);
    oscillator.stop(now + 0.05);
  }

  footstep(running: boolean): void {
    if (!this.ready()) return;
    const ctx = this.context!;
    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = running ? 190 : 130;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(running ? 0.11 : 0.07, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
    source.connect(filter).connect(gain).connect(this.master!);
    source.start(now);
    source.stop(now + 0.1);
  }

  uiTone(success = true): void {
    if (!this.ready()) return;
    const ctx = this.context!;
    const now = ctx.currentTime;
    [0, 0.06].forEach((offset, index) => {
      const oscillator = ctx.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = success
        ? 520 + index * 210
        : 310 - index * 70;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.09, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.11);
      oscillator.connect(gain).connect(this.master!);
      oscillator.start(now + offset);
      oscillator.stop(now + offset + 0.12);
    });
  }

  dispose(): void {
    this.wind?.stop();
    this.wind = null;
    void this.context?.close();
    this.context = null;
  }

  private ready(): boolean {
    return Boolean(
      this.enabled &&
        this.context &&
        this.context.state === "running" &&
        this.master &&
        this.noiseBuffer,
    );
  }

  private createContext(): void {
    this.context = new AudioContext();
    this.master = this.context.createGain();
    this.master.gain.value = 0.72;
    this.master.connect(this.context.destination);

    const length = this.context.sampleRate * 2;
    this.noiseBuffer = this.context.createBuffer(
      1,
      length,
      this.context.sampleRate,
    );
    const data = this.noiseBuffer.getChannelData(0);
    let seed = 918273;
    for (let i = 0; i < data.length; i += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[i] = (seed / 4294967296) * 2 - 1;
    }
  }

  private startWind(): void {
    if (!this.ready()) return;
    const ctx = this.context!;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 420;
    const gain = ctx.createGain();
    gain.gain.value = 0.018;
    source.connect(filter).connect(gain).connect(this.master!);
    source.start();
    this.wind = source;
  }
}

