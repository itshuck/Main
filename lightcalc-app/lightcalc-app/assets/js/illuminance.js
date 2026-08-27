/**
 * illuminance.js — физический движок расчёта освещённости на плоскости пола.
 *
 * Задача: по массиву светильников с их положением, углом пучка, световым
 * потоком и высотой монтажа — вычислить E(x, y) в люксах в каждой точке пола.
 * Используется для отрисовки TEPЛОВОЙ КАРТЫ (lx-heatmap) на плане.
 *
 * ФИЗИКА:
 *  Освещённость от точечного источника на расстоянии r под углом α к нормали:
 *     E = (I(α) · cos α) / r²
 *  где I(α) — сила света (кандел) в направлении α от оси луча.
 *
 *  Мы используем упрощённую модель «Ламберта в конусе»:
 *   I(α) = I0 · cos(α)^n   при α ≤ θ/2,   0 иначе
 *
 *  I0 (осевая сила света в кд) считаем из полного потока Φ (лм) и угла θ:
 *     I0 ≈ Φ / (2π · (1 - cos(θ/2)))    — равномерный конус
 *
 *  Показатель n подобран под резкость пучка:
 *   • n=2  — стандартный spot с линзой (чёткий фокус, MGN303/spot_lens)
 *   • n=1  — типовой spot с рефлектором
 *   • n=0.5 — рассеиватель (matte) — почти равномерная заливка
 *   • n=0.3 — downlight с широким мягким пучком
 *
 * ЛИНЕЙНЫЕ светильники (Liner/LensLine/MattLine) — моделируем как ЦЕПОЧКУ
 * точечных источников вдоль оси корпуса. Длина корпуса ≈ 0.3–1м → 5–10 точек.
 *
 * Результат: grid W×H значений lx.
 * Далее render2d/editor конвертирует в теплокарту с градиентом.
 */

import { inferLuminaireType, getBeamShape } from './cct.js';

// ============================================================
// Профиль концентрации света по типу пятна
// ============================================================
const N_EXPONENT = {
  spot_lens:    2.5,   // узкий фокус — крутая парабола
  spot:         1.5,   // стандартный spot
  spot_gu10:    1.5,
  spot_gx53:    0.8,   // gx53 — широкий, почти плоский
  linear_lens:  1.8,   // линейная линза — умеренно чёткая
  linear_fold:  1.0,
  linear_matte: 0.35,  // матовый рассеиватель — равномерный
  downlight:    0.5,
  unknown:      1.0,
};

// Длина корпуса линейных светильников (условно, для семплинга точек вдоль трека)
const LINEAR_BODY_LENGTH_M = {
  linear_lens:  0.3,
  linear_fold:  0.3,
  linear_matte: 0.4,
};

// Utilization factor — доля потока, реально попадающая на пол (потери на стенах, потолке)
const UTILIZATION = 0.85;

/**
 * Возвращает функцию E(x, y) — освещённость в люксах в точке пола (метры).
 *
 * @param {Array} luminaires — массив светильников сцены:
 *   [{ x, y, angle_deg, luminaire: { lumen, beam_deg, beam_deg_cross?, type }, on_track_id? }]
 * @param {Object} room — { length, width, height }  метры
 * @param {Array} tracks — треки сцены (для определения оси линейных светильников)
 * @returns {(x: number, y: number) => number}
 */
