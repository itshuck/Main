/**
 * catalog-loader.js — АВТОМАТИЧЕСКАЯ подгрузка каталога товаров ZimaLED
 * прямо из живого CMS-файла `/cart/x5cart.js` (WebSite X5 e-commerce).
 *
 * Зачем: сайт zima-led.ru при добавлении товара АВТОМАТИЧЕСКИ обновляет
 * файл /cart/x5cart.js. Значит калькулятор всегда видит актуальный каталог
 * без ручных перезаливов JSON.
 *
 * Как работает:
 *   1) Fetch /cart/x5cart.js (это огромный var x5CartData = {...};)
 *   2) Запускаем его в изолированном контексте (без сети), получаем объект
 *   3) Обходим x5CartData.products, фильтруем по нужным категориям
 *   4) Обогащаем тех-параметрами (lumen/beam_deg/cri/type) из справочника
 *   5) Возвращаем массив в том же формате, что раньше давал scrape_zima.py
 *
 * Fallback: если /cart/x5cart.js недоступен — грузим статический catalog.json
 * (аварийная копия), чтобы приложение точно запустилось.
 */

// ============================================================
// Категории, которые нам нужны (из фильтра каталога zima-led)
// ============================================================
export const NEEDED_CATEGORY_IDS = new Set([
  '6q44yija', // Встраиваемые светильники
  'z6gng9e2', // Трековое освещение
  'o808i1hf', // Трансформаторы 48V трековых систем
  'xwhs9b7n', // Шинопроводы на 48V трековых магнитных светильников
  'wuhfprra', // Комплектующие на 48V трековых магнитных светильников
  'z6a6y1t0', // Светильники трековые магнитные под лампу 220 вольт
  '8udpb3be', // Светодиодные низковольтные трековые магнитные светильники
  '4ankhg6e', // Светильники точечные под лампу
  'c8qr5as9', // Блоки питания (общая категория)
]);

// Явные названия категорий — на случай если сайт добавит новые ID в те же логические группы
// (fallback classification по названию)
export const CATEGORY_NAME_KEYWORDS = [
  { kw: ['блок питан', 'драйвер', 'трансформатор'], role: 'power_supply', vp: null },
  { kw: ['шинопровод'], role: 'track_system', vp: 48 },
  { kw: ['трековое', 'трековые', 'трековый', 'магнитн'], role: 'track_system', vp: null },
  { kw: ['встраиваем'], role: 'downlight', vp: null },
  { kw: ['точечн'], role: 'downlight', vp: null },
  { kw: ['коннектор', 'соединитель', 'токоподвод'], role: 'track_system', vp: 48 },
  { kw: ['лента'], role: 'led_strip', vp: null },
];

