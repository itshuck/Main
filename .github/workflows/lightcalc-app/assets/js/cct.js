/**
 * cct.js — справочник цветовой температуры (Correlated Color Temperature).
 *
 * Единый источник правды для UI, визуализации и валидаторов.
 * Значения соответствуют популярной шкале LED-освещения:
 *   2700 K — "extra warm" (лампа накаливания)
 *   3000 K — "warm white"
 *   4000 K — "neutral / cool white"
 *   6000 K — "daylight"
 *   6500 K — "cool daylight"
 *
 * Каждая запись:
 *   K            — Кельвины (число)
 *   label        — русская подпись для UI
 *   short        — короткое обозначение "2700K"
 *   description  — атмосфера/применение
 *   emitColor    — HEX цвета световой заливки на плане (пятно света)
 *   glowColor    — HEX ядра пятна (центр)
 *   textColor    — цвет чипа-бейджа в UI
 */

export const CCT_LIST = [
  {
    K: 2700,
    label: 'Тёпло-жёлтый',
    short: '2700K',
    description: 'Атмосфера свечей, лампа накаливания. Гостиные, спальни, HoReCa.',
    emitColor: '#FFB25A',   // насыщенно-янтарный
    glowColor: '#FFDDA8',
    textColor: '#B76D2C',
  },
  {
    K: 3000,
    label: 'Тёплый белый',
    short: '3000K',
    description: 'Уютный тёплый свет. Жилые комнаты, кухни-гостиные, рестораны.',
    emitColor: '#FFCC8A',
    glowColor: '#FFE9C7',
    textColor: '#C89050',
  },
  {
    K: 4000,
    label: 'Нейтральный белый',
    short: '4000K',
    description: 'Естественный свет. Офисы, кухни, санузлы, коридоры.',
    emitColor: '#FFF3D4',
    glowColor: '#FFFCEC',
    textColor: '#8A7A50',
  },
  {
    K: 6000,
    label: 'Дневной',
    short: '6000K',
    description: 'Холодный дневной свет. Магазины, витрины, рабочие зоны.',
    emitColor: '#E4EEFF',
    glowColor: '#F0F6FF',
    textColor: '#5A7BB0',
  },
  {
    K: 6500,
    label: 'Холодный дневной',
    short: '6500K',
    description: 'Ярко-белый холодный свет. Медицина, точная работа, производство.',
    emitColor: '#D6E7FF',
    glowColor: '#E5F0FF',
    textColor: '#4A6FA5',
  },
];

/** Найти запись по значению K (с ближайшим сопоставлением) */
export function getCCT(kelvin) {
  if (!kelvin) return CCT_LIST[1];  // default: 3000K
  // Точное совпадение
  const exact = CCT_LIST.find(c => c.K === kelvin);
  if (exact) return exact;
  // Ближайшее
  let best = CCT_LIST[0], bestDiff = Math.abs(best.K - kelvin);
  for (const c of CCT_LIST) {
    const d = Math.abs(c.K - kelvin);
    if (d < bestDiff) { best = c; bestDiff = d; }
  }
  return best;
}

/**
 * Тип светильника → характеристики визуализации пятна света.
 *
 * Ключевое различие двух семейств:
 *   ★ LINEAR (Liner)       — светильник ДЛИННЫЙ, свет идёт вдоль оси трека,
 *                            форма пятна — сильно ВЫТЯНУТАЯ (эллипс/прямоугольник)
 *   ★ SPOT / DOWNLIGHT     — светильник компактный, пятно КРУГЛОЕ
 *
 * Ключевое различие оптики:
 *   ★ LENS   — линза, строго направленный пучок (чёткие края, малое рассеивание)
 *   ★ MATTE  — рассеиватель, мягкий равномерный свет (плавные края, большое рассеивание)
 *   ★ FOLD   — линза-«гармошка», средняя жёсткость, часто асимметричная
 *
 * Параметры визуализации:
 *   shape       — 'ellipse' | 'rect'   (форма SVG-примитива на плане)
 *   elongation  — вытягивание вдоль оси трека (1 = круг/квадрат, 3 = 3× длиннее)
 *   softness    — мягкость краёв [0..1]: 0.20 чёткий → 0.85 очень мягкий
 *   intensity   — яркость центра [0..1]
 *   directional — true если светильник поворачивается (spot), false если направление
 *                 фиксировано осью трека (linear)
 */
