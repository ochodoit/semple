// 영상 처리: 흰 바닥 영역, 퍽, 스틱 인식 (의존성 없는 순수 JS)
import { makeFloorMapping, quadBounds, quadScanlines } from './geometry.js';

const FLOOR_EMA = 0.15;        // 자동 바닥 영역 스무딩 계수
const ROW_RATIO = 0.10;        // 바닥으로 인정할 행/열의 흰색 비율
const MIN_FLOOR_SPAN = 0.25;   // 바닥 최소 크기(프레임 대비)

export class Vision {
  constructor(procWidth = 240) {
    this.PW = procWidth;
    this.PH = Math.round(procWidth * 3 / 4);
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.mirror = true;
    this.frame = null;          // 마지막 ImageData (보정용 샘플링)
    this.floorAuto = null;      // EMA 적용된 자동 바닥 bbox {x0,y0,x1,y1}
    this.floorLocked = false;
    this.floorPolygon = [];     // 자동 감지 윤곽 (표시용)
    this.lastPuck = null;       // {x,y,area,vx,vy,missed} 추적 게이트 (proc px)
    this.lastStick = null;
    this.debugImage = null;
    this._alloc();
  }

  _alloc() {
    const n = this.PW * this.PH;
    this.canvas.width = this.PW;
    this.canvas.height = this.PH;
    this.whiteMask = new Uint8Array(n);
    this.puckMask = new Uint8Array(n);
    this.stickMask = new Uint8Array(n);
    this.stack = new Int32Array(n);
    this.colCount = new Uint16Array(this.PW);
    this.rowCount = new Uint16Array(this.PH);
  }

  setSourceSize(vw, vh) {
    if (!vw || !vh) return;
    const ph = Math.max(60, Math.round(this.PW * vh / vw));
    if (ph !== this.PH) {
      this.PH = ph;
      this._alloc();
      this.floorAuto = null;
    }
  }

  /** 화면(정규화 0-1) 좌표 -> 처리 픽셀 좌표 */
  toProc(nx, ny) { return [nx * this.PW, ny * this.PH]; }

