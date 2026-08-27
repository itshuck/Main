/**
 * render2d.js — SVG-визуализация плана освещения (вид сверху).
 *
 * Экспортирует:
 *   renderFloorPlan(project, result, db, opts) → SVGElement
 *   renderHeatmap(project, result, opts)       → SVGElement (тепловая карта освещённости)
 *   svgToDataUrl(svgEl)                        → строка data:image/svg+xml для скачивания/PDF
 *   svgToPng(svgEl, scale)                     → Promise<Blob> PNG
 *
 * План рисуется в системе координат "метры", SVG viewBox = помещение с отступами.
 */

// ============================================================
// Цветовая палитра (согласована со style.css)
// ============================================================
// ---- Мини-справочник CCT (дублирует cct.js для совместимости с DOM-shim в preview_svg.mjs) ----
const CCT_COLORS_LOCAL = {
  2700: { emit: '#FFB25A', glow: '#FFDDA8' },
  3000: { emit: '#FFCC8A', glow: '#FFE9C7' },
  4000: { emit: '#FFF3D4', glow: '#FFFCEC' },
  6000: { emit: '#E4EEFF', glow: '#F0F6FF' },
  6500: { emit: '#D6E7FF', glow: '#E5F0FF' },
};
const BEAM_SHAPES_LOCAL = {
  spot:         { elongation: 1.0, softness: 0.35, intensity: 0.55 },
  spot_gu10:    { elongation: 1.0, softness: 0.35, intensity: 0.55 },
  spot_gx53:    { elongation: 1.0, softness: 0.60, intensity: 0.40 },
  spot_lens:    { elongation: 1.0, softness: 0.22, intensity: 0.68 },
  linear_lens:  { elongation: 2.2, softness: 0.35, intensity: 0.55 },
  linear_matte: { elongation: 2.5, softness: 0.80, intensity: 0.32 },
  linear_fold:  { elongation: 2.0, softness: 0.50, intensity: 0.45 },
  downlight:    { elongation: 1.0, softness: 0.75, intensity: 0.38 },
  downlight_lens: { elongation: 1.0, softness: 0.26, intensity: 0.66 },
};
function _nearestCct(k) {
  if (!k) return 3000;
  const keys = [2700, 3000, 4000, 6000, 6500];
  return keys.reduce((best, x) => Math.abs(x - k) < Math.abs(best - k) ? x : best, keys[0]);
}
/** Направленный ли светильник (спот с наклоном) — для выбора угла пятна в ручном режиме */
function _isDirectionalType(type) {
  return type === 'spot' || type === 'spot_gu10' ||
         type === 'spot_gx53' || type === 'spot_lens';
}

// Управляемые пользователем типы света (согласовано с cct.LIGHT_TYPE_OPTIONS)
const LIGHT_TYPE_BEAM = {
  rasseivayushchiy: 'downlight',
  napravlennyy:     'downlight_lens',
  fokus_lens:       'spot_lens',
  povorotnyy:       'spot',
  staticheskiy:     'linear_fold',
};

function _inferType(p, lightType) {
  // Пользовательский override типа света из Редактора плана — приоритет №1.
  if (lightType && LIGHT_TYPE_BEAM[lightType]) return LIGHT_TYPE_BEAM[lightType];
  // Встраиваемый светильник направленного света БЕЗ поворота — всегда свет вниз
  // (согласовано с cct.inferLuminaireType). Ручки/наклона для таких нет.
  if (p.role === 'downlight_luminaire') {
    const narrow = (p.beam_deg != null && p.beam_deg <= 55)
                   || /lens|spot|\bлинз/i.test((p.name || '') + ' ' + (p.slug || ''));
    return narrow ? 'downlight_lens' : 'downlight';
  }
  if (p.type && BEAM_SHAPES_LOCAL[p.type]) return p.type;
  const n = (p.name || '').toLowerCase(), s = (p.slug || '').toLowerCase();
  if (n.includes('gu10') || s.includes('gu10')) return 'spot_gu10';
  if (n.includes('gx53') || s.includes('gx53')) return 'spot_gx53';
  if (n.includes('lensline')) return 'linear_lens';
  if (n.includes('matte') || n.includes('matt')) return 'linear_matte';
  if (n.includes('lensfold')) return 'linear_fold';
  if (/\blens\b/i.test(`${n} ${s}`) && !/\bliner\b/i.test(`${n} ${s}`)) return 'spot_lens';
  if (n.includes('downlight')) return 'downlight';
  return 'spot';
}

