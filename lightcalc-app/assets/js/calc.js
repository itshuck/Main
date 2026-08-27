/**
 * calc.js — движок расчёта трекового освещения (чистые функции).
 *
 * Все функции — детерминированные, без побочных эффектов, тестируемые.
 * Формулы: см. 00_ANALYSIS_AND_PLAN.md §3.
 *
 * Импорт:
 *   import * as Calc from './calc.js';
 *   const lm = Calc.requiredLumensForZone({areaM2: 15, luxTarget: 300, k: 1.4, eta: 0.5});
 */

// ============================================================
// 1. Геометрия помещения
// ============================================================

/** Индекс помещения i = a·b / (h·(a+b)) — определяет коэф. использования η */
export function roomIndex({ length, width, height }) {
  const a = Number(length), b = Number(width), h = Number(height);
  if (!(a > 0) || !(b > 0) || !(h > 0)) return 0;
  return (a * b) / (h * (a + b));
}

/** По индексу помещения выбираем η из таблицы norms.usage_coeff_eta */
export function pickUsageEta(roomIdx, etaTable) {
  const rows = Object.values(etaTable).filter(r => typeof r === 'object' && 'i_max' in r);
  rows.sort((a, b) => a.i_max - b.i_max);
  for (const r of rows) {
    if (roomIdx <= r.i_max) return r.eta;
  }
  return rows[rows.length - 1]?.eta ?? 0.5;
}

// ============================================================
// 2. Световой поток
// ============================================================

/**
 * Требуемый суммарный световой поток для зоны, лм.
 *   Φ = E · S · k / η
 * @param {number} areaM2   площадь зоны, м²
 * @param {number} luxTarget нормативная освещённость, лк
 * @param {number} k        коэф. запаса (1.2–1.5)
 * @param {number} eta      коэф. использования (0.35–0.70)
 */
export function requiredLumensForZone({ areaM2, luxTarget, k = 1.3, eta = 0.5 }) {
  if (!(areaM2 > 0) || !(luxTarget > 0) || !(eta > 0)) return 0;
  return Math.ceil((luxTarget * areaM2 * k) / eta);
}

/** Требуемый суммарный поток для всего помещения (по всем зонам) */
export function requiredLumensTotal({ zones, totalArea, k, eta, normsZones, safetyFactors = null }) {
  let sum = 0;
  const perZone = [];
  for (const [zoneIndex, z] of zones.entries()) {
    const normZone = normsZones.find(nz => nz.id === z.zone_id);
    if (!normZone) continue;
    const areaM2 = totalArea * (z.area_share ?? 0);
    const zoneK = safetyFactors?.[normZone.group] || k;
    const lm = requiredLumensForZone({
      areaM2,
      luxTarget: normZone.lux,
      k: zoneK,
      eta,
    });
    // zone_index обязателен: одинаковые типы зон допустимы и не должны
    // получать поток первого совпадения через find(zone_id).
    perZone.push({
      zone_index: zoneIndex,
      zone_id: z.zone_id,
      name: normZone.name,
      areaM2,
      luxTarget: normZone.lux,
      k_safety: zoneK,
      lumens: lm,
    });
    sum += lm;
  }
  return { totalLumens: sum, perZone };
}

// ============================================================
// 3. Подбор светильников из каталога
// ============================================================

/**
 * Фильтрация светильников из каталога под систему и зону.
 * @param {Array} catalog массив products из catalog.json
 * @param {Object} opts   { voltage_v, minLumen, maxLumen, beamRange:[min,max], cctK, cri_min }
 */
export function filterLuminaires(catalog, opts = {}) {
  return catalog.filter(p => {
    if (p.role !== 'luminaire') return false;
    if (p.in_stock === false) return false;
    if (!p.lumen || !p.power_w) return false;
    if (opts.voltage_v && p.voltage_v && p.voltage_v !== opts.voltage_v) return false;
    if (opts.cctK && p.cct_k && p.cct_k !== opts.cctK) return false;
    if (opts.cri_min && p.cri && p.cri < opts.cri_min) return false;
    if (opts.beamRange && p.beam_deg) {
      const [bmin, bmax] = opts.beamRange;
      if (p.beam_deg < bmin || p.beam_deg > bmax) return false;
    }
    return true;
  });
}

