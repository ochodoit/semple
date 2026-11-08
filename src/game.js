// 게임/트레이닝 로직. 좌표는 바닥 정규화 좌표 (u: 0..1 가로, v: 0..1 세로)
export const MODES = [
  { id: 'free', name: '자유 연습', duration: 0, icon: '🏒',
    desc: '퍽·스틱 인식을 보면서 자유롭게 드리블. 터치 수·속도·이동거리를 실시간 표시.' },
  { id: 'obstacle', name: '장애물 코스', duration: 60, icon: '🚧',
    desc: '콘을 피하면서 타겟을 통과. 콘에 닿으면 생명 -1. 시간이 지날수록 콘이 늘어나고 움직입니다.' },
  { id: 'wide', name: '와이드 드리블', duration: 30, icon: '↔️',
    desc: '좌우 끝 구역을 번갈아 터치. 넓은 가동 범위 훈련.' },
  { id: 'figure8', name: '8자 드리블', duration: 45, icon: '♾️',
    desc: '두 콘 사이를 8자로 돌며 순서대로 게이트 통과. 콘을 치면 감점.' },
  { id: 'quick', name: '퀵 핸즈', duration: 20, icon: '⚡',
    desc: '가운데 박스 안에서 최대한 빠르게 좌우로 퍽을 움직이세요.' },
  { id: 'reaction', name: '반응 타겟', duration: 30, icon: '🎯',
    desc: '무작위로 나타나는 타겟으로 퍽을 최대한 빨리 이동. 평균 반응 시간 측정.' },
];

export const PUCK_R = 0.025;
const CONE_R = 0.045;
const TARGET_R = 0.085;
const WAYPOINT_R = 0.09;

const DIFF = {
  easy:   { cones: 2, moving: 0,   speed: 0.10, addEvery: 20, maxCones: 4 },
  normal: { cones: 3, moving: 0.5, speed: 0.16, addEvery: 15, maxCones: 6 },
  hard:   { cones: 5, moving: 1,   speed: 0.24, addEvery: 12, maxCones: 8 },
};