const COLORS = {
  bg:          '#0e1116',
  wall:        '#dfe4ec',
  wallStroke:  '#4a5568',
  floor:       '#171b23',
  grid:        '#2a3241',
  track:       '#4aa3ff',
  trackShadow: 'rgba(74,163,255,0.25)',
  luminaire:   '#ffb547',
  luminaireDim:'rgba(255,181,71,0.15)',
  beam:        'rgba(255,181,71,0.35)',
  psu:         '#f87171',
  connector:   '#66b3ff',
  text:        '#e6ebf3',
  textDim:     '#97a3b6',
  zoneColors: [
    'rgba(74, 163, 255, 0.10)',   // синий
    'rgba(255, 181, 71, 0.10)',   // янтарный
    'rgba(74, 222, 128, 0.10)',   // зелёный
    'rgba(248, 113, 113, 0.10)',  // красный
    'rgba(168, 85, 247, 0.10)',   // фиолетовый
    'rgba(236, 72, 153, 0.10)',   // розовый
  ],
  zoneBorders: [
    'rgba(74, 163, 255, 0.6)',
    'rgba(255, 181, 71, 0.6)',
    'rgba(74, 222, 128, 0.6)',
    'rgba(248, 113, 113, 0.6)',
    'rgba(168, 85, 247, 0.6)',
    'rgba(236, 72, 153, 0.6)',
  ],
};

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}, children = []) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    el.setAttribute(k, String(v));
  }
  for (const c of (Array.isArray(children) ? children : [children])) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

// ============================================================
// Геометрия: трассы трека для каждой схемы
// ============================================================

/**
 * Возвращает массив «сегментов» — ломаных линий трека в координатах помещения.
 * Каждый сегмент = массив точек [{x, y}, ...] в метрах от левого-верхнего угла.
 */
export function buildTrackPolylines(layout, room, offset = 0.3) {
  const L = room.length, W = room.width;
  const cx = L / 2, cy = W / 2;
  switch (layout) {
    case 'line_center':
      return [[{ x: offset, y: cy }, { x: L - offset, y: cy }]];
    case 'line_mirror':
      return [[{ x: cx - 0.6, y: offset }, { x: cx + 0.6, y: offset }]];
    case 'L_shape':
      return [[
        { x: offset, y: offset },
        { x: L - offset, y: offset },
        { x: L - offset, y: W - offset },
      ]];
    case 'U_shape':
      return [[
        { x: offset, y: offset },
        { x: offset, y: W - offset },
        { x: L - offset, y: W - offset },
        { x: L - offset, y: offset },
      ]];
    case 'perimeter_partial':
      return [[
        { x: offset, y: offset },
        { x: L - offset, y: offset },
        { x: L - offset, y: W - offset },
        { x: offset, y: W - offset },
        { x: offset, y: offset },
      ]];
    case 'parallel_lines':
    case 'parallel_lines_walls': {
      const y1 = W * 0.25, y2 = W * 0.75;
      return [
        [{ x: offset, y: y1 }, { x: L - offset, y: y1 }],
        [{ x: offset, y: y2 }, { x: L - offset, y: y2 }],
      ];
    }
    case 'custom':
    default:
      return [[{ x: offset, y: cy }, { x: L - offset, y: cy }]];
  }
}

/**
 * Строит разводку трека «по зонам», если их несколько: каждый трек
 * формируется ВНУТРИ своей зоны (зона = прямоугольник {x, y, w, h}),
 * а не через весь план. Для одного помещения без зон — обычная разводка.
 * @param {Object} project { layout, room, zones }
 */
export function buildZonePolylines(project) {
  const room = project.room;
  const zones = (project.zones || []).filter(z => z && Number.isFinite(z.w) && Number.isFinite(z.h));
  // По умолчанию (zoneLayout !== 'whole') при нескольких зонах разводка идёт
  // по зонам; 'whole' — возвращает старое поведение (трек через весь план).
  const perZone = zones.length > 1 && project.system?.zoneLayout !== 'whole';
  if (perZone) {
    const all = [];
    const offset = 0.25; // чуть меньше, т.к. зоны уже вложены в комнату
    for (const zone of zones) {
      const zRoom = { length: zone.w, width: zone.h };
      const zPolys = buildTrackPolylines(project.layout, zRoom, offset);
      for (const poly of zPolys) {
        // Смещаем в координаты комнаты (зона живёт со своим левым-верхним углом)
        all.push(poly.map(p => ({ x: p.x + zone.x, y: p.y + zone.y })));
      }
    }
    return all;
  }
  return buildTrackPolylines(project.layout, room);
}

/** Длина ломаной в метрах */
function polylineLength(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y;
    s += Math.hypot(dx, dy);
  }
  return s;
}

/**
 * Распределяет N светильников равномерно вдоль ломаной.
 * Возвращает массив {x, y, angle_deg} — угол = азимут луча (перпендикулярен треку вниз).
 */