export function makeIlluminanceFunction(luminaires, room, tracks = []) {
  // Предвычисляем параметры для каждого источника
  const sources = [];
  const h = room.height;

  for (const lum of luminaires) {
    const cat = lum.luminaire;
    if (!cat || !cat.lumen || !cat.beam_deg) continue;

    const type = cat.type || inferLuminaireType(cat);
    const shape = getBeamShape(type);
    const n = N_EXPONENT[type] || N_EXPONENT.unknown;

    // Полутельный угол пучка (радианы)
    const beamHalfAlong = (cat.beam_deg / 2) * Math.PI / 180;
    const beamCross = cat.beam_deg_cross || cat.beam_deg;
    const beamHalfCross = (beamCross / 2) * Math.PI / 180;

    // I0 (кандел) — осевая сила света. Формула: Φ = 2π · I0 · (1 - cos(θ/2))
    // для эквивалентного «равномерного» конуса. С учётом UF (потери на отражения).
    const solidAngle = 2 * Math.PI * (1 - Math.cos(beamHalfAlong));
    const I0 = (cat.lumen * UTILIZATION) / Math.max(solidAngle, 0.05);

    if (shape.directional) {
      // Точечный светильник. Пользовательский lum.angle_deg (0..360) = азимут наклона:
      //   90°       = вниз (свет прямо под светильником)
      //   0° / 180° = максимальный наклон в горизонтали (пятно смещено)
      // Кламп ±60° от вертикали (реалистичный максимум трекового спота).
      const userAngle = lum.angle_deg != null ? lum.angle_deg : 90;
      const tiltDeg = userAngle - 90;
      const tiltNorm = ((tiltDeg + 180) % 360) - 180;
      const clampedTilt = Math.max(-45, Math.min(45, tiltNorm));
      const shiftM = h * Math.tan(Math.abs(clampedTilt) * Math.PI / 180);
      const azimuthRad = userAngle * Math.PI / 180;
      const sign = clampedTilt >= 0 ? 1 : -1;
      const shiftX = Math.cos(azimuthRad) * shiftM * sign;
      const shiftY = Math.sin(azimuthRad) * shiftM * sign;
      sources.push({
        x: lum.x, y: lum.y, h,
        // Смещение центра пятна: свет всё равно исходит из точки {x,y,h}, но
        // «ось пучка» наклонена и «целится» в точку {x+shiftX, y+shiftY, 0}.
        aimX: lum.x + shiftX,
        aimY: lum.y + shiftY,
        tiltRad: Math.abs(clampedTilt) * Math.PI / 180,
        I0, n,
        beamHalfAlong, beamHalfCross,
        axisAngle: 90,
        symmetric: true,
      });
    } else {
      // Линейный — семплируем несколько точек вдоль оси корпуса
      const bodyLen = LINEAR_BODY_LENGTH_M[type] || 0.3;
      const nSamples = 5;
      // Ось трека под этим светильником:
      let axisAngle = 90;
      if (lum.on_track_id) {
        const track = tracks.find(t => t.id === lum.on_track_id);
        if (track) {
          const a = trackSegmentAngleAt(track, lum);
          if (a !== null) axisAngle = a;
        }
      }
      const cosA = Math.cos(axisAngle * Math.PI / 180);
      const sinA = Math.sin(axisAngle * Math.PI / 180);
      const stepM = bodyLen / (nSamples - 1);
      const offsets = Array.from({ length: nSamples }, (_, i) => (i - (nSamples - 1) / 2) * stepM);
      // Каждый суб-источник = 1/N от общей мощности
      for (const off of offsets) {
        sources.push({
          x: lum.x + cosA * off,
          y: lum.y + sinA * off,
          h,
          I0: I0 / nSamples,
          n,
          beamHalfAlong, beamHalfCross,
          axisAngle,
          symmetric: false,
        });
      }
    }
  }

  // Возвращаем чистую функцию E(x, y)
  return function illuminanceAt(px, py) {
    let E = 0;
    for (const s of sources) {
      const dx = px - s.x;
      const dy = py - s.y;
      const rHorizontal = Math.hypot(dx, dy);
      // Полное расстояние от источника до точки на полу (3D)
      const r = Math.hypot(rHorizontal, s.h);
      if (r < 0.001) continue;
      // Угол падения на плоскость пола (для проекции): всегда cos = h/r
      const cosIncidence = s.h / r;

      // Проверка в конусе пучка — угол между осью пучка и направлением на точку
      let inCone = false;
      let cosBeamAxis;   // косинус угла между направлением луча и осью пучка

      if (s.symmetric) {
        // Для spot: ось пучка идёт из {s.x, s.y, h} в {s.aimX ?? s.x, s.aimY ?? s.y, 0}
        // (при наклоне aim смещён; при нулевом наклоне aim = центр под светильником)
        const aimX = s.aimX != null ? s.aimX : s.x;
        const aimY = s.aimY != null ? s.aimY : s.y;
        // Вектор оси: (aimX-s.x, aimY-s.y, -h). Длина = sqrt(shift² + h²) = h/cos(tilt)
        const shiftX = aimX - s.x;
        const shiftY = aimY - s.y;
        const axisLen = Math.hypot(shiftX, shiftY, s.h);
        // Вектор источник→точка: (dx, dy, -h). Длина = r
        // cos угла = скалярное произведение / (axisLen * r)
        const dot = shiftX * dx + shiftY * dy + s.h * s.h;
        cosBeamAxis = dot / (axisLen * r);
        // Кламп на всякий случай
        if (cosBeamAxis > 1) cosBeamAxis = 1;
        if (cosBeamAxis < -1) cosBeamAxis = -1;
        const alphaFromAxis = Math.acos(cosBeamAxis);
        inCone = alphaFromAxis <= s.beamHalfAlong;
      } else {
        // Линейный: свет идёт вниз, но пятно вытянутое.
        // Проверяем что точка попадает в асимметричный конус.
        const localAngle = Math.atan2(dy, dx) - s.axisAngle * Math.PI / 180;
        const projAlong = Math.abs(rHorizontal * Math.cos(localAngle));
        const projCross = Math.abs(rHorizontal * Math.sin(localAngle));
        const alphaAlong = Math.atan2(projAlong, s.h);
        const alphaCross = Math.atan2(projCross, s.h);
        if (alphaAlong <= s.beamHalfAlong && alphaCross <= s.beamHalfCross) {
          inCone = true;
          // Косинус эквивалентного угла = проекция на нормаль = h/r
          cosBeamAxis = cosIncidence;
        }
      }
      if (!inCone) continue;

      // Сила света в этом направлении: I(α) = I0 · cos(α)^n
      const I = s.I0 * Math.pow(Math.max(0, cosBeamAxis), s.n);
      // Освещённость на горизонтальной плоскости: E = I · cos(incidence) / r²
      // (закон косинусов освещённости — плоскость параллельна полу)
      const contribution = (I * cosIncidence) / (r * r);
      E += contribution;
    }
    return E;
  };
}