// ============================================================
// TECH_HINTS — параметры, которых нет в x5cart.js (лм, угол, CRI, тип пятна)
// Значения выверены по datasheets Feron и ZimaLED:
//   • MGN300/301 LensLine/LensFold — 720lm @ 12W, асимметричный пучок 60°×30°
//   • MGN302 MattLine — 1440lm @ 18W, ШИРОКИЙ 110° (матовый рассеиватель)
//   • MGN303 spot — 800lm @ 10W, УЗКИЙ 24° (акцент, линза-фокус)
//   • MGN304 spot — 1600lm @ 20W, 36° (акцент средний)
//   • MGN305 — 800lm @ 10W, 90° (даунлайт)
//   • AL302 MattLine — 1440lm @ 18W, 110°
//   • AL116/AL119, SLIM 1003/1013 — БЕЗ собственных LED, светят через лампу.
//     Задан lamp_ref = типовая рекомендуемая LED-лампа (не max).
// ============================================================
export const TECH_HINTS = {
  // === Feron MGN 48V (низковольтные магнитные) ===
  // LensLine — линейный + линза с АСИММЕТРИЧНЫМ пучком (60° вдоль корпуса × 30° поперёк)
  'track-light-feron-mgn300-3000k-lensline':     { lumen: 720,  beam_deg: 60, beam_deg_cross: 30, cri: 90, type: 'linear_lens' },
  'track-light-feron-mgn300-lensline-white':     { lumen: 720,  beam_deg: 60, beam_deg_cross: 30, cri: 90, type: 'linear_lens' },
  'track-light-feron-mgn300-lensline-black':     { lumen: 720,  beam_deg: 60, beam_deg_cross: 30, cri: 90, type: 'linear_lens' },
  'track-light-feron-mgn300-lensline-black-18w': { lumen: 1200, beam_deg: 60, beam_deg_cross: 30, cri: 90, type: 'linear_lens' },
  // LensFold — линза-«гармошка», такой же пучок но со ступенчатой оптикой
  'track-ligth-feron-mgn301-lensfold-black':     { lumen: 720,  beam_deg: 60, beam_deg_cross: 30, cri: 90, type: 'linear_fold' },
  // MattLine — линейный МАТОВЫЙ рассеиватель, широкий равномерный пучок
  'track-light-feron-mgn302-matteline':          { lumen: 1440, beam_deg: 110, cri: 90, type: 'linear_matte' },
  // MGN303 — точечный spot с линзой-фокусом, УЗКИЙ пучок 24° (акцент)
  'track-light-feron-mgn303-3000k-black':        { lumen: 800,  beam_deg: 24, cri: 90, type: 'spot_lens' },
  'track-light-feron-mgn303':                    { lumen: 800,  beam_deg: 24, cri: 90, type: 'spot_lens' },
  'track-feron-mgn303-4000k-black':              { lumen: 1600, beam_deg: 24, cri: 90, type: 'spot_lens' },
  // MGN304 — spot покрупнее, 36°
  'track-feron-mgn304-4000k-black':              { lumen: 1600, beam_deg: 36, cri: 90, type: 'spot_lens' },
  // MGN305 — даунлайт (широкий круглый)
  'track-light-feron-mgn305':                    { lumen: 800,  beam_deg: 90, cri: 90, type: 'downlight' },
  // AL302 MattLine
  'track-light-feron-al302-mattline':            { lumen: 1440, beam_deg: 110, cri: 90, type: 'linear_matte' },

  // === 220В корпуса под лампу ===
  // Здесь lumen — это поток ТИПОВОЙ рекомендуемой LED-лампы (не max допустимая).
  // properties.Мощность в CMS = МАКС. допустимая мощность лампы, использовать её
  // для расчёта нагрузки некорректно (люди ставят LED, а не галоген).
  'svetilnik-feron-al116-trekovyi-magnitnyi-pod-lampu-gu10-230v-chernyi': {
    lumen: 500, beam_deg: 36, cri: 80, type: 'spot_gu10',
    lamp_ref: { power_w: 7, lumen: 500, beam_deg: 36, base: 'GU10' },
  },
  'svetilnik-feron-al116-trekovyi-magnitnyi-pod-lampu-gu10-230v-belii': {
    lumen: 500, beam_deg: 36, cri: 80, type: 'spot_gu10',
    lamp_ref: { power_w: 7, lumen: 500, beam_deg: 36, base: 'GU10' },
  },
  'svetilnik-feron-al119-trekovyi-magnitnyi-pod-lampu-gx53-230v-chernyi': {
    lumen: 700, beam_deg: 90, cri: 80, type: 'spot_gx53',
    lamp_ref: { power_w: 9, lumen: 700, beam_deg: 90, base: 'GX53' },
  },
  'svetilnik-feron-al119-trekovyi-magnitnyi-pod-lampu-gx53-230v-belii': {
    lumen: 700, beam_deg: 90, cri: 80, type: 'spot_gx53',
    lamp_ref: { power_w: 9, lumen: 700, beam_deg: 90, base: 'GX53' },
  },
  'track-svetilnik-black-1003-slim': {
    lumen: 500, beam_deg: 36, cri: 80, type: 'spot_gu10',
    lamp_ref: { power_w: 7, lumen: 500, beam_deg: 36, base: 'GU10' },
  },
  'track-svetilnik-black-1013-slim': {
    lumen: 500, beam_deg: 36, cri: 80, type: 'spot_gu10',
    lamp_ref: { power_w: 7, lumen: 500, beam_deg: 36, base: 'GU10' },
  },
  // Liner Lens 20w — интегрированный светильник со встроенной LED-линзой
  'track-liner-lens-20w-4000k-slim':             { lumen: 1800, beam_deg: 60, beam_deg_cross: 30, cri: 80, type: 'linear_lens' },
  'track-light-liner-2-lens-18w-slim':           { lumen: 1600, beam_deg: 60, beam_deg_cross: 30, cri: 80, type: 'linear_lens' },
};