export function distributeLuminaires(polyline, count) {
  if (count <= 0) return [];
  const totalLen = polylineLength(polyline);
  if (totalLen === 0) return [];
  // Отступ от концов, чтобы светильники не «свисали»
  const margin = Math.min(0.3, totalLen / (count * 2 + 2));
  const usableLen = totalLen - 2 * margin;
  const step = count > 1 ? usableLen / (count - 1) : 0;

  const results = [];
  for (let i = 0; i < count; i++) {
    const targetDist = margin + i * step;
    // проходим по сегментам, находим точку на targetDist
    let acc = 0;
    for (let s = 1; s < polyline.length; s++) {
      const a = polyline[s - 1], b = polyline[s];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      if (acc + segLen >= targetDist - 1e-9) {
        const t = segLen === 0 ? 0 : (targetDist - acc) / segLen;
        results.push({
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
          // угол — вниз (по нормали к треку в 2D-плане). Для «сверху» — свет всегда «в пол».
          angle_deg: 90,
        });
        break;
      }
      acc += segLen;
    }
  }
  return results;
}

// ============================================================
// Рисуем помещение
// ============================================================

/**
 * Основная функция: строит SVG вида сверху с зонами, треком, светильниками, размерами.
 * @param {Object} project — {room, system, zones, layout}
 * @param {Object} result  — результат computeProject
 * @param {Object} db      — {catalog, norms, presets}
 * @param {Object} opts    — {width, showZones, showBeams, showDimensions, showLabels}
 */