/**
 * Строит теплокарту освещённости — 2D массив значений lx.
 *
 * @param {Function} illuminanceFn — функция из makeIlluminanceFunction
 * @param {Object} room — { length, width }
 * @param {number} resolutionM — размер ячейки в метрах (0.2 = 20 см = хорошее качество)
 * @returns {{ grid: number[][], maxLx: number, avgLx: number, minLx: number, cellSize: number, cols: number, rows: number }}
 */
export function buildIlluminanceGrid(illuminanceFn, room, resolutionM = 0.2) {
  const cols = Math.ceil(room.length / resolutionM);
  const rows = Math.ceil(room.width / resolutionM);
  const grid = [];
  let sum = 0, count = 0, max = 0, min = Infinity;

  for (let j = 0; j < rows; j++) {
    const row = [];
    const y = (j + 0.5) * resolutionM;
    for (let i = 0; i < cols; i++) {
      const x = (i + 0.5) * resolutionM;
      const lx = illuminanceFn(x, y);
      row.push(lx);
      sum += lx;
      count++;
      if (lx > max) max = lx;
      if (lx < min) min = lx;
    }
    grid.push(row);
  }

  return {
    grid,
    maxLx: max,
    avgLx: count > 0 ? sum / count : 0,
    minLx: min === Infinity ? 0 : min,
    cellSize: resolutionM,
    cols, rows,
  };
}

/**
 * Цвет ячейки теплокарты по значению lx относительно нормы (нормативная освещённость).
 * Возвращает {fill: 'rgba(...)', label: 'ok'|'low'|'high'}.
 *
 * Логика:
 *  < 50% нормы  → синий (сильный недосвет)
 *  50-85%       → голубой (недосвет)
 *  85-115%      → зелёный (норма ✓)
 *  115-150%     → жёлтый (лёгкий пересвет)
 *  > 150%       → красный (сильный пересвет)
 */
export function lxToHeatColor(lx, normLx, opacity = 0.55) {
  const ratio = normLx > 0 ? lx / normLx : 0;

  // Пороговая шкала. Возвращаем RGB (можно ещё оттенки внутри диапазона)
  let r, g, b, level;
  if (ratio < 0.20) {
    // Очень темно — насыщенный синий
    r = 20; g = 60; b = 180; level = 'dark';
  } else if (ratio < 0.50) {
    // Недосвет — синий/голубой
    const t = (ratio - 0.20) / 0.30;
    r = 20 + t * 30;
    g = 60 + t * 130;
    b = 180 + t * 50;
    level = 'under';
  } else if (ratio < 0.85) {
    // Приближается к норме — сине-зелёный
    const t = (ratio - 0.50) / 0.35;
    r = 50 + t * 60;
    g = 190 + t * 40;
    b = 230 - t * 130;
    level = 'low';
  } else if (ratio <= 1.15) {
    // Норма — зелёный
    r = 110; g = 220; b = 100; level = 'ok';
  } else if (ratio <= 1.5) {
    // Лёгкий пересвет — жёлтый
    const t = (ratio - 1.15) / 0.35;
    r = 110 + t * 130;
    g = 220 - t * 20;
    b = 100 - t * 60;
    level = 'high';
  } else {
    // Сильный пересвет — красный
    r = 240; g = 120; b = 60; level = 'over';
  }

  return {
    fill: `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${opacity})`,
    level,
    ratio,
  };
}

/** Угол сегмента трека под точкой (deg) — для линейных светильников */
function trackSegmentAngleAt(track, point) {
  if (!track || track.points.length < 2) return null;
  let bestD = Infinity, bestA = 0;
  for (let i = 1; i < track.points.length; i++) {
    const a = track.points[i - 1], b = track.points[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const seg2 = dx * dx + dy * dy;
    if (seg2 < 1e-9) continue;
    let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / seg2;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + dx * t, py = a.y + dy * t;
    const d = Math.hypot(point.x - px, point.y - py);
    if (d < bestD) { bestD = d; bestA = Math.atan2(dy, dx) * 180 / Math.PI; }
  }
  return bestA;
}

/** Определяет нормативную освещённость для сцены — берём макс из зон проекта */
export function pickNormLx(project, norms) {
  if (!project.zones || project.zones.length === 0) return 300;   // дефолт
  let maxLx = 0;
  for (const z of project.zones) {
    const n = norms.zones.find(nz => nz.id === z.zone_id);
    if (n && n.lux > maxLx) maxLx = n.lux;
  }
  return maxLx || 300;
}