export const BEAM_SHAPES = {
  spot:              { shape: 'ellipse', elongation: 1.0, softness: 0.30, intensity: 0.60, directional: true,  label: 'Точечный (спот)' },
  spot_gu10:         { shape: 'ellipse', elongation: 1.0, softness: 0.32, intensity: 0.58, directional: true,  label: 'Спот под GU10' },
  spot_gx53:         { shape: 'ellipse', elongation: 1.0, softness: 0.60, intensity: 0.42, directional: true,  label: 'Таблетка GX53' },
  spot_lens:         { shape: 'ellipse', elongation: 1.0, softness: 0.22, intensity: 0.68, directional: true,  label: 'Спот с линзой (Lens)' },
  linear_lens:       { shape: 'ellipse', elongation: 2.6, softness: 0.28, intensity: 0.58, directional: false, label: 'Линейный + линза (LensLine)' },
  linear_lens_narrow:{ shape: 'ellipse', elongation: 3.2, softness: 0.22, intensity: 0.62, directional: false, label: 'Линейный узкий пучок' },
  linear_matte:      { shape: 'rect',    elongation: 3.0, softness: 0.85, intensity: 0.30, directional: false, label: 'Линейный рассеиватель (MattLine)' },
  linear_fold:       { shape: 'ellipse', elongation: 2.2, softness: 0.45, intensity: 0.48, directional: false, label: 'Линейный + гармошка (LensFold)' },
  downlight:         { shape: 'ellipse', elongation: 1.0, softness: 0.75, intensity: 0.38, directional: false, label: 'Даунлайт (рассеянный вниз)' },
  // Встраиваемый светильник НАПРАВЛЕННОГО света (линза/спот), но НЕ поворотный —
  // свет идёт строго вниз, без наклона и вращения корпуса.
  downlight_lens:    { shape: 'ellipse', elongation: 1.0, softness: 0.26, intensity: 0.66, directional: false, label: 'Встраиваемый направленный (вниз)' },
  unknown:           { shape: 'ellipse', elongation: 1.0, softness: 0.55, intensity: 0.45, directional: true,  label: '—' },
};

export function getBeamShape(type) {
  return BEAM_SHAPES[type] || BEAM_SHAPES.unknown;
}

/**
 * Управляемые пользователем «типы света» для светильников в Редакторе плана.
 * Позволяют переопределить тип лампы/пучка независимо от модели каталога:
 *   - rasseivayushchiy  → рассеивающий (широкий мягкий пучок)
 *   - napravlennyy      → направленный (вниз/вдоль трека, узкий)
 *   - fokus_lens        → фокус-линза (очень узкий акцентный луч)
 *   - povorotnyy        → поворотный (спот, можно наклонять/вращать)
 *   - staticheskiy      → статический (фиксированная ориентация)
 * Каждый пункт маппится на конкретный тип пучка из BEAM_SHAPES.
 */
export const LIGHT_TYPE_OPTIONS = [
  { id: 'rasseivayushchiy', label: 'Рассеивающий', icon: '◎',
    beamType: 'downlight',  desc: 'Широкий мягкий рассеянный свет (для общего фона)' },
  { id: 'napravlennyy',     label: 'Направленный', icon: '◉',
    beamType: 'downlight_lens', desc: 'Узкий направленный пучок строго вниз' },
  { id: 'fokus_lens',       label: 'Фокус-линза', icon: '✺',
    beamType: 'spot_lens',  desc: 'Очень узкий акцентный луч (картины, витрины)' },
  { id: 'povorotnyy',       label: 'Поворотный', icon: '↻',
    beamType: 'spot',       desc: 'Поворотный спот — можно наклонять и вращать' },
  { id: 'staticheskiy',     label: 'Статический', icon: '▪',
    beamType: 'linear_fold', desc: 'Фиксированная ориентация без наклона' },
];

export function getLightTypeOption(id) {
  return LIGHT_TYPE_OPTIONS.find(o => o.id === id) || null;
}

/**
 * Определяет итоговый тип пучка для отрисовки/расчёта светильника,
 * учитывая пользовательский override (lightType), иначе — модель каталога.
 */
export function resolveBeamType(product, lightType = null) {
  if (lightType) {
    const opt = getLightTypeOption(lightType);
    if (opt) return opt.beamType;
  }
  return inferLuminaireType(product);
}

/**
 * Классификация типа по имени/тегам/раскладке в CMS.
 *
 * Порядок эвристик:
 *  1. Явный product.type из TECH_HINTS
 *  2. Ключевые слова серии в имени/slug — самое точное
 *  3. Цоколь (GU10 → spot_gu10, GX53 → spot_gx53) для 220В под лампу
 *  4. Слова "linear/liner" + "lens/matte/fold"
 *  5. Общий fallback: spot
 */