/**
 * Подобрать оптимальный светильник и его количество для зоны.
 * Стратегия: берём светильник с максимальной эффективностью (лм/Вт),
 * подходящий по CCT и углу; количество — ceil(требуемый_поток / поток_светильника).
 * Ограничение: количество должно быть в [minQty, maxQty] (например, 2..20).
 */
export function pickLuminaireForZone({ zoneRequirements, catalog, system, options = {} }) {
  const {
    minQty = 2,
    maxQty = 30,
    preferSeries = null,
  } = options;

  const candidates = filterLuminaires(catalog, {
    voltage_v: system.voltage_v,
    cctK: zoneRequirements.cct_k,
    beamRange: zoneRequirements.beam_deg,
    cri_min: zoneRequirements.cri_min,
  });

  if (candidates.length === 0) {
    // Fallback: снять ограничение по CCT
    const relaxed = filterLuminaires(catalog, {
      voltage_v: system.voltage_v,
      beamRange: zoneRequirements.beam_deg,
    });
    if (relaxed.length === 0) return null;
    candidates.push(...relaxed);
  }

  // Скоринг: чем ближе к требуемому потоку × количество из диапазона [minQty..maxQty] — тем лучше
  let best = null;
  for (const cand of candidates) {
    const efficacy = cand.lumen / (cand.power_w || 1);   // лм/Вт
    const qtyRaw = zoneRequirements.lumens / cand.lumen;
    const qty = Math.max(minQty, Math.min(maxQty, Math.ceil(qtyRaw)));
    const actualLumens = qty * cand.lumen;
    const excess = actualLumens - zoneRequirements.lumens;
    // штрафуем большой пересвет и малое кол-во ламп
    const overshootPenalty = Math.max(0, excess / zoneRequirements.lumens);
    const seriesBonus = (preferSeries && cand.series === preferSeries) ? 0.1 : 0;
    const score = efficacy / 100 - overshootPenalty * 0.5 + seriesBonus;
    if (!best || score > best.score) {
      best = { luminaire: cand, qty, actualLumens, score, excess };
    }
  }
  return best;
}

// ============================================================
// 4. Длина трека и подбор шинопровода
// ============================================================

/**
 * Расчётная длина шинопровода по типу схемы.
 * @param {string} layout   id из presets.track_layouts (line_center|L_shape|U_shape|...)
 * @param {Object} room     {length, width}
 * @param {number} offset   отступ от стен, м (по умолч. 0.3)
 */
export function calcTrackLength(layout, room, offset = 0.3) {
  const L = room.length, W = room.width;
  switch (layout) {
    case 'line_center':          return Math.max(0, L - 2 * offset);
    // Формулы совпадают с фактическими полилиниями buildTrackPolylines:
    // каждый пролёт идёт от offset до dimension-offset.
    case 'L_shape':              return (L - 2 * offset) + (W - 2 * offset);
    case 'U_shape':              return (L - 2 * offset) + 2 * (W - 2 * offset);
    case 'perimeter_partial':    return 2 * (L + W) - 8 * offset;
    case 'parallel_lines':       return 2 * (L - 2 * offset);
    case 'parallel_lines_walls': return 2 * (L - 2 * offset);
    case 'line_mirror':          return 1.2;
    case 'custom':               return Math.max(0, L - 2 * offset);
    default:                     return Math.max(0, L - 2 * offset);
  }
}

/**
 * Суммарная длина треков при разводке «по зонам» (несколько зон):
 * каждый трек строится внутри своей зоны, поэтому длина складывается из
 * длин в каждой зоне. Для одного помещения — обычная длина по всему плану.
 */
export function calcTrackLengthZones(layout, room, zones = [], offset = 0.3) {
  const realZones = (zones || []).filter(z => z && Number.isFinite(z.w) && Number.isFinite(z.h));
  if (realZones.length > 1) {
    let total = 0;
    for (const z of realZones) {
      total += calcTrackLength(layout, { length: z.w, width: z.h }, 0.25);
    }
    return Math.max(0, total);
  }
  return calcTrackLength(layout, room, offset);
}

/**
 * Количество токоподводов (питающих соединителей) по настройке системы.
 * 'auto' → null (движок берёт 1 на трек); 'manual' → явное число.
 */
