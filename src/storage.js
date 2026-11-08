// 설정/기록 저장 (localStorage)
const SETTINGS_KEY = 'puck-trainer.settings.v1';
const SCORES_KEY = 'puck-trainer.scores.v1';

export const DEFAULT_SETTINGS = {
  mirror: true,
  debug: false,
  sound: true,
  whiteV: 150,      // 바닥(흰색) 최소 밝기 (0-255)
  whiteC: 55,       // 바닥 채도 허용 (max-min 채널 차)
  puckTol: 95,      // 퍽 색 허용 오차 (RGB 거리)
  stickTol: 70,     // 스틱 색 허용 오차
  puckModel: { r: 0, g: 0, b: 0, area: 0 },   // area 0 = 바닥 크기 기준 자동
  stickModel: null,                           // null = 스틱 추적 안 함
  floorMode: 'auto',                          // 'auto' | 'manual'
  manualQuad: null,                           // [[u,v]x4] 정규화 좌표 (0-1)
  difficulty: 'normal',
  cameraId: '',
  p1: '플레이어 1',
  p2: '플레이어 2',
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    return sanitizeSettings({ ...structuredClone(DEFAULT_SETTINGS), ...JSON.parse(raw) });
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

const num = (v, min, max, def) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : def);
const isColorModel = (m) => m && typeof m === 'object' && [m.r, m.g, m.b].every((c) => Number.isFinite(c) && c >= 0 && c <= 255) && Number.isFinite(m.area) && m.area >= 0;

/** 손상되거나 범위를 벗어난 저장값을 기본값으로 되돌림 (오래된 버전/수동 편집 대비) */
export function sanitizeSettings(s) {
  const d = DEFAULT_SETTINGS;
  s.mirror = typeof s.mirror === 'boolean' ? s.mirror : d.mirror;
  s.debug = typeof s.debug === 'boolean' ? s.debug : d.debug;
  s.sound = typeof s.sound === 'boolean' ? s.sound : d.sound;
  s.whiteV = num(s.whiteV, 80, 240, d.whiteV);
  s.whiteC = num(s.whiteC, 10, 120, d.whiteC);
  s.puckTol = num(s.puckTol, 20, 200, d.puckTol);
  s.stickTol = num(s.stickTol, 20, 200, d.stickTol);
  s.puckModel = isColorModel(s.puckModel) ? { r: s.puckModel.r, g: s.puckModel.g, b: s.puckModel.b, area: s.puckModel.area } : structuredClone(d.puckModel);
  s.stickModel = isColorModel(s.stickModel) ? { r: s.stickModel.r, g: s.stickModel.g, b: s.stickModel.b, area: s.stickModel.area } : null;
  s.floorMode = s.floorMode === 'manual' ? 'manual' : 'auto';
  const quadOk = Array.isArray(s.manualQuad) && s.manualQuad.length === 4 &&
    s.manualQuad.every((pt) => Array.isArray(pt) && pt.length === 2 && pt.every((c) => Number.isFinite(c) && c >= 0 && c <= 1));
  if (!quadOk) { s.manualQuad = null; if (s.floorMode === 'manual') s.floorMode = 'auto'; }
  s.difficulty = ['easy', 'normal', 'hard'].includes(s.difficulty) ? s.difficulty : d.difficulty;
  s.cameraId = typeof s.cameraId === 'string' ? s.cameraId : '';
  s.p1 = typeof s.p1 === 'string' && s.p1.trim() ? s.p1.slice(0, 10) : d.p1;
  s.p2 = typeof s.p2 === 'string' && s.p2.trim() ? s.p2.slice(0, 10) : d.p2;
  return s;
}

export function saveSettings(settings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* 사생활 보호 모드 등 */ }
}

export function loadScores() {
  try { return JSON.parse(localStorage.getItem(SCORES_KEY) || '{}'); } catch { return {}; }
}

export function saveBest(modeId, score) {
  const scores = loadScores();
  const prev = scores[modeId];
  if (prev === undefined || score > prev) {
    scores[modeId] = score;
    try { localStorage.setItem(SCORES_KEY, JSON.stringify(scores)); } catch { /* ignore */ }
    return true;
  }
  return false;
}

export function clearScores() {
  try { localStorage.removeItem(SCORES_KEY); } catch { /* ignore */ }
}