export function inferLuminaireType(product) {
  // === Встроенные светильники: направленный свет вниз, НЕ поворотный спот ===
  // Если в характеристиках/описании/параметрах светильника НЕ указан поворот
  // (гориз. по вертикали/горизонтали), то это фиксированный свет только вниз.
  // Такие модели НЕ должны вращаться (нет ручки поворота, нет наклона, нет смещения пятна).
  // Если же поворот ЯВНО указан (>0) — это поворотная модель, уважаем её.
  if (product.role === 'downlight_luminaire' && !_hasExplicitRotation(product)) {
    // Узкий направленный пучок (линза / спот / малый угол) — фиксированный вниз;
    // широкий (>55°) — рассеянный даунлайт. В обоих случаях свет ТОЛЬКО ВНИЗ.
    const narrow = (product.beam_deg != null && product.beam_deg <= 55)
                   || /lens|spot|\bлинз/i.test((product.name || '') + ' ' + (product.slug || ''));
    return narrow ? 'downlight_lens' : 'downlight';
  }

  if (product.type && BEAM_SHAPES[product.type]) return product.type;
  const n = (product.name || '').toLowerCase();
  const s = (product.slug || '').toLowerCase();
  const full = n + ' ' + s;

  // === Приоритет 5.2: встраиваемые без явного поворота — фиксированная вниз ===
  if (product.role === 'downlight_luminaire') {
    return 'downlight';
  }

  // === Приоритет 1: специфичные серии производителя ===
  if (full.includes('lensline') || full.includes('lens line')) return 'linear_lens';
  if (full.includes('mattline') || full.includes('matteline') || full.includes('matt line')) return 'linear_matte';
  if (full.includes('lensfold') || full.includes('fold')) return 'linear_fold';

  // === Приоритет 2: "Liner" — линейный корпус ===
  // Если в имени есть слово "liner" — это линейный светильник.
  // Дальше уточняем оптику: Lens vs Matte
  if (/\bliner\b/i.test(full)) {
    if (/\blens\b/i.test(full)) return 'linear_lens';
    if (/\bmatte?\b/i.test(full) || full.includes('rasseiv')) return 'linear_matte';
    return 'linear_lens';   // Liner без указания оптики — по умолчанию линза (характернее для zima-led)
  }

  // === Приоритет 3: точечные с указанной оптикой ===
  if (/\blens\b/i.test(full) && !/\bliner\b/i.test(full)) return 'spot_lens';

  // === Приоритет 4: по цоколю (для 220В под лампу) ===
  if (full.includes('gu10')) return 'spot_gu10';
  if (full.includes('gx53')) return 'spot_gx53';
  if (full.includes('mr16')) return 'spot';

  // === Приоритет 5: downlight / встраиваемые ===
  if (full.includes('downlight') || full.includes('даунлайт')) return 'downlight';
  if (product.role === 'downlight_luminaire') return 'downlight';

  return 'spot';
}

/**
 * Явно ли указан поворот (гориз./верт.) в данных, описании или параметрах товара.
 * Если НЕ указан — встраиваемый светильник направленного света считается
 * фиксированным (свет только вниз, без вращения).
 */
export function _hasExplicitRotation(product) {
  const h = product.rot_h_deg;
  const v = product.rot_v_deg;
  if (h != null && h > 0) return true;
  if (v != null && v > 0) return true;
  // Ручным эвристикам доверяем только при явных числовых данных из CMS.
  const text = ((product.description || '') + ' ' +
    (product.raw_properties ? JSON.stringify(product.raw_properties) : '')).toLowerCase();
  return /\bповорот|\bвращ|\bнаклон|регулируем|\btil[st]?\b|-?\d+\s*(?:°|град)\s*(?:поворот|вращ|наклон)/i.test(text);
}

/**
 * Ограничения поворота светильника (для UI-редактора).
 * Читаются из raw_properties['Поворот H'/'Поворот V'] через catalog-loader.
 * Возвращает { canRotateH, canRotateV, maxH, maxV }.
 */
export function getRotationLimits(product) {
  const hMax = product.rot_h_deg;   // null если данных нет
  const vMax = product.rot_v_deg;
  const type = inferLuminaireType(product);
  const shape = BEAM_SHAPES[type] || BEAM_SHAPES.unknown;

  // Для встраиваемых направленного света без явного поворота — жёстко 0/0
  // (свет только вниз). Иначе — эвристика по типу.
  const isFixedRecessed = product.role === 'downlight_luminaire' && !_hasExplicitRotation(product);

  const defaultH = isFixedRecessed ? 0 : (shape.directional ? 350 : 0);
  const defaultV = isFixedRecessed ? 0 : (shape.directional ? 90 : 0);

  const maxH = isFixedRecessed ? 0 : (hMax != null ? hMax : defaultH);
  const maxV = isFixedRecessed ? 0 : (vMax != null ? vMax : defaultV);

  return {
    canRotateH: maxH > 0,
    canRotateV: maxV > 0,
    maxH,          // 350° = почти полный оборот; 180° = полукруг; 0° = не поворачивается
    maxV,          // 90° = наклон вверх/вниз; 0° = только направление трека
    // Диапазон допустимых углов на плане (относительно оси трека),
    // если maxH=350 → от -175° до +175° от оси трека
    // если maxH=180 → от -90° до +90°
    // если maxH=0   → только 0° (вдоль трека)
  };
}