export function feedCount(system = {}) {
  if (system.feedMode === 'manual') {
    const n = Number.parseInt(system.feeds, 10);
    if (Number.isFinite(n) && n >= 0) return Math.min(12, n);
  }
  return null;
}

/**
 * Разложить нужную длину трека на секции 1м и 2м из каталога.
 * Стратегия: жадный алгоритм — сначала 2м, остаток — 1м.
 * @param {number} lengthM   требуемая длина, м
 * @param {Array} catalog    products
 * @param {Object} opts      {voltage_v, color, mount: 'nakladnoi'|'vstraivaemyy'}
 */
export function pickShinoprovod({ lengthM, catalog, voltage_v = 48, color = 'black', mount = 'nakladnoi' }) {
  const rails = catalog.filter(p =>
    p.role === 'shinoprovod' &&
    p.in_stock !== false &&
    p.voltage_v === voltage_v &&
    p.length_m &&
    (!color || !p.color || p.color === color) &&
    (mount === 'any' || matchesMount(p.name, mount))
  );

  if (rails.length === 0) {
    // fallback: снимаем цвет и монтаж
    const any = catalog.filter(p =>
      p.role === 'shinoprovod' && p.in_stock !== false &&
      p.voltage_v === voltage_v && p.length_m);
    if (any.length === 0) return { items: [], total_length: 0, total_price: 0 };
    rails.push(...any);
  }

  const rail2m = rails.find(r => r.length_m === 2) || rails.find(r => r.length_m >= 2);
  const rail1m = rails.find(r => r.length_m === 1) || rails.find(r => r.length_m < 2);

  const items = [];
  // Считаем в целых дециметрах: float-остаток 0.10000000000000009 раньше
  // мог ошибочно добавлять лишнюю метровую секцию.
  let needDm = Math.max(0, Math.ceil((lengthM - 1e-9) * 10));

  if (rail2m) {
    const rail2Dm = Math.round(rail2m.length_m * 10);
    const n2 = Math.floor(needDm / rail2Dm);
    if (n2 > 0) {
      items.push({ product: rail2m, qty: n2 });
      needDm -= n2 * rail2Dm;
    }
  }
  if (needDm > 0 && rail1m) {
    const rail1Dm = Math.round(rail1m.length_m * 10);
    const n1 = Math.ceil(needDm / rail1Dm);
    items.push({ product: rail1m, qty: n1 });
    needDm = 0;
  } else if (needDm > 0 && rail2m) {
    // если короткой секции нет — добавляем ещё одну длинную
    const last = items.find(i => i.product.slug === rail2m.slug);
    if (last) last.qty += 1; else items.push({ product: rail2m, qty: 1 });
    needDm = 0;
  }

  const total_length = items.reduce((s, i) => s + i.product.length_m * i.qty, 0);
  const total_price = items.reduce((s, i) => s + (i.product.price_rub || 0) * i.qty, 0);
  return { items, total_length, total_price };
}

function matchesMount(name, mount) {
  const n = name.toLowerCase();
  if (mount === 'vstraivaemyy') return n.includes('встра');
  if (mount === 'nakladnoi') return n.includes('наклад') || n.includes('подвес') || !n.includes('встра');
  return true;
}

// ============================================================
// 5. Подбор коннекторов
// ============================================================

/**
 * Оценка нужных коннекторов по типу схемы.
 * Всегда нужен 1 токоподвод (соединитель с проводом).
 * Плюс: по 1 угловому на каждый угол схемы, по 1 прямому на каждый стык прямых секций.
 */