export function renderFloorPlan(project, result, db, opts = {}) {
  const {
    width = 800,
    showZones = true,
    showBeams = true,
    showDimensions = true,
    showLabels = true,
    showLegend = true,
    scene = null,        // если передана сцена редактора — рисуем ПО НЕЙ, а не по авто-раскладке
  } = opts;

  const room = project.room;
  const L = room.length, W = room.width;

  // Масштаб: чтобы уместить в width с отступами под подписи
  const padLeft = 60, padRight = 60, padTop = 40, padBottom = 80;
  const drawW = width - padLeft - padRight;
  const scale = drawW / L;      // пикселей в метре
  const drawH = W * scale;
  const height = drawH + padTop + padBottom;

  // Преобразование метров → пиксели SVG
  const m2px = (m) => m * scale;
  const X = (mx) => padLeft + m2px(mx);
  const Y = (my) => padTop + m2px(my);

  const root = svg('svg', {
    xmlns: SVG_NS,
    viewBox: `0 0 ${width} ${height}`,
    width: width,
    height: height,
    style: 'display:block;max-width:100%;height:auto;background:' + COLORS.bg + ';border-radius:10px',
  });

  // --- Defs: паттерн сетки 0.5м ---
  const defs = svg('defs');
  const pat = svg('pattern', {
    id: 'grid',
    width: m2px(0.5),
    height: m2px(0.5),
    patternUnits: 'userSpaceOnUse',
  }, [
    svg('path', {
      d: `M ${m2px(0.5)} 0 L 0 0 0 ${m2px(0.5)}`,
      fill: 'none',
      stroke: COLORS.grid,
      'stroke-width': 0.5,
      opacity: 0.4,
    }),
  ]);
  defs.appendChild(pat);
  // Мягкое свечение для трека
  const glow = svg('filter', { id: 'glow', x: '-20%', y: '-20%', width: '140%', height: '140%' });
  glow.appendChild(svg('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: '2', result: 'blur' }));
  glow.appendChild(svg('feMerge', {}, [
    svg('feMergeNode', { in: 'blur' }),
    svg('feMergeNode', { in: 'SourceGraphic' }),
  ]));
  defs.appendChild(glow);
  root.appendChild(defs);
  // Динамические градиенты beam'ов — по CCT × типу.
  // Собираем их ПОСЛЕ распределения светильников (см. ниже), тогда id известны заранее.

  // --- Пол + сетка ---
  root.appendChild(svg('rect', {
    x: X(0), y: Y(0), width: m2px(L), height: m2px(W),
    fill: COLORS.floor, stroke: COLORS.wallStroke, 'stroke-width': 1,
  }));
  root.appendChild(svg('rect', {
    x: X(0), y: Y(0), width: m2px(L), height: m2px(W),
    fill: 'url(#grid)',
  }));

  // --- Зоны ---
  if (showZones && project.zones.length > 0) {
    root.appendChild(renderZones(project, X, Y, m2px, drawW, drawH));
  }

  // --- Световые пятна / треки / светильники ---
  // ВАЖНО: если передана сцена редактора (opts.scene) — рисуем ТОЧНО по ней:
  //   треки берём из scene.tracks (их координаты), светильники — из scene.luminaires
  //   (реальные позиции, углы и модели после ручных правок пользователя).
  //   Тогда итоговый план совпадает с последней правкой в редакторе 1:1.
  //   Иначе используем авто-раскладку из project.layout + result (для шага без редактора).
  let polylines, luminairePlacements, totalLuminaires;
  // Сцену используем, как только она валидна (даже если светильников 0) —
  // иначе итоговый план «перерисуется» автораскладкой и разойдётся с редактором.
  const useScene = scene && Array.isArray(scene.tracks) && Array.isArray(scene.luminaires);

  if (useScene) {
    // Треки из сцены: приводим к массивам точек {x,y}
    polylines = scene.tracks.map(t => (t.points || []).map(p => ({ x: p.x, y: p.y })))
                            .filter(p => p.length > 0);
    // Светильники из сцены: каждая позиция привязана к карточке каталога
    luminairePlacements = [];
    const sceneById = new Map();
    for (const lum of scene.luminaires) {
      const cat = db.catalog.find(p => p.slug === lum.slug);
      if (!cat) continue;
      sceneById.set(lum.id, cat);
      luminairePlacements.push({
        x: lum.x,
        y: lum.y,
        angle_deg: lum.angle_deg != null ? lum.angle_deg : 90,
        luminaire: cat,           // карточка каталога (для CCT/beam_deg/типа)
        lightType: lum.lightType || null,   // override типа света из редактора
        zoneIdx: 0,               // зона не критична при отрисовке пятен
        on_track_id: lum.on_track_id || null,
      });
    }
    totalLuminaires = luminairePlacements.length;
  } else {
    // Авто-раскладка (без ручных правок): при нескольких зонах — по зонам
    polylines = buildZonePolylines(project);
    const luminaires = result?.luminaires || [];
    totalLuminaires = luminaires.reduce((s, l) => s + l.qty, 0);

    // Распределяем светильники по всем полилиниям пропорционально длине
    const totalTrackLen = polylines.reduce((s, p) => s + polylineLength(p), 0);
    luminairePlacements = [];  // {x, y, angle_deg, luminaire, zoneIdx}
    let placed = 0;
    const flatLuminaires = [];
    for (let li = 0; li < luminaires.length; li++) {
      for (let i = 0; i < luminaires[li].qty; i++) {
        flatLuminaires.push({ luminaire: luminaires[li].luminaire, zoneIdx: li });
      }
    }

    for (const poly of polylines) {
      const segShare = polylineLength(poly) / totalTrackLen;
      const segCount = Math.round(totalLuminaires * segShare);
      const positions = distributeLuminaires(poly, segCount);
      for (const pos of positions) {
        const lum = flatLuminaires[placed] || flatLuminaires[flatLuminaires.length - 1];
        if (lum) luminairePlacements.push({ ...pos, ...lum });
        placed++;
      }
    }
  }

  // Пятна света (за треком, но над зонами) — по CCT + типу.
  if (showBeams) {
    // 1) Собираем нужные градиенты
    const gradIds = new Set();
    for (const lp of luminairePlacements) {
      const lum = lp.luminaire;
      const cctK = _nearestCct(lum.cct_k);
      const type = _inferType(lum, lp.lightType);
      const id = `beam-${cctK}-${type}`;
      if (gradIds.has(id)) continue;
      gradIds.add(id);
      const c = CCT_COLORS_LOCAL[cctK];
      const s = BEAM_SHAPES_LOCAL[type] || BEAM_SHAPES_LOCAL.spot;
      const stopMid = Math.round((1 - s.softness) * 100);
      const grad = svg('radialGradient', { id });
      grad.appendChild(svg('stop', { offset: '0%', 'stop-color': c.emit, 'stop-opacity': String(s.intensity) }));
      grad.appendChild(svg('stop', { offset: `${Math.max(15, stopMid)}%`, 'stop-color': c.emit, 'stop-opacity': String(s.intensity * 0.35) }));
      grad.appendChild(svg('stop', { offset: '100%', 'stop-color': c.emit, 'stop-opacity': '0' }));
      defs.appendChild(grad);
    }

    // 2) Определяем угол сегмента трека для каждой позиции (для вытягивания линейных beam-ов)
    const polyAngle = (poly, pos) => {
      let bestD = Infinity, bestA = 0;
      for (let i = 1; i < poly.length; i++) {
        const a = poly[i - 1], b = poly[i];
        const dx = b.x - a.x, dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        if (len2 < 1e-9) continue;
        let t = ((pos.x - a.x) * dx + (pos.y - a.y) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        const px = a.x + dx * t, py = a.y + dy * t;
        const d = Math.hypot(pos.x - px, pos.y - py);
        if (d < bestD) { bestD = d; bestA = Math.atan2(dy, dx) * 180 / Math.PI; }
      }
      return bestA;
    };

    // Для каждого size — привяжем к какой полилинии он ближе (для угла)
    const beams = svg('g', { class: 'beams' });
    for (const lp of luminairePlacements) {
      const lum = lp.luminaire;
      const cctK = _nearestCct(lum.cct_k);
      const type = _inferType(lum, lp.lightType);
      const shape = BEAM_SHAPES_LOCAL[type] || BEAM_SHAPES_LOCAL.spot;
      const beamDeg = lum.beam_deg || 60;
      const h = room.height;
      const spotR = h * Math.tan((beamDeg / 2) * Math.PI / 180);
      // Как в fullscreen-редакторе, показываем яркий hotspot, а не весь
      // теоретический конус до нулевой освещённости.
      const rBase = Math.min(spotR * 0.5, Math.max(L, W) / 3);

      // Ищем ближайший трек-полилинию для определения оси
      let baseAngle = 0;
      let bestPolyD = Infinity;
      for (const p of polylines) {
        for (let i = 1; i < p.length; i++) {
          const a = p[i-1], b = p[i];
          const dx = b.x - a.x, dy = b.y - a.y;
          const len2 = dx*dx + dy*dy;
          if (len2 < 1e-9) continue;
          let t = ((lp.x - a.x) * dx + (lp.y - a.y) * dy) / len2;
          t = Math.max(0, Math.min(1, t));
          const px = a.x + dx*t, py = a.y + dy*t;
          const d = Math.hypot(lp.x - px, lp.y - py);
          if (d < bestPolyD) { bestPolyD = d; baseAngle = Math.atan2(dy, dx) * 180 / Math.PI; }
        }
      }

      // Итоговая геометрия полностью повторяет fullscreen-редактор. Раньше
      // вращение круглого spot-пятна в результате визуально ничего не меняло:
      // эллипс оставался под светильником, поэтому последняя правка казалась
      // потерянной. Теперь наклон смещает центр и вытягивает hotspot.
      let beamAngle = baseAngle;
      let centerX = lp.x;
      let centerY = lp.y;
      let stretch = 1;
      const directional = _isDirectionalType(type);
      if (useScene) {
        const userDeg = lp.angle_deg != null ? lp.angle_deg : 90;
        if (directional) {
          beamAngle = userDeg;
          const rawTilt = userDeg - 90;
          const tiltNorm = ((((rawTilt + 180) % 360) + 360) % 360) - 180;
          const clampedTilt = Math.max(-45, Math.min(45, tiltNorm));
          const shiftM = h * Math.tan(Math.abs(clampedTilt) * Math.PI / 180);
          const azimuth = userDeg * Math.PI / 180;
          const sign = clampedTilt >= 0 ? 1 : -1;
          centerX += Math.cos(azimuth) * shiftM * sign;
          centerY += Math.sin(azimuth) * shiftM * sign;
          stretch = 1 / Math.max(0.4, Math.cos(Math.abs(clampedTilt) * Math.PI / 180));
        } else {
          beamAngle = baseAngle + (userDeg - 90);
        }
      }

      const sourceX = X(lp.x), sourceY = Y(lp.y);
      const cx = X(centerX), cy = Y(centerY);
      const rx = m2px(rBase * (directional ? stretch : shape.elongation));
      const ry = m2px(rBase);
      // Линия «источник → hotspot» делает финальный угол однозначно видимым.
      if (directional && Math.hypot(cx - sourceX, cy - sourceY) > 1) {
        beams.appendChild(svg('line', {
          x1: sourceX, y1: sourceY, x2: cx, y2: cy,
          stroke: CCT_COLORS_LOCAL[cctK].emit,
          'stroke-width': 1.5, 'stroke-dasharray': '4,3', opacity: 0.65,
        }));
      }
      beams.appendChild(svg('ellipse', {
        cx, cy, rx, ry,
        fill: `url(#beam-${cctK}-${type})`,
        transform: `rotate(${beamAngle} ${cx} ${cy})`,
        'data-scene-angle': useScene ? (lp.angle_deg ?? 90) : null,
      }));
    }
    root.appendChild(beams);
  }

  // --- Треки ---
  const tracks = svg('g', { class: 'tracks' });
  polylines.forEach((poly, trackIndex) => {
    const d = poly.map((p, i) => (i === 0 ? 'M' : 'L') + ' ' + X(p.x) + ' ' + Y(p.y)).join(' ');
    // Тень
    tracks.appendChild(svg('path', {
      d, fill: 'none', stroke: COLORS.trackShadow,
      'stroke-width': 8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      'data-track-index': trackIndex,
    }));
    // Основная линия
    tracks.appendChild(svg('path', {
      d, fill: 'none', stroke: COLORS.track,
      'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      filter: 'url(#glow)',
      'data-track-index': trackIndex,
    }));
  });
  root.appendChild(tracks);

  // Токоподводы: иконка на треках по настройке количества питающих.
  // feedCount — из project.system (feedMode/feeds); авто = 1 (на 1-й трек).
  const sys = project?.system || {};
  let feedCount = 1;
  if (sys.feedMode === 'manual') {
    const n = parseInt(sys.feeds, 10);
    feedCount = Number.isFinite(n) ? Math.max(0, Math.min(12, n)) : 1;
  }
  if (feedCount > 0 && polylines.length > 0) {
    const feeders = svg('g', { class: 'feeders' });
    polylines.slice(0, feedCount).forEach((poly) => {
      if (!poly || poly.length === 0) return;
      const p0 = poly[0];
      const fx = X(p0.x), fy = Y(p0.y);
      feeders.appendChild(svg('rect', {
        x: fx - 7, y: fy - 7, width: 14, height: 14,
        fill: COLORS.psu, stroke: '#fff', 'stroke-width': 1.5, rx: 3,
        'data-kind': 'feeder',
      }));
      feeders.appendChild(svg('text', {
        x: fx, y: fy + 4, 'font-size': 11, fill: '#fff',
        'text-anchor': 'middle', 'font-weight': 700,
        'pointer-events': 'none',
      }, ['⚡']));
    });
    root.appendChild(feeders);
  }

  // --- Светильники: модель, CCT, положение и угол из финальной сцены ---
  const luminairesGroup = svg('g', { class: 'luminaires' });
  for (const lp of luminairePlacements) {
    const cx = X(lp.x), cy = Y(lp.y);
    const lum = lp.luminaire;
    const type = _inferType(lum, lp.lightType);
    const directional = _isDirectionalType(type);
    const linear = type.startsWith('linear_');
    const cctK = _nearestCct(lum.cct_k);
    const color = CCT_COLORS_LOCAL[cctK].emit || COLORS.luminaire;
    const userAngle = lp.angle_deg != null ? lp.angle_deg : 90;

    let baseAngle = 0;
    let bestD = Infinity;
    for (const poly of polylines) {
      for (let i = 1; i < poly.length; i++) {
        const a = poly[i - 1], b = poly[i];
        const dx = b.x - a.x, dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        if (len2 < 1e-9) continue;
        let t = ((lp.x - a.x) * dx + (lp.y - a.y) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        const px = a.x + dx * t, py = a.y + dy * t;
        const d = Math.hypot(lp.x - px, lp.y - py);
        if (d < bestD) { bestD = d; baseAngle = Math.atan2(dy, dx) * 180 / Math.PI; }
      }
    }
    const bodyAngle = linear && useScene ? baseAngle + (userAngle - 90) : baseAngle;
    const symbol = svg('g', {
      class: `luminaire-symbol ${type}`,
      transform: `translate(${cx} ${cy})`,
      'data-slug': lum.slug,
      'data-scene-x': useScene ? lp.x : null,
      'data-scene-y': useScene ? lp.y : null,
      'data-scene-angle': useScene ? userAngle : null,
    });
    if (linear) {
      symbol.appendChild(svg('rect', {
        x: -10, y: -4, width: 20, height: 8, rx: 3,
        fill: color, stroke: '#fff', 'stroke-width': 1.25,
        transform: `rotate(${bodyAngle})`,
      }));
    } else {
      symbol.appendChild(svg('circle', {
        cx: 0, cy: 0, r: 6,
        fill: color, stroke: '#fff', 'stroke-width': 1.5,
      }));
    }
    symbol.appendChild(svg('circle', { cx: 0, cy: 0, r: 2, fill: '#fff' }));
    // Даже при скрытых пятнах финальный угол ручной сцены остаётся видимым.
    if (useScene && directional) {
      const rad = userAngle * Math.PI / 180;
      const x2 = Math.cos(rad) * 18, y2 = Math.sin(rad) * 18;
      symbol.appendChild(svg('line', {
        x1: 0, y1: 0, x2, y2,
        stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round',
      }));
      symbol.appendChild(svg('circle', { cx: x2, cy: y2, r: 2.5, fill: color }));
    }
    luminairesGroup.appendChild(symbol);
  }
  root.appendChild(luminairesGroup);

  // --- Токоподвод (питание) — красный квадратик на начале первого трека ---
  if (polylines.length > 0 && polylines[0].length > 0) {
    const start = polylines[0][0];
    const feed = svg('g', { class: 'feed' });
    feed.appendChild(svg('rect', {
      x: X(start.x) - 6, y: Y(start.y) - 6,
      width: 12, height: 12,
      fill: COLORS.psu, stroke: '#fff', 'stroke-width': 1.5,
      rx: 2,
    }));
    feed.appendChild(svg('text', {
      x: X(start.x) - 12, y: Y(start.y) - 10,
      'font-size': 10, fill: COLORS.psu, 'font-weight': 600,
      'text-anchor': 'end',
    }, ['⚡']));
    root.appendChild(feed);
  }

  // --- Размерные линии ---
  if (showDimensions) {
    root.appendChild(renderDimensions(room, X, Y, m2px));
  }

  // --- Северная стрелка и подпись ---
  if (showLabels) {
    // Название проекта / площадь / поток — вверху
    root.appendChild(svg('text', {
      x: padLeft, y: 24,
      'font-size': 13, fill: COLORS.text, 'font-weight': 600,
      'font-family': 'system-ui, sans-serif',
    }, [`План освещения · ${L}×${W} м = ${(L * W).toFixed(1)} м²`]));

    if (result) {
      root.appendChild(svg('text', {
        x: width - padRight, y: 24,
        'font-size': 12, fill: COLORS.textDim,
        'font-family': 'system-ui, sans-serif',
        'text-anchor': 'end',
      }, [
        `${totalLuminaires} светильн. · ${result.track?.actual_length_m || 0} м трека · ${result.lumens?.totalLumens?.toLocaleString('ru-RU') || '?'} лм`,
      ]));
    }
  }

  // --- Легенда снизу ---
  if (showLegend) {
    const legend = svg('g', { transform: `translate(${padLeft}, ${padTop + drawH + 20})` });
    const items = [
      { color: COLORS.track, label: 'Шинопровод', shape: 'line' },
      { color: COLORS.luminaire, label: 'Светильник', shape: 'circle' },
      { color: COLORS.psu, label: 'Токоподвод', shape: 'rect' },
    ];
    if (showBeams) items.push({ color: 'rgba(255,181,71,0.4)', label: 'Пятно света', shape: 'circle' });
    let x = 0;
    for (const it of items) {
      if (it.shape === 'line') {
        legend.appendChild(svg('line', {
          x1: x, y1: 6, x2: x + 20, y2: 6, stroke: it.color, 'stroke-width': 3, 'stroke-linecap': 'round',
        }));
      } else if (it.shape === 'circle') {
        legend.appendChild(svg('circle', { cx: x + 10, cy: 6, r: 5, fill: it.color, stroke: '#fff', 'stroke-width': 1 }));
      } else if (it.shape === 'rect') {
        legend.appendChild(svg('rect', { x: x + 4, y: 0, width: 12, height: 12, fill: it.color, rx: 2 }));
      }
      legend.appendChild(svg('text', {
        x: x + 26, y: 10, 'font-size': 11, fill: COLORS.textDim,
        'font-family': 'system-ui, sans-serif',
      }, [it.label]));
      x += 26 + (it.label.length * 6.5) + 20;
    }
    root.appendChild(legend);

    // Вторая строка легенды — зоны
    if (showZones && project.zones.length > 0) {
      const zoneLegend = svg('g', { transform: `translate(${padLeft}, ${padTop + drawH + 42})` });
      let zx = 0;
      project.zones.forEach((z, i) => {
        const normZ = db.norms.zones.find(nz => nz.id === z.zone_id);
        if (!normZ) return;
        const color = COLORS.zoneBorders[i % COLORS.zoneBorders.length];
        zoneLegend.appendChild(svg('rect', { x: zx, y: 0, width: 12, height: 12, fill: color, rx: 2, opacity: 0.6 }));
        zoneLegend.appendChild(svg('text', {
          x: zx + 18, y: 10, 'font-size': 11, fill: COLORS.textDim,
          'font-family': 'system-ui, sans-serif',
        }, [`${normZ.name} (${normZ.lux} лк)`]));
        zx += 18 + (normZ.name.length * 6.5) + 30;
      });
      root.appendChild(zoneLegend);
    }
  }

  return root;
}

// ============================================================
// Зоны (простое разбиение прямоугольника)
// ============================================================

/** Зоны результата: используем точные XYWH из редактора, legacy — полосы. */
function renderZones(project, X, Y, m2px, drawW, drawH) {
  const room = project.room;
  const L = room.length, W = room.width;
  const zones = project.zones;
  const total = zones.reduce((s, z) => s + (z.area_share || 0), 0) || 1;
  const hasFreeXY = zones.length > 0 && zones.every(z =>
    Number.isFinite(z.x) && Number.isFinite(z.y) &&
    Number.isFinite(z.w) && Number.isFinite(z.h));

  const g = svg('g', { class: 'zones', opacity: 0.75, 'data-layout': hasFreeXY ? 'xy' : 'legacy' });
  let accX = 0;
  zones.forEach((z, i) => {
    const share = (z.area_share || 0) / total;
    const fallbackW = L * share;
    const x = hasFreeXY && Number.isFinite(z.x) ? z.x : accX;
    const y = hasFreeXY && Number.isFinite(z.y) ? z.y : 0;
    const w = hasFreeXY && Number.isFinite(z.w) ? z.w : fallbackW;
    const h = hasFreeXY && Number.isFinite(z.h) ? z.h : W;
    const color = COLORS.zoneColors[i % COLORS.zoneColors.length];
    const borderColor = COLORS.zoneBorders[i % COLORS.zoneBorders.length];
    g.appendChild(svg('rect', {
      x: X(x), y: Y(y), width: m2px(w), height: m2px(h),
      fill: color, stroke: borderColor, 'stroke-width': 1, 'stroke-dasharray': '4,3',
      'data-zone-index': i,
      'data-zone-x': x, 'data-zone-y': y, 'data-zone-w': w, 'data-zone-h': h,
    }));
    g.appendChild(svg('text', {
      x: X(x + w / 2), y: Y(y + Math.min(h / 2, 0.4)),
      'font-size': 10, fill: borderColor, 'font-weight': 600,
      'text-anchor': 'middle', 'font-family': 'system-ui, sans-serif',
      'pointer-events': 'none',
    }, [`Зона ${i + 1}`]));
    if (!hasFreeXY) accX += fallbackW;
  });

  return g;
}

// ============================================================
// Размерные линии (ГОСТ-подобная нотация)
// ============================================================

function renderDimensions(room, X, Y, m2px) {
  const L = room.length, W = room.width;
  const g = svg('g', { class: 'dimensions' });
  const offsetTop = 20;      // размер сверху
  const offsetRight = 20;    // размер справа

  // Ширина сверху
  const yTop = Y(0) - offsetTop;
  g.appendChild(svg('line', {
    x1: X(0), y1: yTop, x2: X(L), y2: yTop,
    stroke: COLORS.textDim, 'stroke-width': 0.75,
  }));
  // Засечки
  g.appendChild(svg('line', { x1: X(0), y1: yTop - 5, x2: X(0), y2: yTop + 5, stroke: COLORS.textDim, 'stroke-width': 1 }));
  g.appendChild(svg('line', { x1: X(L), y1: yTop - 5, x2: X(L), y2: yTop + 5, stroke: COLORS.textDim, 'stroke-width': 1 }));
  g.appendChild(svg('text', {
    x: (X(0) + X(L)) / 2, y: yTop - 6,
    'font-size': 11, fill: COLORS.text, 'text-anchor': 'middle',
    'font-family': 'system-ui, sans-serif',
  }, [`${L.toFixed(1)} м`]));

  // Высота справа
  const xRight = X(L) + offsetRight;
  g.appendChild(svg('line', {
    x1: xRight, y1: Y(0), x2: xRight, y2: Y(W),
    stroke: COLORS.textDim, 'stroke-width': 0.75,
  }));
  g.appendChild(svg('line', { x1: xRight - 5, y1: Y(0), x2: xRight + 5, y2: Y(0), stroke: COLORS.textDim, 'stroke-width': 1 }));
  g.appendChild(svg('line', { x1: xRight - 5, y1: Y(W), x2: xRight + 5, y2: Y(W), stroke: COLORS.textDim, 'stroke-width': 1 }));
  g.appendChild(svg('text', {
    x: xRight + 6, y: (Y(0) + Y(W)) / 2 + 4,
    'font-size': 11, fill: COLORS.text,
    'font-family': 'system-ui, sans-serif',
  }, [`${W.toFixed(1)} м`]));

  return g;
}

// ============================================================
// Экспорт SVG → PNG / DataURL
// ============================================================

/** SVG-элемент → data:image/svg+xml;base64,... (для <img src>, для PDF) */
export function svgToDataUrl(svgEl) {
  const s = new XMLSerializer().serializeToString(svgEl);
  return 'data:image/svg+xml;charset=utf-8;base64,' + btoa(unescape(encodeURIComponent(s)));
}

/** SVG → PNG Blob (для скачивания или вставки в PDF) */
export async function svgToPng(svgEl, scale = 2) {
  const url = svgToDataUrl(svgEl);
  const width = parseInt(svgEl.getAttribute('width') || svgEl.viewBox?.baseVal?.width || 800);
  const height = parseInt(svgEl.getAttribute('height') || svgEl.viewBox?.baseVal?.height || 600);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return await new Promise(res => canvas.toBlob(res, 'image/png'));
}

/** Скачать SVG-элемент как файл */
export function downloadSvg(svgEl, filename = 'plan.svg') {
  const s = new XMLSerializer().serializeToString(svgEl);
  const blob = new Blob([s], { type: 'image/svg+xml' });
  triggerDownload(blob, filename);
}
export async function downloadPng(svgEl, filename = 'plan.png', scale = 2) {
  const blob = await svgToPng(svgEl, scale);
  triggerDownload(blob, filename);
}
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