// ============================================================
// SERIES_HINTS — fallback по серии если slug не в TECH_HINTS.
// Например у товара «мусорный» slug: --feron-mgn303--10w,-900-lm,-4000-,-35---
// парсер серии в detectSeries() найдёт 'MGN303' и подставит сюда.
// ============================================================
export const SERIES_HINTS = {
  'MGN300': { lumen: 720,  beam_deg: 60,  beam_deg_cross: 30, cri: 90, type: 'linear_lens' },
  'MGN301': { lumen: 720,  beam_deg: 60,  beam_deg_cross: 30, cri: 90, type: 'linear_fold' },
  'MGN302': { lumen: 1440, beam_deg: 110, cri: 90, type: 'linear_matte' },
  'MGN303': { lumen: 800,  beam_deg: 24,  cri: 90, type: 'spot_lens' },
  'MGN304': { lumen: 1600, beam_deg: 36,  cri: 90, type: 'spot_lens' },
  'MGN305': { lumen: 800,  beam_deg: 90,  cri: 90, type: 'downlight' },
  'AL116':  { lumen: 500,  beam_deg: 36,  cri: 80, type: 'spot_gu10', lamp_ref: { power_w: 7, lumen: 500, beam_deg: 36, base: 'GU10' } },
  'AL119':  { lumen: 700,  beam_deg: 90,  cri: 80, type: 'spot_gx53', lamp_ref: { power_w: 9, lumen: 700, beam_deg: 90, base: 'GX53' } },
  'AL302':  { lumen: 1440, beam_deg: 110, cri: 90, type: 'linear_matte' },
};

// ============================================================
// LAMP_DEFAULTS — типовые LED-лампы по цоколю.
// Используются для встраиваемых downlight-корпусов ZimaLED (1064/1517/2013)
// у которых нет собственных LED и tech_hints/series_hints пусты.
// ============================================================
export const LAMP_DEFAULTS = {
  'GU10':  { power_w: 7,  lumen: 500, beam_deg: 36, type_hint: 'spot_gu10' },   // акцент 36°
  'GX53':  { power_w: 9,  lumen: 700, beam_deg: 90, type_hint: 'spot_gx53' },   // "таблетка" широкая
  'GU5.3': { power_w: 5,  lumen: 400, beam_deg: 36, type_hint: 'spot' },        // MR16 12V
  'G5.3':  { power_w: 5,  lumen: 400, beam_deg: 36, type_hint: 'spot' },
  'MR16':  { power_w: 5,  lumen: 400, beam_deg: 36, type_hint: 'spot' },
  'MR11':  { power_w: 3,  lumen: 250, beam_deg: 30, type_hint: 'spot' },
  'E14':   { power_w: 5,  lumen: 400, beam_deg: 200, type_hint: 'downlight' },
  'E27':   { power_w: 9,  lumen: 800, beam_deg: 200, type_hint: 'downlight' },
};