export function pickConnectors({ layout, trackSegments, catalog, voltage_v = 48, feeds = 1 }) {
  const cons = catalog.filter(p =>
    p.role === 'connector' && p.in_stock !== false &&
    (!p.voltage_v || p.voltage_v === voltage_v));
  const findByHint = (hint) => cons.find(c => c.name.toLowerCase().includes(hint));

  const feed   = findByHint('коннектор') || cons.find(c => c.name.toLowerCase().includes('токоподв')) || cons[0];
  const straight = findByHint('прямой');
  const corner   = findByHint('углов');

  const items = [];
  const feedQty = clampInt(feeds, 0, 12);
  if (feed && feedQty > 0) {
    items.push({ product: feed, qty: feedQty, purpose: `токоподводы (${feedQty} шт)` });
  }

  const cornersMap = {
    line_center: 0, line_mirror: 0,
    L_shape: 1, U_shape: 2,
    perimeter_partial: 4,
    parallel_lines: 0, parallel_lines_walls: 0,
    custom: 0,
  };
  const cornersQty = cornersMap[layout] ?? 0;
  if (cornersQty > 0 && corner) items.push({ product: corner, qty: cornersQty, purpose: 'угловое соединение' });

  // Прямые соединители: между секциями трека -1 (если >1 секция)
  const straightQty = Math.max(0, (trackSegments || 1) - 1 - cornersQty);
  if (straightQty > 0 && straight) items.push({ product: straight, qty: straightQty, purpose: 'стык секций' });

  const total_price = items.reduce((s, i) => s + (i.product.price_rub || 0) * i.qty, 0);
  return { items, total_price };
}

// ============================================================
// 6. Блок питания (для 48В систем)
// ============================================================

/**
 * Подобрать БП по суммарной мощности светильников с запасом 20% и КПД 85%.
 * Требуется только для 48В систем; для 220В — БП не нужен.
 */
export function pickPowerSupply({ totalPowerW, catalog, voltage_v = 48, kSafety = 1.20, efficiency = 0.85 }) {
  if (voltage_v !== 48 && voltage_v !== 24 && voltage_v !== 12) return null;
  const required = Math.ceil(totalPowerW / efficiency * kSafety);
  const psus = catalog
    .filter(p => p.role === 'psu' && p.in_stock !== false &&
      p.voltage_v === voltage_v && p.power_w)
    .sort((a, b) => a.power_w - b.power_w);

  if (psus.length === 0) return { required_w: required, product: null, qty: 0, note: 'Нет БП с нужным напряжением в каталоге' };

  // 1) Один БП, покрывающий с запасом
  const single = psus.find(p => p.power_w >= required);
  if (single) return { required_w: required, product: single, qty: 1 };

  // 2) Несколько БП максимальной мощности параллельно
  const max = psus[psus.length - 1];
  const qty = Math.ceil(required / max.power_w);
  return { required_w: required, product: max, qty, note: `Одиночного БП не хватает — ставим ${qty}×${max.power_w}Вт параллельно.` };
}

// ============================================================
// 7. Электрика: нагрузка на линию
// ============================================================

/**
 * Ток и предупреждения по нагрузке.
 * Для 220В однофазного трека — макс. 10А (2 кВт) на линию по рекомендации, 16А по паспорту.
 * Для 48В магнитного — макс. 10А на выход БП.
 */
export function calcLineLoad({ totalPowerW, voltage_v, linesCount = 1 }) {
  const powerPerLine = totalPowerW / Math.max(1, linesCount);
  const currentPerLine = powerPerLine / voltage_v;
  const totalCurrent = totalPowerW / voltage_v;

  const limits = {
    220: { recommended: 10, absolute: 16, unit: 'А' },
    48:  { recommended: 10, absolute: 10, unit: 'А' },
    24:  { recommended: 8,  absolute: 10, unit: 'А' },
    12:  { recommended: 8,  absolute: 10, unit: 'А' },
  };
  const lim = limits[voltage_v] || limits[220];

  return {
    voltage_v,
    total_current_a: round(totalCurrent, 2),
    current_per_line_a: round(currentPerLine, 2),
    power_per_line_w: round(powerPerLine, 0),
    limit_recommended: lim.recommended,
    limit_absolute: lim.absolute,
    lines_count: linesCount,
    over_recommended: currentPerLine > lim.recommended,
    over_absolute: currentPerLine > lim.absolute,
  };
}

// ============================================================
// 8. Оркестратор: полный расчёт по проекту
// ============================================================

/**
 * Основная функция: принимает вход конфигуратора, возвращает полный BOM с ценой.
 * @param {Object} project — проект пользователя
 * @param {Object} db      — { catalog, norms, presets }
 */
