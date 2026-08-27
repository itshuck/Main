/**
 * scene.js — редактируемая сцена (модель данных для drag-and-drop редактора).
 *
 * Сцена — это плоское, сериализуемое состояние всех объектов на плане:
 *   { tracks: [Track], luminaires: [Luminaire], version: 1 }
 *
 * Track      = { id, points: [{x,y}...], voltage_v, color, mount, pinned? }
 * Luminaire  = { id, x, y, angle_deg, slug, on_track_id?, t?, pinned? }
 *   on_track_id — если светильник «примагничен» к треку
 *   t           — доля вдоль полилинии трека [0..1] (для магнитных)
 *
 * Все координаты — в МЕТРАХ от левого-верхнего угла помещения.
 * Углы — в градусах, 0° = вправо, 90° = вниз.
 *
 * Гибридная стратегия «авто + ручное»:
 *   autoLayoutFromProject() — генерирует сцену из project (пресета)
 *   applyManualEdits()      — накатывает pinned-объекты поверх авто
 *   pinAll() / resetToAuto() — для UI-кнопок
 */

import { buildZonePolylines, distributeLuminaires } from './render2d.js?v=20260826-ui14';

// ============================================================
// Утилиты идентификаторов
// ============================================================
let _nextId = 1;
export function newId(prefix = 'obj') {
  return `${prefix}_${_nextId++}_${Math.random().toString(36).slice(2, 6)}`;
}

// ============================================================
// Автогенерация сцены из проекта
// ============================================================

/**
 * По project + результату computeProject строит сцену: треки согласно layout,
 * светильники распределены равномерно вдоль треков.
 *
 * Все объекты — с флагом pinned=false (могут быть перезаписаны при пересчёте).
 */