// Соответствие «русский цвет из properties → английский код»
const CCT_FROM_PROP = {
  'тепл': 3000, 'теплый': 3000, 'теплый белый': 3000,
  'нейтральн': 4000, 'нейтральный': 4000, 'нейтральный белый': 4000,
  'холодн': 6000, 'холодный': 6000, 'холодный белый': 6000,
  'дневн': 5500,
};
const COLOR_FROM_PROP = {
  'белый': 'white', 'бел': 'white', 'white': 'white',
  'чёрный': 'black', 'черный': 'black', 'чёрн': 'black', 'черн': 'black', 'black': 'black',
  'белый / черный': 'white',   // берём первый
};

const CATALOG_URL_DEFAULT = 'https://zima-led.ru/cart/x5cart.js';

// ============================================================
// Публичный API
// ============================================================

/**
 * Загрузка каталога из живого x5cart.js.
 * @param {Object} opts { url, cacheKey, cacheMinutes, fallbackCatalog }
 * @returns {Promise<{products, source, generated_at, products_count, from_cache?, from_fallback?}>}
 */
export async function loadCatalogAuto(opts = {}) {
  const {
    url = CATALOG_URL_DEFAULT,
    cacheKey = 'zlc_catalog_v1',
    cacheMinutes = 60,       // держим кэш в localStorage 60 мин, чтобы не грузить 1МБ на каждый заход
    fallbackCatalog = null,  // {source, products: [...]} — статический fallback
  } = opts;

  // 1) Попытка из localStorage
  try {
    const raw = localStorage.getItem(cacheKey);
    if (raw) {
      const cached = JSON.parse(raw);
      const ageMin = (Date.now() - cached.ts) / 60000;
      if (ageMin < cacheMinutes && cached.data?.products?.length) {
        cached.data.from_cache = true;
        cached.data.cache_age_min = Math.round(ageMin);
        return cached.data;
      }
    }
  } catch {}

  // 2) Основной путь — fetch x5cart.js
  try {
    const doc = await fetchAndParseX5Cart(url);
    // Сохраним в кэш
    try {
      localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: doc }));
    } catch {}
    return doc;
  } catch (e) {
    console.warn('[catalog-loader] x5cart.js недоступен, используем fallback:', e.message);
    if (fallbackCatalog) {
      return { ...fallbackCatalog, from_fallback: true, error: e.message };
    }
    throw e;
  }
}

/**
 * Fetch + parse без кэша (для принудительного обновления).
 */
export async function reloadCatalog(opts = {}) {
  const cacheKey = opts.cacheKey || 'zlc_catalog_v1';
  try { localStorage.removeItem(cacheKey); } catch {}
  return loadCatalogAuto({ ...opts, cacheMinutes: 0 });
}

// ============================================================
// Внутренности
// ============================================================

