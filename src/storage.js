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
    return { ...structuredClone(DEFAULT_SETTINGS), ...JSON.parse(raw) };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
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