  /** 매 프레임 호출. settings: {whiteV, whiteC, puckTol, stickTol, puckModel, stickModel, floorMode, manualQuad, debug} */
  process(video, settings) {
    const { PW, PH, ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.mirror) ctx.setTransform(-1, 0, 0, 1, PW, 0);
    ctx.drawImage(video, 0, 0, PW, PH);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const frame = ctx.getImageData(0, 0, PW, PH);
    this.frame = frame;
    const d = frame.data;

    // ---- 1) 흰 바닥 마스크 + 행/열 히스토그램 ----
    const white = this.whiteMask;
    const colCount = this.colCount; colCount.fill(0);
    const rowCount = this.rowCount; rowCount.fill(0);
    const wv = settings.whiteV, wc = settings.whiteC;
    for (let y = 0, i = 0, p = 0; y < PH; y++) {
      let rc = 0;
      for (let x = 0; x < PW; x++, i++, p += 4) {
        const r = d[p], g = d[p + 1], b = d[p + 2];
        const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        if (mx >= wv && (mx - mn) <= wc) { white[i] = 1; colCount[x]++; rc++; } else white[i] = 0;
      }
      rowCount[y] = rc;
    }

    // ---- 2) 바닥 영역 결정 ----
    let floorDetected = false;
    let quad = null;
    if (settings.floorMode === 'manual' && settings.manualQuad) {
      quad = settings.manualQuad.map(([u, v]) => [u * PW, v * PH]);
      floorDetected = true;
      this.floorPolygon = [];
    } else {
      const bbox = this._autoFloorBBox();
      if (bbox) {
        floorDetected = true;
        if (!this.floorLocked) {
          if (!this.floorAuto) this.floorAuto = bbox;
          else {
            const f = this.floorAuto, a = FLOOR_EMA;
            f.x0 += (bbox.x0 - f.x0) * a; f.y0 += (bbox.y0 - f.y0) * a;
            f.x1 += (bbox.x1 - f.x1) * a; f.y1 += (bbox.y1 - f.y1) * a;
          }
        }
      }
      if (this.floorAuto) {
        const f = this.floorAuto;
        quad = [[f.x0, f.y0], [f.x1, f.y0], [f.x1, f.y1], [f.x0, f.y1]];
        this.floorPolygon = this._floorOutline(f);
      }
    }

    const mapping = quad ? makeFloorMapping(quad) : null;
    const result = {
      floor: { quad, mapping, detected: floorDetected, locked: this.floorLocked, polygon: this.floorPolygon, mode: settings.floorMode },
      puck: null,
      stick: null,
      puckCandidates: [],
    };
    if (!mapping) {
      this.lastPuck = null;
      if (settings.debug) this._buildDebug(null);
      return result;
    }

    // ---- 3) 바닥 내부에서 퍽/스틱 색 마스크 ----
    const bounds = quadBounds(quad);
    const scan = quadScanlines(quad, PH);
    const pm = settings.puckModel, sm = settings.stickModel;
    const pMatch = makeMatcher(pm, settings.puckTol);
    const sMatch = sm ? makeMatcher(sm, settings.stickTol) : null;
    const puckMask = this.puckMask, stickMask = this.stickMask;
    puckMask.fill(0);
    if (sm) stickMask.fill(0);
    const y0 = Math.max(0, Math.floor(bounds.y0)), y1 = Math.min(PH - 1, Math.ceil(bounds.y1));
    for (let y = y0; y <= y1; y++) {
      const xa = scan[y * 2], xb = scan[y * 2 + 1];
      if (xa < 0) continue;
      const xEnd = Math.min(PW - 1, xb);
      for (let x = xa, i = y * PW + xa, p = i * 4; x <= xEnd; x++, i++, p += 4) {
        const r = d[p], g = d[p + 1], b = d[p + 2];
        if (matchPixel(pMatch, r, g, b)) puckMask[i] = 1;
        if (sMatch && matchPixel(sMatch, r, g, b)) stickMask[i] = 1;
      }
    }

    const floorW = Math.max(10, bounds.x1 - bounds.x0);

    // ---- 4) 스틱 블롭 선택 (퍽보다 먼저: 타격 시 탐색 범위 확대에 사용) ----
    if (sm) {
      const expS = sm.area > 0 ? sm.area : Math.max(20, 0.785 * Math.pow(floorW * 0.05, 2));
      const minS = Math.max(5, expS * 0.2);
      const scomps = mergeClose(this._components(stickMask, bounds, Math.max(3, Math.floor(minS * 0.5))), 2);
      let sbest = null, sbestScore = 0;
      for (const c of scomps) {
        if (c.area < minS) continue;
        const cx = c.sx / c.area, cy = c.sy / c.area;
        let prox = 1;
        if (this.lastStick) {
          const dx = cx - this.lastStick.x, dy = cy - this.lastStick.y;
          prox = Math.exp(-Math.sqrt(dx * dx + dy * dy) / (0.2 * PW));
        }
        const s = c.area * (0.4 + 0.6 * prox);
        if (s > sbestScore) { sbestScore = s; sbest = c; c.cx = cx; c.cy = cy; }
      }
      if (sbest) {
        result.stick = {
          x: sbest.cx, y: sbest.cy, area: sbest.area,
          bottomX: sbest.bxsum / sbest.bxn, bottomY: sbest.maxy,
          bbox: [sbest.minx, sbest.miny, sbest.maxx, sbest.maxy],
        };
        this.lastStick = { x: sbest.cx, y: sbest.cy };
      } else {
        this.lastStick = null;
      }
    }

    // ---- 5) 퍽 블롭 선택 ----
    const calibrated = pm.area > 0;
    const expArea = calibrated ? pm.area : Math.max(6, 0.785 * Math.pow(floorW * 0.03, 2));
    // 보정된 경우 크기 범위를 좁혀 신발·바지 등 큰 어두운 물체를 배제
    const minA = Math.max(3, expArea * 0.25), maxA = expArea * (calibrated ? 3 : 4.5);
    const areaScale = calibrated ? 1.5 : 2.2;
    const comps = mergeClose(this._components(puckMask, bounds, Math.max(2, Math.floor(minA * 0.6))), 2);

    // 추적 게이트: 예측 위치 + 탐색 반경. 스틱이 퍽 근처면(타격 직후) 반경 확대
    const last = this.lastPuck;
    let predX = 0, predY = 0, sigma = 0.12 * PW, reacquiring = false;
    if (last) {
      reacquiring = last.missed > 0;
      const k = Math.min(last.missed, 6);
      predX = last.x + last.vx * (1 + k) * 0.8;
      predY = last.y + last.vy * (1 + k) * 0.8;
      const speed = Math.hypot(last.vx, last.vy);
      const stickNear = result.stick && Math.hypot(result.stick.x - last.x, result.stick.y - last.y) < 0.18 * PW;
      if (stickNear || speed > 0.025 * PW) sigma *= 2.4;
      sigma *= 1 + 0.25 * k;
    }

    let best = null, bestScore = 0;
    for (const c of comps) {
      if (c.area < minA || c.area > maxA) continue;
      // 놓친 뒤 재획득: 마지막으로 본 퍽과 크기가 비슷한 것만 허용
      if (last && reacquiring) {
        const ratio = c.area / last.area;
        if (ratio < 0.4 || ratio > 2.5) continue;
      }
      const bw = c.maxx - c.minx + 1, bh = c.maxy - c.miny + 1;
      const fill = Math.min(1, c.area / (bw * bh));
      const aspect = Math.min(bw, bh) / Math.max(bw, bh);
      const cx = c.sx / c.area, cy = c.sy / c.area;
      let prox = 1;
      if (last) {
        const dx = cx - predX, dy = cy - predY;
        prox = Math.exp(-Math.sqrt(dx * dx + dy * dy) / sigma);
      }
      const areaFit = 1 - Math.min(1, Math.abs(Math.log(c.area / expArea)) / areaScale);
      const score = fill * (0.5 + 0.5 * aspect) * (0.35 + 0.65 * prox) * (0.3 + 0.7 * areaFit);
      c.cx = cx; c.cy = cy; c.score = score;
      result.puckCandidates.push(c);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (best && bestScore >= 0.18) {
      result.puck = { x: best.cx, y: best.cy, area: best.area, w: best.maxx - best.minx + 1, h: best.maxy - best.miny + 1, score: bestScore };
      if (last && last.missed === 0) {
        const vx = best.cx - last.x, vy = best.cy - last.y;
        this.lastPuck = { x: best.cx, y: best.cy, area: last.area + (best.area - last.area) * 0.3, vx: last.vx + (vx - last.vx) * 0.6, vy: last.vy + (vy - last.vy) * 0.6, missed: 0 };
      } else {
        this.lastPuck = { x: best.cx, y: best.cy, area: best.area, vx: 0, vy: 0, missed: 0 };
      }
    } else if (last) {
      last.missed++;
      last.vx *= 0.8; last.vy *= 0.8;
      if (last.missed > 15) this.lastPuck = null;
    }

    if (settings.debug) this._buildDebug(sm);
    else this.debugImage = null;
    return result;
  }

  _autoFloorBBox() {
    const { PW, PH, rowCount, colCount } = this;
    const rowMin = PW * ROW_RATIO, colMin = PH * ROW_RATIO;
    let y0 = -1, y1 = -1, x0 = -1, x1 = -1;
    for (let y = 0; y < PH; y++) if (rowCount[y] >= rowMin) { y0 = y; break; }
    for (let y = PH - 1; y >= 0; y--) if (rowCount[y] >= rowMin) { y1 = y; break; }
    for (let x = 0; x < PW; x++) if (colCount[x] >= colMin) { x0 = x; break; }
    for (let x = PW - 1; x >= 0; x--) if (colCount[x] >= colMin) { x1 = x; break; }
    if (y0 < 0 || x0 < 0) return null;
    if ((y1 - y0) < PH * MIN_FLOOR_SPAN || (x1 - x0) < PW * MIN_FLOOR_SPAN) return null;
    return { x0, y0, x1: x1 + 1, y1: y1 + 1 };
  }

  /** 자동 감지 바닥의 좌/우 윤곽선 (행마다 첫/마지막 흰색 런) */
  _floorOutline(f) {
    const { PW, whiteMask } = this;
    const left = [], right = [];
    const ys = Math.max(0, Math.floor(f.y0)), ye = Math.min(this.PH - 1, Math.ceil(f.y1) - 1);
    const xs = Math.max(0, Math.floor(f.x0)), xe = Math.min(PW - 1, Math.ceil(f.x1) - 1);
    const step = Math.max(2, Math.floor((ye - ys) / 24));
    for (let y = ys; y <= ye; y += step) {
      const row = y * PW;
      let lx = -1, run = 0;
      for (let x = xs; x <= xe; x++) {
        if (whiteMask[row + x]) { if (++run >= 3) { lx = x - 2; break; } } else run = 0;
      }
      if (lx < 0) continue;
      let rx = -1; run = 0;
      for (let x = xe; x >= xs; x--) {
        if (whiteMask[row + x]) { if (++run >= 3) { rx = x + 2; break; } } else run = 0;
      }
      if (rx < 0) continue;
      left.push([lx, y]); right.push([rx, y]);
    }
    return left.concat(right.reverse());
  }

  /** 4-연결 컴포넌트 라벨링 (mask를 소비: 방문한 픽셀은 2로 표시) */
  _components(mask, bounds, minArea) {
    const { PW, PH, stack } = this;
    const comps = [];
    const bx0 = Math.max(0, Math.floor(bounds.x0)), bx1 = Math.min(PW - 1, Math.ceil(bounds.x1));
    const by0 = Math.max(0, Math.floor(bounds.y0)), by1 = Math.min(PH - 1, Math.ceil(bounds.y1));
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const start = y * PW + x;
        if (mask[start] !== 1) continue;
        let sp = 0;
        stack[sp++] = start;
        mask[start] = 2;
        const c = { area: 0, sx: 0, sy: 0, minx: x, maxx: x, miny: y, maxy: y, bxsum: 0, bxn: 0 };
        while (sp > 0) {
          const i = stack[--sp];
          const px = i % PW, py = (i - px) / PW;
          c.area++; c.sx += px; c.sy += py;
          if (px < c.minx) c.minx = px; if (px > c.maxx) c.maxx = px;
          if (py < c.miny) c.miny = py;
          if (py > c.maxy) { c.maxy = py; c.bxsum = px; c.bxn = 1; } else if (py === c.maxy) { c.bxsum += px; c.bxn++; }
          if (px > 0 && mask[i - 1] === 1) { mask[i - 1] = 2; stack[sp++] = i - 1; }
          if (px < PW - 1 && mask[i + 1] === 1) { mask[i + 1] = 2; stack[sp++] = i + 1; }
          if (py > 0 && mask[i - PW] === 1) { mask[i - PW] = 2; stack[sp++] = i - PW; }
          if (py < PH - 1 && mask[i + PW] === 1) { mask[i + PW] = 2; stack[sp++] = i + PW; }
        }
        if (c.area >= minArea) comps.push(c);
      }
    }
    return comps;
  }

  /** 보정: 처리 좌표 (px,py) 주변 색 샘플 + 같은 색 영역 크기 측정 */
  sampleObject(px, py, tol) {
    if (!this.frame) return null;
    const { PW, PH } = this;
    const d = this.frame.data;
    const cx = Math.round(Math.min(PW - 1, Math.max(0, px)));
    const cy = Math.round(Math.min(PH - 1, Math.max(0, py)));
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = cy - 2; y <= cy + 2; y++) {
      if (y < 0 || y >= PH) continue;
      for (let x = cx - 2; x <= cx + 2; x++) {
        if (x < 0 || x >= PW) continue;
        const p = (y * PW + x) * 4;
        r += d[p]; g += d[p + 1]; b += d[p + 2]; n++;
      }
    }
    r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
    // 같은 색 영역을 flood fill로 측정 (임시 마스크)
    const tol2 = tol * tol;
    const visited = new Uint8Array(PW * PH);
    const stack = this.stack;
    let sp = 0, area = 0;
    const start = cy * PW + cx;
    stack[sp++] = start; visited[start] = 1;
    const match = (i) => {
      const p = i * 4;
      const dr = d[p] - r, dg = d[p + 1] - g, db = d[p + 2] - b;
      return dr * dr + dg * dg + db * db <= tol2;
    };
    while (sp > 0 && area < 4000) {
      const i = stack[--sp];
      if (!match(i)) continue;
      area++;
      const x = i % PW, y = (i - x) / PW;
      if (x > 0 && !visited[i - 1]) { visited[i - 1] = 1; stack[sp++] = i - 1; }
      if (x < PW - 1 && !visited[i + 1]) { visited[i + 1] = 1; stack[sp++] = i + 1; }
      if (y > 0 && !visited[i - PW]) { visited[i - PW] = 1; stack[sp++] = i - PW; }
      if (y < PH - 1 && !visited[i + PW]) { visited[i + PW] = 1; stack[sp++] = i + PW; }
    }
    return { r, g, b, area };
  }

  /** 보정 터치 위치를 추적 시작점으로 사용 (같은 색의 다른 물체에 처음부터 붙는 것을 방지) */
  seedPuck(px, py, area) {
    this.lastPuck = { x: px, y: py, area: Math.max(3, area), vx: 0, vy: 0, missed: 0 };
  }

  /** 색이 바닥(흰색)과 구분되는지 */
  isFloorLike(model, settings) {
    const mx = Math.max(model.r, model.g, model.b), mn = Math.min(model.r, model.g, model.b);
    return mx >= settings.whiteV - 15 && (mx - mn) <= settings.whiteC + 10;
  }

  _buildDebug(stickModel) {
    const { PW, PH } = this;
    if (!this.debugImage || this.debugImage.width !== PW || this.debugImage.height !== PH) {
      this.debugImage = new ImageData(PW, PH);
    }
    const o = this.debugImage.data;
    for (let i = 0, p = 0; i < PW * PH; i++, p += 4) {
      let r = 0, g = 0, b = 0, a = 0;
      if (this.whiteMask[i]) { r = 40; g = 90; b = 160; a = 120; }
      if (this.puckMask[i]) { r = 255; g = 60; b = 60; a = 230; }
      if (stickModel && this.stickMask[i]) { r = 60; g = 255; b = 90; a = 230; }
      o[p] = r; o[p + 1] = g; o[p + 2] = b; o[p + 3] = a;
    }
  }
}