async function fetchAndParseX5Cart(url) {
  const r = await fetch(url, { credentials: 'omit' });
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
  const jsText = await r.text();
  if (jsText.length < 10000) throw new Error(`x5cart.js слишком короткий (${jsText.length}b)`);

  // Извлекаем x5CartData. Файл x5cart.js после var-присваиваний содержит
  // вызовы x5engine.utils.location(...) и т.п. — они нам не нужны, но могут
  // выбросить ReferenceError. Стратегия:
  //   1) Даём заглушки для всех известных внешних символов;
  //   2) Оборачиваем всё в try/catch внутри — исключение НЕ прервёт извлечение;
  //   3) Возвращаем x5CartData даже если хвост упал.
  let x5CartData;
  try {
    const wrapper = `
      "use strict";
      var window = {}, document = { getElementById: function(){ return null; } };
      var x5engine = new Proxy(function(){}, {
        get: function() { return x5engine; },
        apply: function() { return x5engine; },
        construct: function() { return {}; }
      });
      var $ = x5engine, jQuery = x5engine, kendo = x5engine;
      var x5CartData = null;
      try { ${jsText} } catch(e) { /* игнорируем ошибки исполнения хвоста */ }
      return typeof x5CartData !== "undefined" ? x5CartData : null;
    `;
    const fn = new Function(wrapper);
    x5CartData = fn();
  } catch (e) {
    throw new Error('Не удалось распарсить x5cart.js: ' + e.message);
  }
  if (!x5CartData || !x5CartData.products) {
    throw new Error('x5cart.js не содержит поля products');
  }

  // Массив категорий (id → {name, parent})
  const catIndex = indexCategories(x5CartData.categories?.dataSource || []);

  // Обход products
  const products = [];
  const seen = new Set();
  for (const [key, raw] of Object.entries(x5CartData.products)) {
    // Некоторые ключи — сам объект (пример: x3cgfwrm: {...}), некоторые — вложенные dupes. Работаем с раскрытым объектом.
    if (!raw || typeof raw !== 'object') continue;
    if (!raw.id || !raw.name) continue;
    if (seen.has(raw.id)) continue;

    const cat = catIndex[raw.category];
    // Фильтруем по нужным категориям (по id, либо по родителю)
    const inNeededCat = isInNeededCategory(raw.category, cat, catIndex);
    if (!inNeededCat) continue;

    const parsed = parseProduct(raw, cat, catIndex);
    if (!parsed) continue;
    products.push(parsed);
    seen.add(raw.id);
  }

  // Сортировка: сначала светильники, потом шинопроводы, потом БП, потом коннекторы
  const order = { luminaire: 0, kit: 1, shinoprovod: 2, psu: 3, connector: 4, downlight_luminaire: 5, led_strip: 6, other: 9 };
  products.sort((a, b) =>
    (order[a.role] ?? 9) - (order[b.role] ?? 9)
    || (a.subcategory || '').localeCompare(b.subcategory || '')
    || (a.price_rub || 0) - (b.price_rub || 0)
  );

  return {
    source: 'https://zima-led.ru/cart/x5cart.js (live)',
    generated_at: new Date().toISOString(),
    generator: 'catalog-loader.js',
    products_count: products.length,
    products,
  };
}

function indexCategories(dataSource, out = {}, parent = null) {
  for (const node of dataSource) {
    if (node.type === 'category') {
      out[node.id] = { id: node.id, name: node.text, parent };
      if (node.items?.length) indexCategories(node.items, out, node.id);
    }
  }
  return out;
}

function isInNeededCategory(catId, cat, catIndex) {
  if (!catId) return false;
  if (NEEDED_CATEGORY_IDS.has(catId)) return true;
  // Идём вверх по родителям
  let c = cat;
  while (c && c.parent) {
    if (NEEDED_CATEGORY_IDS.has(c.parent)) return true;
    c = catIndex[c.parent];
  }
  return false;
}

