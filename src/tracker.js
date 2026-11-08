// 퍽 추적: 정규화 바닥 좌표(u,v)에서 위치 스무딩, 속도, 드리블(방향 전환) 카운트
const COAST_MS = 400;         // 미검출 시 예측 유지 시간
const DIR_THRESHOLD = 0.35;   // 방향 전환 인정 최소 속도 (바닥폭/초)

export class Tracker {
  constructor() { this.reset(); }

  reset() {
    this.pos = null;
    this.vel = { x: 0, y: 0 };
    this.speed = 0;
    this.state = 'lost';      // 'tracked' | 'predicted' | 'lost'
    this.lastSeen = 0;
    this.lastTime = 0;
    this.trail = [];
    this.dirX = 0;
    this.touches = 0;
    this.distance = 0;        // 누적 이동 거리 (바닥폭 단위)
    this.frames = 0;          // 추적률 계산용
    this.trackedFrames = 0;
  }

  resetStats() { this.touches = 0; this.distance = 0; this.dirX = 0; this.frames = 0; this.trackedFrames = 0; }

  get trackRate() { return this.frames ? this.trackedFrames / this.frames : 0; }

  /** meas: {u,v} | null, now: ms */
  update(meas, now) {
    const dt = this.lastTime ? Math.min(0.1, (now - this.lastTime) / 1000) : 1 / 30;
    this.lastTime = now;

    if (meas) {
      if (!this.pos || this.state === 'lost') {
        this.pos = { x: meas.u, y: meas.v };
        this.vel = { x: 0, y: 0 };
      } else {
        const nx = this.pos.x + (meas.u - this.pos.x) * 0.65;
        const ny = this.pos.y + (meas.v - this.pos.y) * 0.65;
        if (dt > 0) {
          const vx = (nx - this.pos.x) / dt, vy = (ny - this.pos.y) / dt;
          this.vel.x += (vx - this.vel.x) * 0.5;
          this.vel.y += (vy - this.vel.y) * 0.5;
        }
        this.distance += Math.hypot(nx - this.pos.x, ny - this.pos.y);
        this.pos.x = nx; this.pos.y = ny;
      }
      this.state = 'tracked';
      this.lastSeen = now;
    } else if (this.pos && now - this.lastSeen < COAST_MS) {
      this.pos.x += this.vel.x * dt * 0.5;
      this.pos.y += this.vel.y * dt * 0.5;
      this.vel.x *= 0.85; this.vel.y *= 0.85;
      this.state = 'predicted';
    } else {
      this.state = 'lost';
      this.pos = null;
      this.vel = { x: 0, y: 0 };
    }

    this.speed = Math.hypot(this.vel.x, this.vel.y);
    this.frames++;
    if (this.state === 'tracked') this.trackedFrames++;

    // 드리블(좌우 방향 전환) 카운트
    if (this.state === 'tracked') {
      const sign = this.vel.x > DIR_THRESHOLD ? 1 : this.vel.x < -DIR_THRESHOLD ? -1 : 0;
      if (sign !== 0) {
        if (this.dirX !== 0 && sign !== this.dirX) { this.touches++; this.lastTouch = now; }
        this.dirX = sign;
      }
    }

    if (this.pos) {
      this.trail.push({ x: this.pos.x, y: this.pos.y, t: now });
      if (this.trail.length > 40) this.trail.shift();
    } else if (this.trail.length) {
      this.trail = this.trail.filter((p) => now - p.t < 600);
    }
  }
}