/**
 * 색 매처 생성. 채도가 높은 색(주황·파랑 테이프 등)은 조명 밝기에 따라 RGB가 크게 변하므로
 * 정규화 색도(r/(r+g+b), g/(r+g+b))로 비교해 허용 폭을 넓힌다. 어두운 색(검정 퍽)은 RGB 거리 사용.
 */
export function makeMatcher(model, tol) {
  const { r, g, b } = model;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const sat = mx > 0 ? (mx - mn) / mx : 0;
  if (sat > 0.35 && mx > 60) {
    const sum = r + g + b;
    const tolC = tol * 0.6;
    return {
      chroma: true,
      nr: (r / sum) * 255, ng: (g / sum) * 255,
      tol2: tolC * tolC,
      minV: Math.max(35, mx * 0.3),
      minChroma: Math.max(12, (mx - mn) * 0.4),
    };
  }
  return { chroma: false, r, g, b, tol2: tol * tol };
}

export function matchPixel(m, r, g, b) {
  if (!m.chroma) {
    const dr = r - m.r, dg = g - m.g, db = b - m.b;
    return dr * dr + dg * dg + db * db <= m.tol2;
  }
  const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
  const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
  if (mx < m.minV || (mx - mn) < m.minChroma) return false;
  const sum = r + g + b;
  const dr = (r / sum) * 255 - m.nr, dg = (g / sum) * 255 - m.ng;
  return dr * dr + dg * dg <= m.tol2;
}

/** 반사광 등으로 조각난 덩어리 병합: bbox 간격이 gap 이하인 컴포넌트를 합침 */
export function mergeClose(comps, gap) {
  if (comps.length < 2 || comps.length > 40) return comps;
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < comps.length; i++) {
      for (let j = i + 1; j < comps.length; j++) {
        const a = comps[i], c = comps[j];
        if (a.minx > c.maxx + gap || c.minx > a.maxx + gap || a.miny > c.maxy + gap || c.miny > a.maxy + gap) continue;
        a.area += c.area; a.sx += c.sx; a.sy += c.sy;
        a.minx = Math.min(a.minx, c.minx); a.maxx = Math.max(a.maxx, c.maxx);
        a.miny = Math.min(a.miny, c.miny);
        if (c.maxy > a.maxy) { a.maxy = c.maxy; a.bxsum = c.bxsum; a.bxn = c.bxn; }
        else if (c.maxy === a.maxy) { a.bxsum += c.bxsum; a.bxn += c.bxn; }
        comps.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
  return comps;
}
