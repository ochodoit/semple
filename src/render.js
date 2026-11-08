// 오버레이 캔버스 렌더링
import { PUCK_R } from './game.js';

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
  }

  resize(cssW, cssH) {
    const w = Math.round(cssW * this.dpr), h = Math.round(cssH * this.dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
  }

  /**
   * vision: Vision 결과, puck: Tracker, game: Game, procSize: {PW,PH}, now: ms
   */
  draw({ vision, puck, game, procSize, now, showCandidates }) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const sx = W / procSize.PW, sy = H / procSize.PH;
    const toC = (px, py) => [px * sx, py * sy];
    const floor = vision?.floor;
    const mapping = floor?.mapping;
    const uvToC = (u, v) => { const [px, py] = mapping.toPx(u, v); return toC(px, py); };
    const unit = Math.min(W, H); // 크기 기준
    const fontPx = Math.round(unit * 0.035);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';

    // ---- 바닥 ----
    if (floor?.polygon?.length > 2 && floor.mode === 'auto') {
      ctx.beginPath();
      floor.polygon.forEach(([x, y], i) => { const [cx, cy] = toC(x, y); i ? ctx.lineTo(cx, cy) : ctx.moveTo(cx, cy); });
      ctx.closePath();
      ctx.fillStyle = 'rgba(56,189,248,0.06)';
      ctx.fill();
    }
    if (floor?.quad) {
      ctx.beginPath();
      floor.quad.forEach(([x, y], i) => { const [cx, cy] = toC(x, y); i ? ctx.lineTo(cx, cy) : ctx.moveTo(cx, cy); });
      ctx.closePath();
      ctx.lineWidth = unit * 0.005;
      ctx.setLineDash(floor.locked || floor.mode === 'manual' ? [] : [unit * 0.02, unit * 0.012]);
      ctx.strokeStyle = floor.detected ? 'rgba(56,189,248,0.9)' : 'rgba(245,158,11,0.9)';
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (!mapping) return;

    const floorPxW = Math.hypot(...sub(uvToC(1, 0.5), uvToC(0, 0.5))); // 캔버스 상 바닥 폭
    const R = (r) => r * floorPxW; // 정규화 반지름 -> 캔버스 px (가로 기준)

    // ---- 구역 ----
    for (const z of game.zones) {
      const corners = [[z.x - z.w / 2, z.y - z.h / 2], [z.x + z.w / 2, z.y - z.h / 2], [z.x + z.w / 2, z.y + z.h / 2], [z.x - z.w / 2, z.y + z.h / 2]];
      ctx.beginPath();
      corners.forEach(([u, v], i) => { const [cx, cy] = uvToC(clamp01(u), clamp01(v)); i ? ctx.lineTo(cx, cy) : ctx.moveTo(cx, cy); });
      ctx.closePath();
      const pulse = 0.5 + 0.5 * Math.sin(now / 250);
      if (z.warn) { ctx.fillStyle = 'rgba(239,68,68,0.18)'; ctx.strokeStyle = 'rgba(239,68,68,0.9)'; }
      else if (z.active) { ctx.fillStyle = `rgba(34,197,94,${0.12 + 0.1 * pulse})`; ctx.strokeStyle = 'rgba(34,197,94,0.95)'; }
      else { ctx.fillStyle = 'rgba(148,163,184,0.06)'; ctx.strokeStyle = 'rgba(148,163,184,0.5)'; }
      ctx.fill(); ctx.lineWidth = unit * 0.005; ctx.stroke();
    }

    // ---- 8자 게이트 ----
    game.waypoints.forEach((wp, i) => {
      const [cx, cy] = uvToC(wp.x, wp.y);
      const isNext = i === game.wpIndex;
      const r = R(0.09) * (isNext ? 1 + 0.08 * Math.sin(now / 180) : 0.8);
      ctx.beginPath(); ctx.ellipse(cx, cy, r, r * 0.6, 0, 0, Math.PI * 2);
      ctx.fillStyle = isNext ? 'rgba(34,197,94,0.25)' : 'rgba(148,163,184,0.08)';
      ctx.fill();
      ctx.lineWidth = unit * 0.004;
      ctx.strokeStyle = isNext ? '#22c55e' : 'rgba(148,163,184,0.5)';
      ctx.stroke();
      ctx.fillStyle = isNext ? '#fff' : 'rgba(226,232,240,0.6)';
      ctx.font = `700 ${fontPx}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), cx, cy);
    });

    // ---- 타겟 ----
    for (const t of game.targets) {
      const [cx, cy] = uvToC(t.x, t.y);
      const age = (now - t.born) / 1000;
      const r = R(t.r) * (1 + 0.06 * Math.sin(age * 6));
      ctx.lineWidth = unit * 0.006;
      for (let k = 0; k < 3; k++) {
        const rr = r * (1 - k * 0.3);
        ctx.beginPath(); ctx.ellipse(cx, cy, rr, rr * 0.6, 0, 0, Math.PI * 2);
        ctx.strokeStyle = k === 1 ? 'rgba(255,255,255,0.9)' : 'rgba(34,197,94,0.95)';
        ctx.stroke();
      }
      ctx.beginPath(); ctx.ellipse(cx, cy, r, r * 0.6, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(34,197,94,0.12)'; ctx.fill();
    }

    // ---- 콘 ----
    for (const c of game.cones) {
      const [cx, cy] = uvToC(c.x, c.y);
      const r = R(c.r);
      const hit = now < c.hitUntil;
      const h = r * 2.2;
      // 그림자/베이스
      ctx.beginPath(); ctx.ellipse(cx, cy, r * 1.15, r * 0.6, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fill();
      // 본체
      const grad = ctx.createLinearGradient(cx - r, cy, cx + r, cy);
      grad.addColorStop(0, hit ? '#fca5a5' : '#fb923c');
      grad.addColorStop(0.5, hit ? '#ef4444' : '#f97316');
      grad.addColorStop(1, hit ? '#b91c1c' : '#c2410c');
      ctx.beginPath();
      ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.lineTo(cx + r * 0.12, cy - h); ctx.lineTo(cx - r * 0.12, cy - h);
      ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
      ctx.beginPath(); ctx.ellipse(cx, cy, r, r * 0.45, 0, 0, Math.PI); ctx.fillStyle = hit ? '#b91c1c' : '#c2410c'; ctx.fill();
      // 띠
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(cx - r * 0.55, cy - h * 0.55, r * 1.1, h * 0.12);
      // 충돌 반경(은은하게)
      ctx.beginPath(); ctx.ellipse(cx, cy, R(c.r + PUCK_R), R(c.r + PUCK_R) * 0.6, 0, 0, Math.PI * 2);
      ctx.strokeStyle = hit ? 'rgba(239,68,68,0.8)' : 'rgba(251,146,60,0.25)'; ctx.lineWidth = unit * 0.003; ctx.stroke();
    }

    // ---- 스틱 ----
    const stick = vision.stick;
    if (stick) {
      const [cx, cy] = toC(stick.x, stick.y);
      const s = unit * 0.022;
      ctx.beginPath();
      ctx.moveTo(cx, cy - s); ctx.lineTo(cx + s, cy); ctx.lineTo(cx, cy + s); ctx.lineTo(cx - s, cy); ctx.closePath();
      ctx.fillStyle = 'rgba(245,158,11,0.35)'; ctx.fill();
      ctx.lineWidth = unit * 0.004; ctx.strokeStyle = '#f59e0b'; ctx.stroke();
      const [bx0, by0] = toC(stick.bbox[0], stick.bbox[1]);
      const [bx1, by1] = toC(stick.bbox[2] + 1, stick.bbox[3] + 1);
      ctx.setLineDash([unit * 0.01, unit * 0.008]);
      ctx.strokeStyle = 'rgba(245,158,11,0.5)'; ctx.lineWidth = unit * 0.002;
      ctx.strokeRect(bx0, by0, bx1 - bx0, by1 - by0);
      ctx.setLineDash([]);
    }

    // ---- 퍽 궤적 ----
    if (puck.trail.length > 1) {
      for (let i = 1; i < puck.trail.length; i++) {
        const a = puck.trail[i - 1], b = puck.trail[i];
        const alpha = Math.max(0, 1 - (now - b.t) / 900) * 0.7;
        if (alpha <= 0) continue;
        const [ax, ay] = uvToC(a.x, a.y), [bx, by] = uvToC(b.x, b.y);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
        ctx.strokeStyle = `rgba(56,189,248,${alpha})`; ctx.lineWidth = unit * 0.006 * (i / puck.trail.length) + 1;
        ctx.stroke();
      }
    }

    // ---- 퍽 ----
    if (puck.pos) {
      const [cx, cy] = uvToC(puck.pos.x, puck.pos.y);
      const r = Math.max(unit * 0.012, R(PUCK_R));
      const predicted = puck.state === 'predicted';
      ctx.beginPath(); ctx.ellipse(cx, cy, r * 1.9, r * 1.9 * 0.7, 0, 0, Math.PI * 2);
      ctx.fillStyle = predicted ? 'rgba(245,158,11,0.18)' : 'rgba(56,189,248,0.22)'; ctx.fill();
      ctx.beginPath(); ctx.ellipse(cx, cy, r, r * 0.7, 0, 0, Math.PI * 2);
      ctx.lineWidth = unit * 0.005; ctx.strokeStyle = predicted ? '#f59e0b' : '#38bdf8'; ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, unit * 0.004, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    }

    // ---- 디버그: 퍽 후보 ----
    if (showCandidates && vision.puckCandidates) {
      ctx.font = `${Math.round(fontPx * 0.6)}px system-ui`; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      for (const c of vision.puckCandidates) {
        const [x0, y0] = toC(c.minx, c.miny), [x1, y1] = toC(c.maxx + 1, c.maxy + 1);
        ctx.strokeStyle = 'rgba(239,68,68,0.8)'; ctx.lineWidth = 1; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
        ctx.fillStyle = '#fca5a5'; ctx.fillText(`${c.area} ${c.score.toFixed(2)}`, x0, y0 - 2);
      }
    }

    // ---- 이펙트 ----
    for (const e of game.effects) {
      if (e.type === 'pop') {
        const [cx, cy] = uvToC(clamp01(e.x), clamp01(e.y));
        const a = 1 - e.age;
        ctx.globalAlpha = a;
        ctx.font = `800 ${Math.round(fontPx * 1.3)}px system-ui, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineWidth = unit * 0.008; ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.strokeText(e.text, cx, cy - e.age * unit * 0.08);
        ctx.fillStyle = e.color; ctx.fillText(e.text, cx, cy - e.age * unit * 0.08);
        ctx.globalAlpha = 1;
      } else if (e.type === 'flash') {
        ctx.fillStyle = `rgba(239,68,68,${0.35 * (1 - e.age)})`;
        ctx.fillRect(0, 0, W, H);
      }
    }
  }
}

function sub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
function clamp01(x) { return Math.min(1, Math.max(0, x)); }
