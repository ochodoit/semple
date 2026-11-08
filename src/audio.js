// WebAudio 효과음 (iOS는 사용자 제스처 후 unlock 필요)
export class Sfx {
  constructor() { this.ctx = null; this.enabled = true; }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  _tone(freq, dur, type = 'sine', gain = 0.18, slideTo = null) {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  target() { this._tone(880, 0.12, 'triangle'); setTimeout(() => this._tone(1320, 0.16, 'triangle'), 70); }
  hit() { this._tone(160, 0.25, 'sawtooth', 0.22, 70); }
  tick() { this._tone(1000, 0.05, 'square', 0.06); }
  rep() { this._tone(660, 0.08, 'sine', 0.14); }
  start() { this._tone(523, 0.1); setTimeout(() => this._tone(659, 0.1), 110); setTimeout(() => this._tone(784, 0.18), 220); }
  end() { this._tone(784, 0.12); setTimeout(() => this._tone(659, 0.12), 130); setTimeout(() => this._tone(523, 0.25), 260); }
  fail() { this._tone(300, 0.3, 'sawtooth', 0.2, 120); }
}