const rand = (a, b) => a + Math.random() * (b - a);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export class Game {
  constructor(sfx) {
    this.sfx = sfx;
    this.mode = MODES[0];
    this.difficulty = 'normal';
    this.onEnd = null;
    this.running = false;
    this.resetState();
  }

  resetState() {
    this.timeLeft = this.mode.duration;
    this.elapsed = 0;
    this.score = 0;
    this.lives = 0;
    this.instruction = '';
    this.cones = [];
    this.targets = [];
    this.zones = [];
    this.waypoints = [];
    this.wpIndex = 0;
    this.effects = [];
    this.stats = {};
    this.invulnUntil = 0;
    this.lastTickSec = -1;
    this._puckTouchesBase = 0;
  }

  setMode(id) {
    this.mode = MODES.find((m) => m.id === id) || MODES[0];
    this.resetState();
  }

  start(puck) {
    this.resetState();
    this.running = true;
    this.startedAt = performance.now();
    const d = DIFF[this.difficulty] || DIFF.normal;
    const p = puck?.pos || { x: 0.5, y: 0.5 };

    switch (this.mode.id) {
      case 'obstacle':
        this.lives = 3;
        this.stats = { targets: 0, hits: 0 };
        for (let i = 0; i < d.cones; i++) this._spawnCone(p, d, i < Math.round(d.cones * d.moving));
        this._spawnTarget(p);
        this.instruction = '콘을 피해 타겟을 통과하세요';
        break;
      case 'wide':
        this.zones = [
          { id: 'L', x: 0.17, y: 0.5, w: 0.26, h: 0.9, active: true },
          { id: 'R', x: 0.83, y: 0.5, w: 0.26, h: 0.9, active: false },
        ];
        this.stats = { reps: 0 };
        this.instruction = '← 왼쪽 구역으로';
        break;
      case 'figure8':
        this.cones = [{ x: 0.3, y: 0.5, r: CONE_R, moving: false, hitUntil: 0 }, { x: 0.7, y: 0.5, r: CONE_R, moving: false, hitUntil: 0 }];
        this.waypoints = [
          { x: 0.5, y: 0.5 }, { x: 0.3, y: 0.22 }, { x: 0.1, y: 0.5 }, { x: 0.3, y: 0.78 },
          { x: 0.5, y: 0.5 }, { x: 0.7, y: 0.22 }, { x: 0.9, y: 0.5 }, { x: 0.7, y: 0.78 },
        ];
        this.wpIndex = 0;
        this.stats = { laps: 0, gates: 0, hits: 0 };
        this.instruction = '가운데 게이트부터 순서대로';
        break;
      case 'quick':
        this.zones = [{ id: 'C', x: 0.5, y: 0.5, w: 0.34, h: 0.5, active: true }];
        this.stats = { touches: 0, outside: 0 };
        this._puckTouchesBase = puck?.touches || 0;
        this.instruction = '박스 안에서 빠르게 좌우로!';
        break;
      case 'reaction':
        this.stats = { hits: 0, times: [] };
        this._spawnTarget(p, 0.3);
        this.targets[0].spawnedAt = performance.now();
        this.instruction = '타겟으로 이동!';
        break;
      default: // free
        this.timeLeft = 0;
        this.stats = {};
        this.instruction = '자유롭게 드리블하세요';
    }
    this.sfx?.start();
  }

  stop(reason = 'manual') {
    if (!this.running) return;
    this.running = false;
    const result = this._buildResult(reason);
    this.sfx?.end();
    this.onEnd?.(result);
    return result;
  }

  /** dt: 초, puck: Tracker, now: ms */
  update(dt, puck, now) {
    this.elapsed += dt;
    for (const e of this.effects) e.age = (now - e.t0) / e.dur;
    this.effects = this.effects.filter((e) => e.age < 1);

    if (!this.running) return;
    const d = DIFF[this.difficulty] || DIFF.normal;

    if (this.mode.duration > 0) {
      this.timeLeft = Math.max(0, this.mode.duration - this.elapsed);
      const sec = Math.ceil(this.timeLeft);
      if (sec <= 3 && sec !== this.lastTickSec && sec > 0) { this.sfx?.tick(); this.lastTickSec = sec; }
      if (this.timeLeft <= 0) { this.stop('time'); return; }
    }

    // 움직이는 콘
    for (const c of this.cones) {
      if (c.moving) {
        c.phase += dt * c.speed * Math.PI * 2 / 2.2;
        c.x = c.baseX + Math.sin(c.phase) * c.amp;
      }
    }

    const pos = puck.pos;
    const tracked = puck.state === 'tracked';
    const pp = pos ? { x: pos.x, y: pos.y } : null;

    switch (this.mode.id) {
      case 'obstacle': {
        if (Math.floor(this.elapsed / d.addEvery) > Math.floor((this.elapsed - dt) / d.addEvery) && this.cones.length < d.maxCones) {
          this._spawnCone(pp || { x: 0.5, y: 0.5 }, d, true);
          this._pop(0.5, 0.08, '콘 추가!', '#f59e0b');
        }
        if (pp && tracked) {
          this._checkTargets(pp, (t) => {
            this.score += 10; this.stats.targets++;
            this._pop(t.x, t.y, '+10', '#22c55e');
            this.sfx?.target();
            this._spawnTarget(pp);
          });
          this._checkCones(pp, now, () => {
            this.lives--; this.stats.hits++;
            this.score = Math.max(0, this.score - 3);
            if (this.lives <= 0) this.stop('lives');
          });
        }
        break;
      }
      case 'wide': {
        if (pp && tracked) {
          const z = this.zones.find((z) => z.active);
          if (z && this._inZone(pp, z)) {
            this.stats.reps++; this.score = this.stats.reps;
            this._pop(z.x, z.y, '+1', '#22c55e');
            this.sfx?.rep();
            this.zones.forEach((zz) => (zz.active = !zz.active));
            this.instruction = this.zones[0].active ? '← 왼쪽 구역으로' : '오른쪽 구역으로 →';
          }
        }
        break;
      }
      case 'figure8': {
        if (pp && tracked) {
          const wp = this.waypoints[this.wpIndex];
          if (dist(pp, wp) < WAYPOINT_R) {
            this.stats.gates++; this.score += 1;
            this.sfx?.rep();
            this.wpIndex = (this.wpIndex + 1) % this.waypoints.length;
            if (this.wpIndex === 0) { this.stats.laps++; this.score += 4; this._pop(0.5, 0.5, `${this.stats.laps}바퀴!`, '#f59e0b'); this.sfx?.target(); }
            this.instruction = `다음 게이트 ${this.wpIndex + 1}/${this.waypoints.length}`;
          }
          this._checkCones(pp, now, () => { this.stats.hits++; this.score = Math.max(0, this.score - 2); });
        }
        break;
      }
      case 'quick': {
        const z = this.zones[0];
        if (pp && tracked) {
          if (this._inZone(pp, z)) {
            const touches = puck.touches - this._puckTouchesBase;
            if (touches > this.stats.touches) { this.sfx?.rep(); }
            this.stats.touches = touches; this.score = touches;
            this.instruction = '좋아요, 계속!';
            z.warn = false;
          } else {
            this._puckTouchesBase = puck.touches - this.stats.touches; // 밖에서의 터치는 제외
            this.instruction = '박스 안으로!';
            z.warn = true;
          }
        }
        break;
      }
      case 'reaction': {
        if (pp && tracked) {
          this._checkTargets(pp, (t) => {
            const rt = (now - t.spawnedAt) / 1000;
            this.stats.times.push(rt); this.stats.hits++;
            this.score += Math.max(1, Math.round(10 - rt * 3));
            this._pop(t.x, t.y, `${rt.toFixed(2)}s`, '#22c55e');
            this.sfx?.target();
            this.targets = [];
            this.nextSpawn = now + 450;
          });
        }
        if (!this.targets.length && this.nextSpawn && now >= this.nextSpawn) {
          this._spawnTarget(pp || { x: 0.5, y: 0.5 }, 0.3);
          this.targets[0].spawnedAt = now;
          this.nextSpawn = 0;
        }
        break;
      }
      default: { // free
        this.score = puck.touches;
        this.stats = { touches: puck.touches, distance: puck.distance, speed: puck.speed };
      }
    }
  }

  // ---------- 내부 ----------
  _spawnCone(avoid, d, moving) {
    for (let tries = 0; tries < 40; tries++) {
      const c = { x: rand(0.12, 0.88), y: rand(0.15, 0.85), r: CONE_R, moving, hitUntil: 0 };
      if (dist(c, avoid) < 0.22) continue;
      if (this.cones.some((o) => dist(o, c) < 0.17)) continue;
      if (this.targets.some((t) => dist(t, c) < 0.2)) continue;
      if (moving) {
        c.baseX = Math.min(0.75, Math.max(0.25, c.x));
        c.amp = rand(0.1, 0.2); c.phase = rand(0, Math.PI * 2);
        c.speed = d.speed * rand(0.8, 1.3) / 0.16;
      }
      this.cones.push(c);
      return;
    }
  }

  _spawnTarget(avoid, minDist = 0.25) {
    for (let tries = 0; tries < 60; tries++) {
      const t = { x: rand(0.12, 0.88), y: rand(0.15, 0.85), r: TARGET_R, born: performance.now() };
      if (dist(t, avoid) < minDist) continue;
      if (this.cones.some((c) => dist(c, t) < c.r + t.r + 0.04)) continue;
      this.targets = [t];
      return;
    }
    this.targets = [{ x: 0.5, y: 0.5, r: TARGET_R, born: performance.now() }];
  }

  _checkTargets(pp, onHit) {
    for (const t of [...this.targets]) {
      if (dist(pp, t) < t.r) { onHit(t); return; }
    }
  }

  _checkCones(pp, now, onHit) {
    if (now < this.invulnUntil) return;
    for (const c of this.cones) {
      if (dist(pp, c) < c.r + PUCK_R) {
        c.hitUntil = now + 500;
        this.invulnUntil = now + 1200;
        this._pop(c.x, c.y - 0.08, '충돌!', '#ef4444');
        this.effects.push({ type: 'flash', t0: now, dur: 350, age: 0 });
        this.sfx?.hit();
        onHit(c);
        return;
      }
    }
  }

  _inZone(p, z) { return Math.abs(p.x - z.x) < z.w / 2 && Math.abs(p.y - z.y) < z.h / 2; }

  _pop(x, y, text, color) { this.effects.push({ type: 'pop', x, y, text, color, t0: performance.now(), dur: 900, age: 0 }); }

  _buildResult(reason) {
    const r = { mode: this.mode, score: this.score, reason, elapsed: this.elapsed, items: [] };
    const s = this.stats;
    switch (this.mode.id) {
      case 'obstacle':
        r.items = [['점수', this.score], ['통과한 타겟', s.targets], ['충돌', s.hits], ['버틴 시간', `${this.elapsed.toFixed(1)}s`]];
        break;
      case 'wide':
        r.items = [['반복 횟수', s.reps], ['분당 반복', Math.round(s.reps / Math.max(1, this.elapsed) * 60)]];
        break;
      case 'figure8':
        r.items = [['점수', this.score], ['완주 바퀴', s.laps], ['통과 게이트', s.gates], ['콘 충돌', s.hits]];
        break;
      case 'quick':
        r.items = [['터치 수', s.touches], ['초당 터치', (s.touches / Math.max(1, this.elapsed)).toFixed(2)]];
        break;
      case 'reaction': {
        const avg = s.times.length ? s.times.reduce((a, b) => a + b, 0) / s.times.length : 0;
        const best = s.times.length ? Math.min(...s.times) : 0;
        r.items = [['점수', this.score], ['타겟 성공', s.hits], ['평균 반응', `${avg.toFixed(2)}s`], ['최고 반응', `${best.toFixed(2)}s`]];
        break;
      }
      default:
        r.items = [['터치(방향 전환)', s.touches || 0], ['이동 거리', `${(s.distance || 0).toFixed(1)} 바닥폭`], ['연습 시간', `${Math.round(this.elapsed)}s`]];
    }
    return r;
  }
}