export function computeProject(project, db) {
  const { catalog, norms } = db;

  // 1. Геометрия
  const totalArea = project.room.length * project.room.width;
  const roomIdx = roomIndex(project.room);
  const eta = pickUsageEta(roomIdx, norms.usage_coeff_eta);

  // Резервное значение для неизвестной группы; каждая зона ниже получает свой k.
  const firstZone = norms.zones.find(z => z.id === project.zones[0]?.zone_id);
  const groupKey = firstZone?.group || 'residential';
  const k = norms.safety_factor_k[groupKey] || 1.3;

  // 2. Требуемый поток по зонам
  const lumensCalc = requiredLumensTotal({
    zones: project.zones,
    totalArea,
    k,
    eta,
    normsZones: norms.zones,
    safetyFactors: norms.safety_factor_k,
  });

  // 3. Подбор светильников на каждую зону
  const luminaireSelections = [];
  for (const [zoneIndex, z] of project.zones.entries()) {
    const normZone = norms.zones.find(nz => nz.id === z.zone_id);
    if (!normZone) continue;
    const zoneLumens = lumensCalc.perZone.find(pz => pz.zone_index === zoneIndex)?.lumens || 0;
    const pick = pickLuminaireForZone({
      zoneRequirements: {
        lumens: zoneLumens,
        cct_k: z.cct_k || normZone.cct_k?.[0],
        beam_deg: normZone.beam_deg,
        cri_min: normZone.cri_min,
      },
      catalog,
      system: project.system,
      options: { minQty: 2, maxQty: 30 },
    });
    if (pick) {
      luminaireSelections.push({
        zone: normZone,
        zone_index: zoneIndex,
        ...pick,
        subtotal_price: (pick.luminaire.price_rub || 0) * pick.qty,
        subtotal_power_w: (pick.luminaire.power_w || 0) * pick.qty,
      });
    }
  }

  const totalLuminairesPower = luminaireSelections.reduce((s, l) => s + l.subtotal_power_w, 0);
  const totalLuminairesPrice = luminaireSelections.reduce((s, l) => s + l.subtotal_price, 0);
  const totalLuminairesQty = luminaireSelections.reduce((s, l) => s + l.qty, 0);

  // 4. Длина трека
  const layout = project.layout || 'line_center';
  // При нескольких зонах длина суммируется по каждой зоне (разводка внутри зон).
  const trackLenM = calcTrackLengthZones(layout, project.room, project.zones);
  const shinoprovod = pickShinoprovod({
    lengthM: trackLenM,
    catalog,
    voltage_v: project.system.voltage_v,
    color: project.system.color || 'black',
    mount: project.system.mount || 'nakladnoi',
  });

  // 5. Коннекторы
  const trackSegments = shinoprovod.items.reduce((s, i) => s + i.qty, 0);
  const connectors = pickConnectors({
    layout,
    trackSegments,
    catalog,
    voltage_v: project.system.voltage_v,
    feeds: feedCount(project.system),
  });

  // 6. Блок питания (для низковольтных)
  const psu = pickPowerSupply({
    totalPowerW: totalLuminairesPower,
    catalog,
    voltage_v: project.system.voltage_v,
  });
  const psuPrice = psu && psu.product ? psu.product.price_rub * psu.qty : 0;

  // 7. Электрика
  const load = calcLineLoad({
    totalPowerW: totalLuminairesPower,
    voltage_v: project.system.voltage_v,
    linesCount: countLines(layout),
  });

  // 8. Итоговая цена
  const grand_total = totalLuminairesPrice + shinoprovod.total_price + connectors.total_price + psuPrice;
  const safetyValues = [...new Set(lumensCalc.perZone.map(zone => zone.k_safety))];

  return {
    geometry: {
      area_m2: round(totalArea, 2),
      room_index: round(roomIdx, 2),
      eta,
      k_safety: safetyValues.length === 1 ? safetyValues[0] : k,
      k_safety_values: safetyValues,
    },
    lumens: lumensCalc,
    luminaires: luminaireSelections,
    totals_luminaires: {
      qty: totalLuminairesQty,
      power_w: round(totalLuminairesPower, 1),
      price_rub: totalLuminairesPrice,
    },
    track: {
      layout,
      required_length_m: round(trackLenM, 2),
      actual_length_m: round(shinoprovod.total_length, 2),
      segments: shinoprovod.items,
      price_rub: shinoprovod.total_price,
    },
    connectors,
    power_supply: {
      voltage_v: project.system.voltage_v,
      required_w: psu?.required_w || 0,
      product: psu?.product || null,
      qty: psu?.qty || 0,
      price_rub: psuPrice,
      note: psu?.note || null,
    },
    electrical: load,
    grand_total_rub: grand_total,
  };
}