function parseProduct(raw, cat, catIndex) {
  // Slug — из link.js.upload.jsonly (там `product/?slug`)
  let slug = null;
  const linkStr = raw.link?.js?.upload?.jsonly || raw.link?.js?.upload?.complete || '';
  const m = linkStr.match(/product\/\?([^'"\s)]+)/);
  if (m) slug = m[1];
  if (!slug) return null;   // без slug не сможем открыть карточку — пропускаем

  const props = raw.properties || {};
  const subcategory = cat?.name || '';
  const role = classifyRole(raw, cat, catIndex);

  // Тех-параметры.
  // ВАЖНО: в реальных данных сайта zima-led properties могут содержать ошибки
  // (например, у 220V-модели написано "48V"), а slug и имя — исправить сложнее,
  // они видны клиенту. Поэтому берём наиболее ДОСТОВЕРНЫЙ источник в порядке:
  //   1) явное значение из slug (например, "230v" → 220)
  //   2) явное значение из name
  //   3) значение из properties (может быть ошибочным)
  const voltage_v = parseVoltage(slug) ?? parseVoltage(raw.name)
                    ?? parseVoltage(props['Вх Напряжение'] || props['Напряжение']);
  const power_w = parsePower(raw.name) ?? parsePower(props['Мощность']);
  const cct_k = parseCct(raw.name) ?? parseCct(props['Температура']);
  const color = parseColor(slug) ?? parseColor(raw.name) ?? parseColor(props['Цвет']);
  // Для длины трека: name («2 метра») достовернее properties
  const length_m = parseLength(raw.name) ?? parseLength(props['Длина']);

  const image_url = raw.media?.[0]?.url ? absImage(raw.media[0].url) : '';

  // Повороты — из properties. Если отсутствуют, для люминеров без явных ограничений
  // ставим дефолт 350°/90° (стандартный поворотный спот).
  const rotH = parseAngle(props['Поворот H']);   // горизонтальный поворот, ° (может быть null)
  const rotV = parseAngle(props['Поворот V']);   // вертикальный (наклон)
  // IP-класс защиты
  const ip = (props['Влагозашита'] || '').trim() || null;
  // Тип монтажа
  const mountType = (props['Тип'] || '').trim() || null;
  // Тип лампы / цоколь
  const lampBase = (props['Цоколь'] || props['Тип лампы'] || '').trim() || null;

  const tags = [];
  const p = {
    slug,
    x5_id: raw.id,
    name: raw.name.trim(),
    description: (raw.description || '').trim(),
    sku: raw.sku || null,
    category: primaryCategory(role),
    subcategory,
    price_rub: parseInt(raw.price) || null,
    image_url,
    product_url: 'https://zima-led.ru/product/?' + slug,
    voltage_v,
    power_w,
    cct_k,
    color: color || '',
    series: detectSeries(raw.name),
    length_m,
    lumen: null,
    beam_deg: null,
    cri: null,
    type: '',
    role,
    in_stock: raw.staticAvailValue === 'available' || raw.availabilityType === 'fixed',
    tags,
    // Новое: механические характеристики
    rot_h_deg: rotH,     // 350° = полный оборот; 0° = не поворачивается; 180° = ограниченный
    rot_v_deg: rotV,     // 90° = наклон вверх/вниз; 0° = фиксированный
    ip,
    mount_type: mountType,
    lamp_base: lampBase,
    // Все properties как есть — для UI (карточка товара)
    raw_properties: { ...props },
  };

  // === 1) Обогащение из TECH_HINTS по slug (максимальный приоритет) ===
  const hint = TECH_HINTS[slug];
  if (hint) {
    for (const k of Object.keys(hint)) {
      if (p[k] == null || p[k] === '') p[k] = hint[k];
    }
  }

  // === 2) Fallback по СЕРИИ (когда slug мусорный) ===
  if (p.series && SERIES_HINTS[p.series]) {
    const sh = SERIES_HINTS[p.series];
    for (const k of Object.keys(sh)) {
      if (p[k] == null || p[k] === '') p[k] = sh[k];
    }
  }

  // === 3) Fallback по ЦОКОЛЮ (для встраиваемых downlight-корпусов) ===
  // Если у товара есть Цоколь и он в списке LAMP_DEFAULTS — применяем
  // ТИПОВУЮ лампу для этого цоколя (lm, beam_deg, type).
  const detectedBase = normalizeBaseName(lampBase || nameLampBase(raw.name));
  if (detectedBase && LAMP_DEFAULTS[detectedBase] && !p.lamp_ref) {
    const def = LAMP_DEFAULTS[detectedBase];
    p.lamp_ref = { power_w: def.power_w, lumen: def.lumen, beam_deg: def.beam_deg, base: detectedBase };
    if (p.lumen == null) p.lumen = def.lumen;
    if (p.beam_deg == null) p.beam_deg = def.beam_deg;
    if (!p.type) p.type = def.type_hint;
    if (!p.lamp_base) p.lamp_base = detectedBase;
  }

  // === 4) Обработка «под лампу» — используем реальную мощность LED, не max допустимую ===
  const nameL = raw.name.toLowerCase();
  const isLampBased = !!p.lamp_ref
    || nameL.includes('под лампу')
    || nameL.includes('gu10')
    || nameL.includes('gx53')
    || nameL.includes('mr16')
    || nameL.includes('mr11')
    || (detectedBase && LAMP_DEFAULTS[detectedBase]);

  if (isLampBased) {
    p.tags.push('lamp_required');
    const lampP = p.lamp_ref?.power_w
                  || (detectedBase && LAMP_DEFAULTS[detectedBase]?.power_w)
                  || 7;
    // ВАЖНО: properties.Мощность в CMS zima-led = МАКСИМАЛЬНО допустимая
    // мощность лампы (для галогенки), а не реальное энергопотребление корпуса.
    // Люди в 99% случаев ставят LED — поэтому для расчёта нагрузки и цены
    // ВСЕГДА заменяем на typical LED (lamp_ref.power_w).
    // Максимальную «paper»-мощность из CMS сохраняем как `max_lamp_w` для отображения.
    if (p.power_w != null && p.power_w !== lampP) {
      p.max_lamp_w = p.power_w;    // сохранить как справочное значение (для UI)
    }
    p.power_w = lampP;
    p.tags.push('power_from_lamp');
    if (p.lumen == null) {
      p.lumen = p.lamp_ref?.lumen || (detectedBase && LAMP_DEFAULTS[detectedBase]?.lumen) || 500;
    }
    if (p.beam_deg == null) {
      p.beam_deg = p.lamp_ref?.beam_deg || (detectedBase && LAMP_DEFAULTS[detectedBase]?.beam_deg) || 36;
    }
    if (!p.type) {
      p.type = (detectedBase && LAMP_DEFAULTS[detectedBase]?.type_hint) || 'spot';
    }
  }

  // === 5) Финальные safety-defaults ===
  // Для интегрированных LED-светильников без tech_hints — задаём разумные fallback'ы
  if (p.role === 'luminaire' && !p.lumen && p.power_w) {
    // Светодиодная эффективность ~ 80–100 лм/Вт
    p.lumen = Math.round(p.power_w * 90);
    p.tags.push('lumen_estimated');
  }
  if (p.role === 'luminaire' && !p.beam_deg) {
    p.beam_deg = 60;   // средний spot
    p.tags.push('beam_estimated');
  }
  if (!p.cri) p.cri = 80;

  return p;
}

/** Нормализуем название цоколя (GU10, GX53 и т.п.) */
function normalizeBaseName(text) {
  if (!text) return null;
  const s = String(text).toUpperCase().replace(/\s+/g, '').replace(/[^A-ZА-Я0-9.]/g, '');
  const map = { 'GU10': 'GU10', 'GX53': 'GX53', 'GU5.3': 'GU5.3', 'G5.3': 'G5.3',
                'MR16': 'MR16', 'MR11': 'MR11', 'E14': 'E14', 'E27': 'E27' };
  return map[s] || null;
}

/** Извлекает название цоколя из имени товара (GU10/GX53/MR16 в name) */
function nameLampBase(name) {
  if (!name) return null;
  const s = String(name).toUpperCase();
  for (const b of ['GU5.3', 'GX53', 'GU10', 'MR16', 'MR11', 'E27', 'E14']) {
    if (s.includes(b)) return b;
  }
  return null;
}

// -------- Извлечение свойств --------

function parseVoltage(text) {
  if (!text) return null;
  const s = String(text).toLowerCase();
  // Ищем ЧИСЛО, за которым идёт "v" / "в" / "vольт" — не подстроку "48" в "AL148"
  const m = s.match(/(\d{2,3})\s*(?:v|в(?:ольт)?)\b/);
  if (m) {
    const v = parseInt(m[1]);
    if (v === 230) return 220;
    if ([12, 24, 48, 110, 220].includes(v)) return v;
  }
  // fallback: чёткие маркеры (для случаев без «V» — маловероятно, но пусть будет)
  if (/\b48\b/.test(s) && !/al\s?\d/.test(s)) return 48;
  if (/\b(?:220|230)\b/.test(s)) return 220;
  return null;
}

function parsePower(text) {
  if (!text) return null;
  // Матчим ТОЛЬКО «Вт» целиком или английские w/W. Одиночная кириллическая «т» после цифры
  // ошибочно матчилась в character class [Вт] (буква из «трековый»).
  const m = String(text).match(/(\d{1,4}(?:\.\d)?)\s*(?:[wW]\b|Вт\b)/);
  if (m) return parseFloat(m[1]);
  return null;
}

function parseCct(text) {
  if (!text) return null;
  const s = String(text).toLowerCase().trim();
  // Численно (например «4000K»)
  const mNum = s.match(/(\d{3,4})\s*[kKКк]/);
  if (mNum) return parseInt(mNum[1]);
  // По ключевому слову
  for (const key of Object.keys(CCT_FROM_PROP)) {
    if (s.includes(key)) return CCT_FROM_PROP[key];
  }
  return null;
}

function parseColor(text) {
  if (!text) return null;
  const s = String(text).toLowerCase();
  for (const [key, val] of Object.entries(COLOR_FROM_PROP)) {
    if (s.includes(key)) return val;
  }
  return null;
}

function parseLength(text) {
  if (!text) return null;
  const m = String(text).match(/(\d+(?:[.,]\d+)?)\s*(?:м|метр)/i);
  if (m) return parseFloat(m[1].replace(',', '.'));
  return null;
}

/** Парсинг угла (например «350°», «90°», «0°») → число или null */
function parseAngle(text) {
  if (text == null) return null;
  const m = String(text).match(/(\d{1,3})\s*°?/);
  if (m) {
    const n = parseInt(m[1]);
    if (n >= 0 && n <= 360) return n;
  }
  return null;
}

function detectSeries(name) {
  const patterns = [/\b(MGN\d{3})\b/, /\b(AL\d{3})\b/, /\bSLIM\s?(\d{3,4})\b/i];
  for (const p of patterns) {
    const m = name.match(p);
    if (m) return m[1].replace(/\s+/g, '');
  }
  return '';
}

function absImage(url) {
  if (/^https?:/.test(url)) return url;
  if (url.startsWith('/')) return 'https://zima-led.ru' + url;
  return 'https://zima-led.ru/' + url;
}

// -------- Классификация role --------

function classifyRole(raw, cat, catIndex) {
  const name = (raw.name || '').toLowerCase();
  const catName = (cat?.name || '').toLowerCase();
  const parentName = (catIndex?.[cat?.parent]?.name || '').toLowerCase();

  // Приоритет: соединители/коннекторы выше шинопровода
  if (/соедин|коннектор|заглушк|токоподвод/.test(name)) return 'connector';
  if (/комплект|2в1|\+ 5/.test(name)) return 'kit';
  if (/блок питани|драйвер|трансформатор|источник питания/.test(name + ' ' + catName)) return 'psu';
  if (/шинопровод/.test(name + ' ' + catName)) return 'shinoprovod';
  if (/светодиодная лента|светодиодная\s*led/.test(name) || /лента/.test(catName)) return 'led_strip';
  if (/встраиваем|точечн/.test(name + ' ' + catName)) return 'downlight_luminaire';
  if (/светильник|прожектор/.test(name)) return 'luminaire';
  return 'other';
}

function primaryCategory(role) {
  // Соответствие с прежним поле catalog.category (для совместимости с UI)
  return {
    psu: 'power_supply',
    shinoprovod: 'track_system',
    connector: 'track_system',
    luminaire: 'track_system',
    kit: 'track_system',
    downlight_luminaire: 'downlight',
    led_strip: 'led_strip',
  }[role] || 'other';
}