export function autoLayoutFromProject(project, result) {
  const room = project.room;
  // При нескольких зонах разводка строится внутри каждой зоны, а не через весь план.
  const polylines = buildZonePolylines(project);

  // Треки
  const tracks = polylines.map(pts => ({
    id: newId('trk'),
    points: pts.map(p => ({ x: p.x, y: p.y })),
    voltage_v: project.system.voltage_v,
    color: project.system.color,
    mount: project.system.mount,
    pinned: false,
  }));

  // Светильники: раскидываем по трекам пропорционально длине.
  // В ручном режиме («Типы светильников» в Шаге 3) используем заданные
  // пользователем количества по типам света; иначе — автоподбор из result.
  const luminaires = [];
  if (!result || !result.luminaires) return { tracks, luminaires, version: 1 };

  const flat = buildMixFlat(project, result) || (() => {
    const arr = [];
    for (const sel of result.luminaires) {
      for (let i = 0; i < sel.qty; i++) {
        arr.push({ slug: sel.luminaire.slug, luminaireRef: sel.luminaire, lightType: null });
      }
    }
    return arr;
  })();

  const lengths = polylines.map(polylineLength);
  const totalLen = lengths.reduce((s, length) => s + length, 0);
  // Метод наибольших остатков: сумма по линиям всегда РОВНО flat.length.
  // Независимое Math.round() давало +1 светильник на симметричных линиях.
  const ideals = lengths.map(length => flat.length * length / (totalLen || 1));
  const counts = ideals.map(Math.floor);
  let remaining = flat.length - counts.reduce((sum, count) => sum + count, 0);
  const remainderOrder = ideals
    .map((ideal, index) => ({ index, fraction: ideal - counts[index] }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  if (remainderOrder.length > 0) {
    for (let i = 0; i < remaining; i++) {
      counts[remainderOrder[i % remainderOrder.length].index] += 1;
    }
  }

  let idx = 0;
  polylines.forEach((poly, pi) => {
    const positions = distributeLuminaires(poly, counts[pi] || 0);
    positions.forEach(pos => {
      const lum = flat[idx] || flat[flat.length - 1];
      if (!lum) return;
      const lumObj = {
        id: newId('lum'),
        x: pos.x,
        y: pos.y,
        angle_deg: pos.angle_deg,
        slug: lum.slug,
        on_track_id: tracks[pi]?.id || null,
        t: distToParam(poly, pos),
        pinned: false,
      };
      if (lum.lightType) lumObj.lightType = lum.lightType;
      luminaires.push(lumObj);
      idx++;
    });
  });

  return { tracks, luminaires, version: 1 };
}

// Типы света для встраиваемых и трековых (согласовано с cct.LIGHT_TYPE_OPTIONS)
export const DOWNLIGHT_TYPE_IDS = ['rasseivayushchiy', 'napravlennyy', 'fokus_lens', 'povorotnyy', 'staticheskiy'];
export const TRACK_TYPE_IDS = ['rasseivayushchiy', 'napravlennyy', 'fokus_lens', 'povorotnyy'];

/**
 * Строит «плоский» список светильников по ручной настройке типов/количеств
 * из Шага 3 («Система освещения» → «Типы светильников»).
 * Возвращает null, если ручной режим не включён или mix пуст — тогда
 * используется автоподбор (из result).
 */
export function buildMixFlat(project, result) {
  const sys = project.system || {};
  if (sys.lightMode !== 'manual') return null;
  const mix = sys.lightMix;
  if (!mix) return null;

  const dMix = mix.downlight || {};
  const tMix = mix.track || {};
  const dTotal = DOWNLIGHT_TYPE_IDS.reduce((s, id) => s + (dMix[id] || 0), 0);
  const tTotal = TRACK_TYPE_IDS.reduce((s, id) => s + (tMix[id] || 0), 0);
  if (dTotal === 0 && tTotal === 0) return null;

  // Представительные модели по ролям — из результата автоподбора (чтобы взять
  // реальный товар каталога того же напряжения/CRI). Fallback — первая подходящая.
  const resultLums = result?.luminaires || [];
  const downlightModel = (resultLums.find(s => s.luminaire.role === 'downlight_luminaire') || {}).luminaire;
  const trackModel = (resultLums.find(s => s.luminaire.role === 'luminaire') || {}).luminaire;

  const flat = [];
  if (downlightModel && dTotal > 0) {
    for (const id of DOWNLIGHT_TYPE_IDS) {
      for (let i = 0; i < (dMix[id] || 0); i++) {
        flat.push({ slug: downlightModel.slug, luminaireRef: downlightModel, lightType: id });
      }
    }
  }
  if (trackModel && tTotal > 0) {
    for (const id of TRACK_TYPE_IDS) {
      for (let i = 0; i < (tMix[id] || 0); i++) {
        flat.push({ slug: trackModel.slug, luminaireRef: trackModel, lightType: id });
      }
    }
  }
  return flat.length ? flat : null;
}

function polylineLength(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return s;
}

// Обратное преобразование: точка → параметр t [0..1] вдоль полилинии
function distToParam(pts, point) {
  const total = polylineLength(pts);
  if (total === 0) return 0;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    // Проекция точки на сегмент
    const dx = b.x - a.x, dy = b.y - a.y;
    if (segLen < 1e-9) continue;
    const tSeg = ((point.x - a.x) * dx + (point.y - a.y) * dy) / (segLen * segLen);
    const projX = a.x + dx * tSeg;
    const projY = a.y + dy * tSeg;
    const dist = Math.hypot(point.x - projX, point.y - projY);
    if (dist < 0.01 && tSeg >= -0.01 && tSeg <= 1.01) {
      return Math.max(0, Math.min(1, (acc + segLen * Math.max(0, Math.min(1, tSeg))) / total));
    }
    acc += segLen;
  }
  return 0;
}

/**
 * Обратное: по параметру t [0..1] и трассе — координаты (x, y).
 */
export function paramToPoint(polylinePts, t) {
  const total = polylineLength(polylinePts);
  if (total === 0 || polylinePts.length < 2) return { x: 0, y: 0 };
  const target = Math.max(0, Math.min(1, t)) * total;
  let acc = 0;
  for (let i = 1; i < polylinePts.length; i++) {
    const a = polylinePts[i - 1], b = polylinePts[i];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (acc + segLen >= target) {
      const localT = segLen === 0 ? 0 : (target - acc) / segLen;
      return { x: a.x + (b.x - a.x) * localT, y: a.y + (b.y - a.y) * localT };
    }
    acc += segLen;
  }
  return { ...polylinePts[polylinePts.length - 1] };
}

// ============================================================
// Магнитное защёлкивание к ближайшему треку
// ============================================================

/**
 * Находит ближайшую точку на любом треке в сцене к заданной (x, y).
 * @returns {{track_id, t, x, y, dist} | null}
 */
export function snapToNearestTrack(scene, point, maxDistM = 0.5) {
  let best = null;
  for (const track of scene.tracks) {
    for (let i = 1; i < track.points.length; i++) {
      const a = track.points[i - 1], b = track.points[i];
      const dx = b.x - a.x, dy = b.y - a.y;
      const segLen2 = dx * dx + dy * dy;
      if (segLen2 < 1e-9) continue;
      // Проекция
      let tSeg = ((point.x - a.x) * dx + (point.y - a.y) * dy) / segLen2;
      tSeg = Math.max(0, Math.min(1, tSeg));
      const projX = a.x + dx * tSeg;
      const projY = a.y + dy * tSeg;
      const dist = Math.hypot(point.x - projX, point.y - projY);
      if (dist > maxDistM) continue;
      if (!best || dist < best.dist) {
        // Пересчитаем t относительно ВСЕЙ полилинии
        let acc = 0;
        for (let j = 1; j < i; j++) {
          acc += Math.hypot(track.points[j].x - track.points[j - 1].x, track.points[j].y - track.points[j - 1].y);
        }
        acc += Math.sqrt(segLen2) * tSeg;
        const total = polylineLength(track.points);
        best = {
          track_id: track.id,
          t: total > 0 ? acc / total : 0,
          x: projX, y: projY, dist,
        };
      }
    }
  }
  return best;
}

// ============================================================
// Модификации сцены (иммутабельные — возвращают новый объект)
// ============================================================

/**
 * Переместить светильник. Если под точкой есть трек — магнитим к нему.
 */
export function moveLuminaire(scene, luminaireId, newPoint, snapMaxDistM = 0.4) {
  const lum = scene.luminaires.find(l => l.id === luminaireId);
  if (!lum) return scene;

  const snap = snapToNearestTrack(scene, newPoint, snapMaxDistM);
  const updated = {
    ...lum,
    pinned: true,
  };
  if (snap) {
    updated.x = snap.x;
    updated.y = snap.y;
    updated.on_track_id = snap.track_id;
    updated.t = snap.t;
  } else {
    // «Отрываем» от трека
    updated.x = newPoint.x;
    updated.y = newPoint.y;
    updated.on_track_id = null;
    updated.t = null;
  }

  return {
    ...scene,
    luminaires: scene.luminaires.map(l => l.id === luminaireId ? updated : l),
  };
}

/**
 * Изменить угол луча (только визуально в 2D-плане).
 * В плане сверху угол влияет на визуализацию направления «носика» светильника,
 * т.к. свет всегда идёт вниз, к полу.
 */
export function setLuminaireAngle(scene, luminaireId, angleDeg) {
  return {
    ...scene,
    luminaires: scene.luminaires.map(l => l.id === luminaireId
      ? { ...l, angle_deg: angleDeg, pinned: true }
      : l),
  };
}

/**
 * Заменить модель светильника (drag из палитры на существующий).
 */
export function setLuminaireModel(scene, luminaireId, slug) {
  return {
    ...scene,
    luminaires: scene.luminaires.map(l => l.id === luminaireId
      ? { ...l, slug, pinned: true }
      : l),
  };
}

/**
 * Переопределить тип света/лампы (рассеивающий, направленный, фокус-линза,
 * поворотный, статический) для конкретного светильника. Сохраняется в сцене
 * и влияет на отрисовку пятна/пучка и ограничения поворота.
 */
export function setLuminaireLightType(scene, luminaireId, lightType) {
  return {
    ...scene,
    luminaires: scene.luminaires.map(l => l.id === luminaireId
      ? { ...l, lightType, pinned: true }
      : l),
  };
}

/**
 * Добавить новый светильник (drop из палитры).
 */
export function addLuminaire(scene, { x, y, slug, angle_deg = 90, lightType = null }) {
  const snap = snapToNearestTrack(scene, { x, y });
  const lum = {
    id: newId('lum'),
    x: snap ? snap.x : x,
    y: snap ? snap.y : y,
    angle_deg,
    slug,
    on_track_id: snap ? snap.track_id : null,
    t: snap ? snap.t : null,
    pinned: true,
  };
  if (lightType) lum.lightType = lightType;
  return { ...scene, luminaires: [...scene.luminaires, lum] };
}

/**
 * Добавить сразу несколько светильников (количество управляется в палитре).
 * Позиции распределяются по ближайшему треку (или по прямой от центра).
 */
export function addLuminaires(scene, { x, y, slug, count = 1, lightType = null }) {
  let s = scene;
  const n = Math.max(1, Math.min(count, 50));
  for (let i = 0; i < n; i++) {
    const off = (i - (n - 1) / 2) * 0.8; // шаг 0.8 м по горизонтали
    const target = snapToNearestTrack(scene, { x: x + off, y });
    const px = target ? target.x : x + off;
    const py = target ? target.y : y;
    s = addLuminaire(s, { x: px, y: py, slug, angle_deg: 90, lightType });
  }
  return s;
}

/**
 * Удалить объект (светильник или трек).
 */
export function removeObject(scene, id) {
  return {
    ...scene,
    tracks: scene.tracks.filter(t => t.id !== id),
    // При удалении трека — светильники «сваливаются» с него (on_track_id = null)
    luminaires: scene.luminaires
      .filter(l => l.id !== id)
      .map(l => l.on_track_id === id ? { ...l, on_track_id: null, t: null, pinned: true } : l),
  };
}

/**
 * Переместить трек целиком (все точки на dx, dy). Светильники на нём двигаются вместе.
 */
export function moveTrack(scene, trackId, dxM, dyM) {
  const track = scene.tracks.find(t => t.id === trackId);
  if (!track) return scene;
  const newPoints = track.points.map(p => ({ x: p.x + dxM, y: p.y + dyM }));
  return {
    ...scene,
    tracks: scene.tracks.map(t => t.id === trackId
      ? { ...t, points: newPoints, pinned: true }
      : t),
    luminaires: scene.luminaires.map(l => {
      if (l.on_track_id !== trackId) return l;
      // Двигаем светильник вместе с треком по тому же t
      const newXY = paramToPoint(newPoints, l.t || 0);
      return { ...l, x: newXY.x, y: newXY.y, pinned: true };
    }),
  };
}

/**
 * Добавить новый трек (drop из палитры).
 * Треки создаются длиной 2м по горизонтали от точки drop.
 */
export function addTrack(scene, { x, y, voltage_v = 48, color = 'black', mount = 'nakladnoi', lengthM = 2 }) {
  const trk = {
    id: newId('trk'),
    points: [{ x, y }, { x: x + lengthM, y }],
    voltage_v, color, mount,
    pinned: true,
  };
  return { ...scene, tracks: [...scene.tracks, trk] };
}

/**
 * Изменить одну из конечных точек трека (для «растягивания»).
 */
export function moveTrackPoint(scene, trackId, pointIdx, newXY) {
  const track = scene.tracks.find(t => t.id === trackId);
  if (!track) return scene;
  if (pointIdx < 0 || pointIdx >= track.points.length) return scene;
  const newPoints = track.points.map((p, i) => i === pointIdx ? { ...newXY } : p);
  return {
    ...scene,
    tracks: scene.tracks.map(t => t.id === trackId
      ? { ...t, points: newPoints, pinned: true }
      : t),
    // Светильники на треке — пересчитываем их позицию по сохранённому t
    luminaires: scene.luminaires.map(l => {
      if (l.on_track_id !== trackId) return l;
      const newXY2 = paramToPoint(newPoints, l.t || 0);
      return { ...l, x: newXY2.x, y: newXY2.y };
    }),
  };
}

// ============================================================
// Гибридная стратегия «авто + ручные правки»
// ============================================================

/**
 * Умный пересчёт при изменении параметров в мастере (напряжение, зоны, схема...).
 *
 * Стратегия:
 *   1. Строим новую auto-сцену из project.
 *   2. Треки: если ВСЕ старые треки без правок (не pinned) — заменяем полностью.
 *              Если есть pinned — оставляем pinned как есть, добавляем разницу.
 *   3. Светильники: pinned — сохраняем координаты. Не-pinned — заменяем на auto.
 *
 * Возвращает { scene, note } — где note может содержать предупреждение,
 * что ручные правки пришлось сбросить (например, при смене напряжения).
 */
export function reconcileScene(oldScene, project, result, opts = {}) {
  const { forceReset = false } = opts;
  const autoScene = autoLayoutFromProject(project, result);

  if (forceReset || !oldScene) {
    return { scene: autoScene, note: null };
  }

  // Треки: если ни один не был закреплён вручную — заменяем на авто.
  const pinnedTracks = oldScene.tracks.filter(t => t.pinned);
  const nonPinnedOld = oldScene.tracks.filter(t => !t.pinned);
  let newTracks;
  if (pinnedTracks.length === 0) {
    // Всё было авто → берём новую авто-раскладку целиком
    newTracks = autoScene.tracks;
  } else {
    // Есть ручные — оставляем их + добавляем авто-треки, которых не хватает
    // (упрощение: берём pinned + все новые auto — это может дать «двойные» треки,
    //  что решается ручным удалением. Для MVP — так)
    const idsFromAuto = autoScene.tracks.map(t => t.id);
    newTracks = [...pinnedTracks, ...autoScene.tracks.slice(pinnedTracks.length)];
  }

  // Светильники: pinned сохраняем; не-pinned заменяем на auto.
  const pinnedLums = oldScene.luminaires.filter(l => l.pinned);
  const nonPinnedAuto = autoScene.luminaires;

  // Если pinned больше, чем нужно светильников — оставим только их (не будем перебирать)
  // Если pinned меньше — добавим недостающие из auto
  const deficit = Math.max(0, nonPinnedAuto.length - pinnedLums.length);
  const extraFromAuto = nonPinnedAuto.slice(0, deficit);
  const newLums = [...pinnedLums, ...extraFromAuto];

  // Валидация: pinned светильники, привязанные к удалённому треку — «свободные»
  const trackIds = new Set(newTracks.map(t => t.id));
  const cleanedLums = newLums.map(l =>
    l.on_track_id && !trackIds.has(l.on_track_id)
      ? { ...l, on_track_id: null, t: null }
      : l);

  return {
    scene: { tracks: newTracks, luminaires: cleanedLums, version: (oldScene.version || 1) + 1 },
    note: pinnedLums.length > 0 || pinnedTracks.length > 0
      ? `Сохранено ${pinnedLums.length} ручных правок светильников и ${pinnedTracks.length} треков.`
      : null,
  };
}

// ============================================================
// Утилиты для внешнего кода
// ============================================================

/** Получить статистику сцены — сколько треков/светильников pinned */
export function sceneStats(scene) {
  return {
    tracks_total: scene.tracks.length,
    tracks_pinned: scene.tracks.filter(t => t.pinned).length,
    luminaires_total: scene.luminaires.length,
    luminaires_pinned: scene.luminaires.filter(l => l.pinned).length,
    total_track_length_m: scene.tracks.reduce((s, t) => s + polylineLength(t.points), 0),
  };
}

/** Убрать все pinned-флаги (для «сброса к авто») */
export function unpinAll(scene) {
  return {
    ...scene,
    tracks: scene.tracks.map(t => ({ ...t, pinned: false })),
    luminaires: scene.luminaires.map(l => ({ ...l, pinned: false })),
  };
}

/** Экспортировать сцену для сохранения (компактный JSON) */
export function serializeScene(scene) {
  return JSON.stringify(scene);
}
export function deserializeScene(str) {
  try { return JSON.parse(str); } catch { return null; }
}