// ============================================================
// 9. Пересчёт из редактируемой сцены (для drag-and-drop редактора)
// ============================================================

/**
 * Пересчитывает спецификацию/цену/электрику исходя из ФАКТИЧЕСКОЙ сцены
 * (после ручных правок дизайнера), а не из авто-подбора.
 *
 * Отличия от computeProject:
 *   - количество светильников — считаем из scene.luminaires (по slug)
 *   - длина трека — суммируем реальную длину полилиний scene.tracks
 *   - подбор шинопровода/коннекторов/БП — как раньше, но по этим числам
 *
 * @param {Object} project — оригинальный project (для параметров системы)
 * @param {Object} scene   — редактируемая сцена
 * @param {Object} db      — {catalog, norms, presets}
 */
export function computeFromScene(project, scene, db) {
  const { catalog, norms } = db;

  // 1. Геометрия
  const totalArea = project.room.length * project.room.width;
  const roomIdx = roomIndex(project.room);
  const eta = pickUsageEta(roomIdx, norms.usage_coeff_eta);
  // Резервное значение для неизвестной группы; каждая зона ниже получает свой k.
  const firstZone = norms.zones.find(z => z.id === project.zones[0]?.zone_id);
  const groupKey = firstZone?.group || 'residential';
  const k = norms.safety_factor_k[groupKey] || 1.3;

  // 2. Требуемый поток (справочно — по нормативу для сравнения)
  const lumensCalc = requiredLumensTotal({
    zones: project.zones,
    totalArea, k, eta,
    normsZones: norms.zones,
    safetyFactors: norms.safety_factor_k,
  });

  // 3. Группируем светильники сцены по slug
  const bySlug = new Map();
  const unknownSlugs = new Set();
  const invalidRoleSlugs = new Set();
  for (const lum of scene.luminaires) {
    const cat = catalog.find(p => p.slug === lum.slug);
    if (!cat) { unknownSlugs.add(lum.slug); continue; }
    if (cat.role !== 'luminaire' && cat.role !== 'downlight_luminaire') {
      invalidRoleSlugs.add(lum.slug);
      continue;
    }
    const cur = bySlug.get(lum.slug) || { luminaire: cat, qty: 0 };
    cur.qty += 1;
    bySlug.set(lum.slug, cur);
  }
  const luminaireSelections = [];
  let actualLumens = 0;
  for (const [, entry] of bySlug) {
    const subtotal_price = (entry.luminaire.price_rub || 0) * entry.qty;
    const subtotal_power_w = (entry.luminaire.power_w || 0) * entry.qty;
    luminaireSelections.push({
      luminaire: entry.luminaire,
      qty: entry.qty,
      actualLumens: (entry.luminaire.lumen || 0) * entry.qty,
      subtotal_price,
      subtotal_power_w,
      // «зону» тут не привязываем — считаем по всей сцене суммарно
      zone: { id: 'scene', name: 'Согласно расстановке', lux: 0 },
    });
    actualLumens += (entry.luminaire.lumen || 0) * entry.qty;
  }

  const totalLuminairesPower = luminaireSelections.reduce((s, l) => s + l.subtotal_power_w, 0);
  const totalLuminairesPrice = luminaireSelections.reduce((s, l) => s + l.subtotal_price, 0);
  const totalLuminairesQty = luminaireSelections.reduce((s, l) => s + l.qty, 0);

  // 4. Реальная длина трека — суммируем полилинии сцены
  const actualTrackLen = scene.tracks.reduce((s, t) => s + polylineLen(t.points), 0);
  const shinoprovod = pickShinoprovod({
    lengthM: actualTrackLen,
    catalog,
    voltage_v: project.system.voltage_v,
    color: project.system.color || 'black',
    mount: project.system.mount || 'nakladnoi',
  });

  // 5. Коннекторы: 1 токоподвод на трек + углы (по точкам полилиний)
  const trackSegments = shinoprovod.items.reduce((s, i) => s + i.qty, 0);
  const cornersTotal = scene.tracks.reduce((s, t) => s + Math.max(0, t.points.length - 2), 0);
  const connectors = pickConnectorsFromScene({
    tracksCount: scene.tracks.length,
    cornersTotal,
    trackSegments,
    catalog,
    voltage_v: project.system.voltage_v,
    feeds: feedCount(project.system),
  });

  // 6. Блок питания
  const psu = pickPowerSupply({
    totalPowerW: totalLuminairesPower,
    catalog,
    voltage_v: project.system.voltage_v,
  });
  const psuPrice = psu && psu.product ? psu.product.price_rub * psu.qty : 0;

  // 7. Электрика (по числу треков считаем линии — MVP)
  const load = calcLineLoad({
    totalPowerW: totalLuminairesPower,
    voltage_v: project.system.voltage_v,
    linesCount: Math.max(1, scene.tracks.length),
  });

  const grand_total = totalLuminairesPrice + shinoprovod.total_price + connectors.total_price + psuPrice;

  // 8. Машинная проверка целостности финального результата.
  const voltageMismatchSlugs = luminaireSelections
    .filter(item => item.luminaire.voltage_v && item.luminaire.voltage_v !== project.system.voltage_v)
    .map(item => item.luminaire.slug);
  const selectedProducts = [
    ...luminaireSelections.map(item => item.luminaire),
    ...shinoprovod.items.map(item => item.product),
    ...connectors.items.map(item => item.product),
    ...(psu?.product ? [psu.product] : []),
  ];
  const outOfStockSlugs = [...new Set(selectedProducts
    .filter(product => product.in_stock === false)
    .map(product => product.slug))];
  const trackCovered = shinoprovod.total_length + 1e-9 >= actualTrackLen;
  const quantitiesMatch = totalLuminairesQty === scene.luminaires.length;
  const sceneFinite = scene.luminaires.every(lum =>
    [lum.x, lum.y, lum.angle_deg ?? 90].every(Number.isFinite)) &&
    scene.tracks.every(track => Array.isArray(track.points) && track.points.every(point =>
      Number.isFinite(point.x) && Number.isFinite(point.y)));
  const trackIds = new Set(scene.tracks.map(track => track.id));
  const trackRefsValid = scene.luminaires.every(lum =>
    !lum.on_track_id || trackIds.has(lum.on_track_id));
  const hasUsableTrack = totalLuminairesQty === 0 || scene.tracks.some(track =>
    Array.isArray(track.points) && track.points.length >= 2 && polylineLen(track.points) > 1e-6);
  const lowVoltageSystem = [12, 24, 48].includes(project.system.voltage_v);
  const psuCapacity = psu?.product ? (psu.product.power_w || 0) * (psu.qty || 0) : 0;
  const psuCovered = !lowVoltageSystem || totalLuminairesPower <= 0 ||
    (!!psu?.product && psuCapacity >= (psu.required_w || 0));
  const feedQty = connectors.items
    .filter(item => item.purpose?.includes('токоподвод'))
    .reduce((sum, item) => sum + item.qty, 0);
  const feedsCovered = scene.tracks.length === 0 || feedQty >= scene.tracks.length;
  const componentTotals = [
    totalLuminairesPrice,
    shinoprovod.total_price,
    connectors.total_price,
    psuPrice,
  ];
  const componentSum = componentTotals.reduce((sum, value) => sum + value, 0);
  const totalFinite = [
    grand_total, componentSum, actualTrackLen, shinoprovod.total_length,
    totalLuminairesPower, actualLumens, ...componentTotals,
  ].every(value => Number.isFinite(value) && value >= 0);
  const componentSumMatches = totalFinite && Math.abs(componentSum - grand_total) < 0.01;
  const integrity = {
    valid: unknownSlugs.size === 0 && invalidRoleSlugs.size === 0 &&
           voltageMismatchSlugs.length === 0 && outOfStockSlugs.length === 0 &&
           trackCovered && psuCovered && feedsCovered && quantitiesMatch &&
           sceneFinite && trackRefsValid && hasUsableTrack &&
           totalFinite && componentSumMatches,
    scene_luminaires: scene.luminaires.length,
    calculated_luminaires: totalLuminairesQty,
    scene_tracks: scene.tracks.length,
    unknown_slugs: [...unknownSlugs],
    invalid_role_slugs: [...invalidRoleSlugs],
    voltage_mismatch_slugs: voltageMismatchSlugs,
    out_of_stock_slugs: outOfStockSlugs,
    track_covered: trackCovered,
    psu_covered: psuCovered,
    feeds_covered: feedsCovered,
    scene_finite: sceneFinite,
    track_refs_valid: trackRefsValid,
    has_usable_track: hasUsableTrack,
    total_finite: totalFinite,
    component_sum_matches: componentSumMatches,
    component_sum_rub: componentSum,
  };

  // Разница «расчёт vs факт» — для вывода в интерфейс
  const lumensDelta = actualLumens - lumensCalc.totalLumens;
  const lumensDeltaPct = lumensCalc.totalLumens > 0
    ? Math.round((actualLumens / lumensCalc.totalLumens - 1) * 100)
    : 0;

  const safetyValues = [...new Set(lumensCalc.perZone.map(zone => zone.k_safety))];

  return {
    geometry: {
      area_m2: round(totalArea, 2),
      room_index: round(roomIdx, 2),
      eta,
      k_safety: safetyValues.length === 1 ? safetyValues[0] : k,
      k_safety_values: safetyValues,
    },
    lumens: {
      ...lumensCalc,
      actual: actualLumens,
      delta: lumensDelta,
      deltaPct: lumensDeltaPct,
    },
    luminaires: luminaireSelections,
    totals_luminaires: {
      qty: totalLuminairesQty,
      power_w: round(totalLuminairesPower, 1),
      price_rub: totalLuminairesPrice,
    },
    track: {
      layout: project.layout,
      required_length_m: round(actualTrackLen, 2),
      actual_length_m: round(shinoprovod.total_length, 2),
      segments: shinoprovod.items,
      price_rub: shinoprovod.total_price,
      tracks_count: scene.tracks.length,
    },
    connectors,
    power_supply: {
      voltage_v: project.system.voltage_v,
      required_w: psu?.required_w || 0,
      product: psu?.product || null,
      qty: psu?.qty || 0,
      price_rub: psuPrice,
      note: psu?.note || null,
    },
    electrical: load,
    grand_total_rub: grand_total,
    integrity,
    from_scene: true,   // маркер — «расчёт из сцены»
  };
}

function polylineLen(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return s;
}

function pickConnectorsFromScene({ tracksCount, cornersTotal, trackSegments, catalog, voltage_v, feeds = null }) {
  const cons = catalog.filter(p =>
    p.role === 'connector' && p.in_stock !== false &&
    (!p.voltage_v || p.voltage_v === voltage_v));
  const findByHint = (hint) => cons.find(c => c.name.toLowerCase().includes(hint));
  const feed = findByHint('коннектор') || cons.find(c => c.name.toLowerCase().includes('токоподв')) || cons[0];
  const straight = findByHint('прямой');
  const corner = findByHint('углов');

  const items = [];
  // feeds: null/auto → 1 токоподвод на трек; явное число → как выбрал пользователь.
  const feedQty = (typeof feeds === 'number' && Number.isFinite(feeds))
    ? clampInt(feeds, 0, 12)
    : tracksCount;
  if (feed && tracksCount > 0 && feedQty > 0) {
    items.push({ product: feed, qty: feedQty, purpose: `токоподводы (${feedQty} шт)` });
  }
  if (corner && cornersTotal > 0) {
    items.push({ product: corner, qty: cornersTotal, purpose: 'углы в треках' });
  }
  const straightQty = Math.max(0, trackSegments - tracksCount - cornersTotal);
  if (straight && straightQty > 0) {
    items.push({ product: straight, qty: straightQty, purpose: 'стыки секций' });
  }
  const total_price = items.reduce((s, i) => s + (i.product.price_rub || 0) * i.qty, 0);
  return { items, total_price };
}

function countLines(layout) {
  return {
    line_center: 1, line_mirror: 1,
    L_shape: 1, U_shape: 1,
    perimeter_partial: 1,
    parallel_lines: 2, parallel_lines_walls: 2,
    custom: 1,
  }[layout] || 1;
}

// ============================================================
// Утилиты
// ============================================================

function round(n, digits = 0) {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

function clampInt(n, min, max) {
  const v = Number.parseInt(n, 10);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

export const _internal = { round, matchesMount, countLines, clampInt, feedCount, calcTrackLengthZones };
