/**
 * app.js — оркестратор UI-мастера.
 * Реактивное состояние на ванильном JS + subscribe-паттерн.
 */

import * as Calc from './calc.js?v=20260826-ui14';
import * as Val from './validators.js?v=20260826-ui14';
import * as R2D from './render2d.js?v=20260826-ui14';
import * as R3D from './render3d.js?v=20260826-ui14';
import * as Scene from './scene.js?v=20260826-ui14';
import { createEditor } from './editor.js?v=20260826-ui14';
import * as Share from './share.js?v=20260826-ui14';
import { CCT_LIST, getCCT } from './cct.js';
import { loadCatalogAuto, reloadCatalog } from './catalog-loader.js';
import { addToSiteCart, openSiteCart, getSiteCartCount } from './cart-integration.js';

// ============================================================
// Состояние
// ============================================================

const state = {
  step: 1,
  db: null,          // {catalog, norms, presets}
  project: {
    presetId: null,
    room: { length: 5, width: 4, height: 2.7, shape: 'rect', ceiling: 'gkl' },
    system: {
      voltage_v: 48, dimmable: false, color: 'black', mount: 'nakladnoi',
      feedMode: 'auto', feeds: 1, zoneLayout: 'zone',
      // Ручной режим типов светильников (Шаг 3 → «Типы светильников»).
      // lightMode: 'auto' | 'manual'; lightMix — количество по типам света.
      lightMode: 'auto',
      lightMix: {
        downlight: { rasseivayushchiy: 0, napravlennyy: 0, fokus_lens: 0, povorotnyy: 0, staticheskiy: 0 },
        track:     { rasseivayushchiy: 0, napravlennyy: 0, fokus_lens: 0, povorotnyy: 0 },
      },
    },
    zones: [],       // {zone_id, area_share, cct_k, x?, y?, w?, h?} — свободный XY-редактор
    layout: 'line_center',
  },
  scene: null,       // редактируемая сцена (drag-and-drop)
  // Витрина «🏆 Популярные проекты» (Шаг 1, под «Готовыми сценариями»).
  // status: 'loading' | 'on' | 'off' — 'off' если PHP-API недоступен (блок скрыт).
  gallery: { status: 'loading', items: [] },
  resultScene: null, // неизменяемый снимок, общий для расчёта и итогового SVG
  result: null,      // computeFromScene(scene) — обновляется на каждое изменение
  autoResult: null,  // «эталон» — что бы дало computeProject без ручных правок
  warnings: [],
  viewOptions: {     // настройки визуализации результата
    viewMode: '2d',
    camera3d: { ...R3D.DEFAULT_CAMERA },
    showZones: true,
    showBeams: true,
    showDimensions: true,
    showLegend: true,
  },
  editorInstance: null,  // singleton экземпляр редактора
};

const listeners = [];
function subscribe(fn) { listeners.push(fn); }
function emit() { listeners.forEach(fn => fn(state)); }

function setState(patch) {
  Object.assign(state, patch);
  emit();
}
function setProject(patch) {
  Object.assign(state.project, patch);
  recompute();
  emit();
}
function setRoom(patch) {
  const room = state.project.room;
  const prevLength = room.length;
  const prevWidth = room.width;

  // HTML min/max не защищают от пустой строки и ручного ввода за диапазоном.
  const next = { ...patch };
  if ('length' in next) next.length = clampNum(next.length, 1, 20);
  if ('width' in next) next.width = clampNum(next.width, 1, 20);
  if ('height' in next) next.height = clampNum(next.height, 2, 5);
  Object.assign(room, next);

  // При изменении габаритов сохраняем относительное положение и долю зон,
  // а не обрезаем их во время следующего render().
  if (room.length !== prevLength || room.width !== prevWidth) {
    const scaleX = prevLength > 0 ? room.length / prevLength : 1;
    const scaleY = prevWidth > 0 ? room.width / prevWidth : 1;
    if (state.project.zones.length > 0) {
      for (const zone of state.project.zones) {
        if (Number.isFinite(zone.x) && Number.isFinite(zone.w)) {
          zone.x *= scaleX;
          zone.w *= scaleX;
        }
        if (Number.isFinite(zone.y) && Number.isFinite(zone.h)) {
          zone.y *= scaleY;
          zone.h *= scaleY;
        }
      }
      ensureZoneCoords(state.project);
    }

    // Ручная сцена масштабируется вместе с помещением, иначе pinned-объекты
    // оставались на старых координатах и могли оказаться за новой границей.
    if (state.scene) {
      state.scene = {
        ...state.scene,
        tracks: state.scene.tracks.map(track => ({
          ...track,
          points: track.points.map(point => ({ x: point.x * scaleX, y: point.y * scaleY })),
        })),
        luminaires: state.scene.luminaires.map(lum => ({
          ...lum,
          x: lum.x * scaleX,
          y: lum.y * scaleY,
        })),
      };
    }
  }

  recompute();
  emit();
}
function setSystem(patch) {
  Object.assign(state.project.system, patch);
  recompute();
  emit();
}

/** Создаёт независимый снимок сцены для атомарного расчёта и SVG-результата. */
function snapshotScene(scene) {
  if (!scene) return null;
  try { return JSON.parse(JSON.stringify(scene)); }
  catch (e) { console.error('Не удалось создать снимок сцены:', e); return null; }
}

/**
 * Пересчёт при изменении project (шаги 1-3) или при первой инициализации.
 * Стратегия:
 *   1. Считаем автоподбор (computeProject) — эталон.
 *   2. Строим/обновляем сцену через reconcileScene (сохраняем pinned-правки).
 *   3. Считаем фактический результат из сцены (computeFromScene).
 */
function recompute() {
  if (!state.db) return;
  if (state.project.zones.length === 0) {
    state.result = null; state.autoResult = null; state.scene = null;
    state.resultScene = null; state.warnings = [];
    return;
  }
  try {
    state.autoResult = Calc.computeProject(state.project, state.db);
    // Сцена: если её ещё нет — строим авто; иначе — reconcile (сохраняем ручные правки)
    const { scene: newScene } = Scene.reconcileScene(state.scene, state.project, state.autoResult);
    state.scene = newScene;
    state.resultScene = snapshotScene(newScene);
    state.result = Calc.computeFromScene(state.project, state.resultScene, state.db);
    state.warnings = Val.runAllChecks(state.project, state.result, state.db);
  } catch (e) {
    console.error('Ошибка расчёта:', e);
    state.result = null;
    state.warnings = [{ level: 'error', code: 'CALC_ERR', title: 'Ошибка расчёта', message: e.message }];
  }
}

/**
 * Пересчёт только из сцены (после ручной правки в редакторе).
 * project и scene не пересобираются — только пересчёт спецификации.
 */
function recomputeFromScene() {
  if (!state.db || !state.scene) return;
  try {
    const finalSnapshot = snapshotScene(state.scene);
    if (!finalSnapshot) throw new Error('Не удалось зафиксировать финальную сцену');
    state.resultScene = finalSnapshot;
    state.result = Calc.computeFromScene(state.project, finalSnapshot, state.db);
    state.warnings = Val.runAllChecks(state.project, state.result, state.db);
  } catch (e) {
    console.error('Ошибка пересчёта:', e);
    // Не оставляем на экране предыдущий успешный результат: он выглядит как
    // будто последние изменения редактора были проигнорированы.
    state.result = null;
    state.warnings = [{
      level: 'error', code: 'SCENE_CALC_ERR', title: 'Ошибка пересчёта сцены',
      message: String(e?.message || e),
    }];
  }
}

/** Лёгкая синхронизация drag-preview без пересчёта и общего render(). */
function onScenePreview(payload) {
  if (payload && Array.isArray(payload.tracks) && Array.isArray(payload.luminaires)) {
    state.scene = payload;
  }
}

/**
 * Обработчик изменений сцены из редактора.
 * Если пришла строка 'reset-auto' — сбрасываем все ручные правки.
 */
function onSceneChange(payload) {
  const isResetToAuto = payload === 'reset-auto';
  if (isResetToAuto) {
    // Пересобираем сцену с нуля из авторасчёта
    if (state.autoResult) {
      state.scene = Scene.autoLayoutFromProject(state.project, state.autoResult);
    } else {
      return;   // нечего сбрасывать
    }
  } else if (payload && typeof payload === 'object') {
    state.scene = payload;
  } else {
    return;
  }
  recomputeFromScene();
  // Обычное изменение уже отрисовано самим Editor.setScene(). Повторный update()
  // здесь удваивал рендер viewport/теплокарты на каждом pointermove. Внешне
  // синхронизируем редактор только при полном сбросе сцены к авто-раскладке.
  if (isResetToAuto && state.editorInstance && state.scene) {
    try { state.editorInstance.update({ scene: state.scene }); }
    catch (e) { console.error(e); }
  }
  // Если пользователь уже на шаге 5 (Результат) — обновим его
  if (state.step === 5) renderStep5();
}

// ============================================================
// Загрузка данных
// ============================================================

async function loadData() {
  // Норм и пресетов достаточно из статики — они меняются редко.
  // Каталог грузим АВТОМАТИЧЕСКИ из /cart/x5cart.js (обновляется CMS сайта при добавлении товара).
  // Fallback: если сеть до x5cart.js не пройдёт — берём аварийную копию assets/data/catalog.json.
  const [norms, presets, fallbackCatalog] = await Promise.all([
    fetch('assets/data/norms.json').then(r => r.json()),
    fetch('assets/data/presets.json').then(r => r.json()),
    fetch('assets/data/catalog.json').then(r => r.json()).catch(() => null),
  ]);

  const catalog = await loadCatalogAuto({
    // fallbackCatalog даст нам минимум данных, если /cart/x5cart.js упадёт
    fallbackCatalog,
    cacheMinutes: 60,     // локальный кэш на час — не грузим 1MB при каждой перезагрузке
  });

  if (catalog.from_fallback) {
    console.warn('[app] используется fallback catalog.json (x5cart.js недоступен):', catalog.error);
  } else if (catalog.from_cache) {
    console.info(`[app] каталог из кэша (возраст ${catalog.cache_age_min} мин, ${catalog.products.length} товаров)`);
  } else {
    console.info(`[app] каталог загружен из x5cart.js: ${catalog.products.length} товаров`);
  }

  state.db = { catalog: catalog.products, norms, presets };
  state.catalogMeta = {
    source: catalog.source,
    generated_at: catalog.generated_at,
    products_count: catalog.products.length,
    from_cache: !!catalog.from_cache,
    from_fallback: !!catalog.from_fallback,
    cache_age_min: catalog.cache_age_min || 0,
  };
  // init() выполнит один итоговый render после restore/recompute.
}

/** Публичный API для UI-кнопки «Обновить каталог» */
window.__zlc_reloadCatalog = async function() {
  console.info('[app] Принудительное обновление каталога...');
  try {
    const catalog = await reloadCatalog({ fallbackCatalog: null });
    state.db.catalog = catalog.products;
    state.catalogMeta = {
      source: catalog.source, generated_at: catalog.generated_at,
      products_count: catalog.products.length, from_cache: false, from_fallback: false,
    };
    // Цена, BOM и доступные модели должны сразу соответствовать новому каталогу.
    recompute();
    emit();
    return `✓ Обновлено: ${catalog.products.length} товаров`;
  } catch (e) {
    console.error(e);
    return 'Ошибка обновления: ' + e.message;
  }
};

// ============================================================
// Рендер
// ============================================================

function fmtRub(n) {
  return (n || 0).toLocaleString('ru-RU') + ' ₽';
}
function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

function renderSteps() {
  const items = [
    { n: 1, title: 'Помещение' },
    { n: 2, title: 'Зоны и сценарий' },
    { n: 3, title: 'Система освещения' },
    { n: 4, title: 'Редактор плана' },
    { n: 5, title: 'Результат' },
  ];
  const wrap = document.getElementById('steps-list');
  wrap.innerHTML = '';
  items.forEach(it => {
    const done = state.step > it.n;
    const active = state.step === it.n;
    const canClick = it.n <= state.step || ((it.n === 4 || it.n === 5) && state.project.zones.length > 0);
    const cls = 'step-item ' + (active ? 'active ' : '') + (done ? 'done ' : '') + (canClick ? '' : 'locked');
    const node = el('div', { class: cls, onClick: () => {
      if (!canClick) return;
      if (it.n === 5) goToResults();
      else setState({ step: it.n });
    } },
      el('div', { class: 'num' }, String(it.n)),
      el('div', {}, it.title),
    );
    wrap.appendChild(node);
  });
}

// --- Шаг 1: Помещение ---

function renderStep1() {
  const r = state.project.room;
  const container = document.getElementById('step-1');
  container.innerHTML = '';

  container.appendChild(el('h2', {}, '📐 Габариты помещения'));
  container.appendChild(el('p', { class: 'hint' }, 'Введите размеры или выберите пресет ниже.'));

  const makeNumRow = (label, key, min, max, step) => {
    const inputId = `room-${key}`;
    const numberInput = el('input', {
      id: inputId, type: 'number', min, max, step, value: r[key],
      // Коммитим число по change: полный render на каждый символ сбивал фокус.
      onChange: (e) => setRoom({ [key]: Number(e.target.value) }),
    });
    const rangeInput = el('input', {
      type: 'range', min, max, step, value: r[key],
      'aria-label': label.replace(/<[^>]+>/g, ''),
      // Во время drag обновляем только связанное поле. Расчёт выполняется один
      // раз при отпускании ползунка, а не с полной перерисовкой на каждый пиксель.
      onInput: (e) => { numberInput.value = e.target.value; },
      onChange: (e) => setRoom({ [key]: Number(e.target.value) }),
    });
    return el('div', { class: 'form-row' },
      el('label', { html: label, for: inputId }),
      el('div', { class: 'number-with-slider' }, numberInput, rangeInput),
    );
  };

  container.appendChild(makeNumRow('Длина, <b>м</b>', 'length', 1, 20, 0.1));
  container.appendChild(makeNumRow('Ширина, <b>м</b>', 'width', 1, 20, 0.1));
  container.appendChild(makeNumRow('Высота потолка, <b>м</b>', 'height', 2, 5, 0.1));

  // Тип потолка
  const ceilings = state.db.presets.ceiling_types;
  container.appendChild(el('div', { class: 'form-row' },
    el('label', { html: 'Тип потолка' }),
    el('div', { class: 'radio-tabs' },
      ...ceilings.map(c => [
        el('input', { type: 'radio', name: 'ceiling', id: 'c-' + c.id,
          checked: r.ceiling === c.id ? '' : null,
          onChange: () => setRoom({ ceiling: c.id }) }),
        el('label', { for: 'c-' + c.id }, c.name),
      ]).flat(),
    ),
  ));

  // Пресеты
  container.appendChild(el('h3', { class: 'mt-lg' }, 'Или выберите готовый сценарий:'));
  const grid = el('div', { class: 'presets-grid' });
  for (const preset of state.db.presets.presets) {
    const selected = state.project.presetId === preset.id;
    grid.appendChild(el('div', {
      class: 'preset-card' + (selected ? ' selected' : ''),
      onClick: () => applyPreset(preset),
    },
      el('div', { class: 'emoji' }, preset.emoji || '🏠'),
      el('div', { class: 'title' }, preset.title),
      el('div', { class: 'desc' }, preset.description),
    ));
  }
  container.appendChild(grid);

  // Витрина «Топ-12 популярных проектов» (под «Готовыми сценариями»).
  // Появляется только если PHP-API рейтинга доступен (runtime-самопроба).
  const topGallery = renderTopGallery();
  if (topGallery) container.appendChild(topGallery);

  // Actions
  container.appendChild(el('div', { class: 'actions' },
    el('span', {}, ''),
    el('button', { class: 'btn btn-primary', onClick: () => setState({ step: 2 }) }, 'Далее →'),
  ));
}

function applyPreset(preset) {
  // Обновляем проект атомарно: прежний setState() запускал промежуточный render
  // ещё до recompute(), а затем сразу выполнялся второй полный render.
  state.project = {
    ...state.project,
    presetId: preset.id,
    room: { ...state.project.room, ...preset.room },
    system: { ...state.project.system, ...preset.system },
    zones: preset.zones.map(z => ({ ...z })),
    layout: preset.recommended_track_layout,
  };
  recompute();
  emit();
}

// --- Шаг 2: Зоны ---

function renderStep2() {
  const container = document.getElementById('step-2');
  container.innerHTML = '';

  container.appendChild(el('h2', {}, '🎯 Функциональные зоны'));
  container.appendChild(el('p', { class: 'hint' },
    'Тяните разделители между зонами на плане, чтобы менять их размеры. Ниже — параметры каждой зоны.'));

  const totalArea = state.project.room.length * state.project.room.width;
  const totalShare = state.project.zones.reduce((s, z) => s + (z.area_share || 0), 0);

  // 1) Визуальный редактор зон — SVG с drag'ом разделителей
  container.appendChild(buildZonesVisualEditor());

  // 2) Список зон с параметрами
  const list = el('div', { class: 'zones-list' });
  state.project.zones.forEach((z, idx) => {
    const norm = state.db.norms.zones.find(nz => nz.id === z.zone_id);
    if (!norm) return;

    const zoneColor = ZONE_COLORS[idx % ZONE_COLORS.length];

    const sel = el('select', {
      onChange: (e) => {
        state.project.zones[idx].zone_id = e.target.value;
        const nn = state.db.norms.zones.find(nz => nz.id === e.target.value);
        state.project.zones[idx].cct_k = nn.cct_k?.[0] || 3000;
        recompute(); emit();
      },
    });
    for (const nz of state.db.norms.zones) {
      const o = el('option', { value: nz.id, selected: nz.id === z.zone_id ? '' : null }, nz.name);
      sel.appendChild(o);
    }

    list.appendChild(el('div', { class: 'zone-row' },
      el('div', {},
        el('div', { class: 'zone-color-marker', style: `background:${zoneColor.stroke}` }, `${idx + 1}`),
      ),
      el('div', {},
        sel,
        el('div', { class: 'zone-meta' },
          `${norm.lux} лк • ${(norm.cct_k || []).join('/') }K • CRI≥${norm.cri_min} • угол ${(norm.beam_deg || []).join('-')}°`),
      ),
      el('div', {},
        el('input', {
          type: 'number', min: 0.05, max: 1, step: 0.05, value: z.area_share.toFixed(2),
          onChange: (e) => {
            resizeZoneToShare(state.project.zones[idx], clampNum(e.target.value, 0.05, 1), state.project.room);
            recompute(); emit();
          },
        }),
        el('div', { class: 'zone-meta' }, `${(totalArea * z.area_share).toFixed(1)} м²`),
      ),
      el('select', {
        onChange: (e) => {
          state.project.zones[idx].cct_k = Number(e.target.value);
          recompute(); emit();
        },
      },
        ...CCT_LIST.map(c => el('option',
          { value: String(c.K), selected: (z.cct_k || 3000) === c.K ? '' : null },
          `${c.short} — ${c.label}`)),
      ),
      el('div', { class: 'zone-row-actions' },
        el('button', { class: 'btn-icon', title: 'Переместить выше',
          disabled: idx === 0 ? '' : null,
          onClick: () => {
            if (idx === 0) return;
            const arr = state.project.zones;
            [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
            state.selectedZoneIdx = idx - 1;
            recompute(); emit();
          } }, '↑'),
        el('button', { class: 'btn-icon', title: 'Переместить ниже',
          disabled: idx === state.project.zones.length - 1 ? '' : null,
          onClick: () => {
            const arr = state.project.zones;
            if (idx === arr.length - 1) return;
            [arr[idx + 1], arr[idx]] = [arr[idx], arr[idx + 1]];
            state.selectedZoneIdx = idx + 1;
            recompute(); emit();
          } }, '↓'),
        el('button', { class: 'btn-remove', onClick: () => {
          state.project.zones.splice(idx, 1);
          state.selectedZoneIdx = null;
          recompute(); emit();
        } }, '✕'),
      ),
    ));
  });
  container.appendChild(list);

  container.appendChild(el('button', { class: 'btn-add-zone', onClick: () => {
    // При добавлении новой зоны — размещаем её в свободном углу (или пересчитываем grid)
    const room = state.project.room;
    const newZone = {
      zone_id: 'living_general',
      cct_k: 3000,
      // Размещаем небольшой квадрат в углу, если места нет — автораскладка
      x: 0.5, y: 0.5,
      w: Math.min(2, room.length - 1),
      h: Math.min(2, room.width - 1),
    };
    newZone.area_share = (newZone.w * newZone.h) / (room.length * room.width);
    state.project.zones.push(newZone);
    // Если зон стало больше 4 — автораскладка
    if (state.project.zones.length >= 4) autoLayoutZones(state.project);
    state.selectedZoneIdx = state.project.zones.length - 1;
    recompute(); emit();
  } }, '+ Добавить зону'));

  const shareInfo = el('div', { class: 'mt-md muted' },
    `Суммарная доля площади: ${(totalShare * 100).toFixed(0)}% ` +
    (Math.abs(totalShare - 1) < 0.01
      ? '✓ (идеально 100%)'
      : totalShare < 1 ? '(остаток не покрыт — будет считаться как «без света»)'
                       : '(перекрытие зон — расчёт даст запас)'));
  container.appendChild(shareInfo);

  container.appendChild(el('div', { class: 'actions' },
    el('button', { class: 'btn btn-secondary', onClick: () => setState({ step: 1 }) }, '← Назад'),
    el('button', { class: 'btn btn-primary',
      onClick: () => setState({ step: 3 }),
      disabled: state.project.zones.length === 0 ? '' : null,
    }, 'Далее →'),
  ));
}

const ZONE_COLORS = [
  { fill: 'rgba(74,163,255,0.15)', stroke: 'rgba(74,163,255,0.7)' },
  { fill: 'rgba(255,181,71,0.15)', stroke: 'rgba(255,181,71,0.7)' },
  { fill: 'rgba(74,222,128,0.15)', stroke: 'rgba(74,222,128,0.7)' },
  { fill: 'rgba(248,113,113,0.15)', stroke: 'rgba(248,113,113,0.7)' },
  { fill: 'rgba(168,85,247,0.15)', stroke: 'rgba(168,85,247,0.7)' },
  { fill: 'rgba(236,72,153,0.15)', stroke: 'rgba(236,72,153,0.7)' },
];

/**
 * Гарантирует, что у каждой зоны есть координаты x, y, w, h в метрах.
 * Если они отсутствуют (legacy) — вычисляет из area_share как вертикальные полосы.
 * После этой функции area_share пересчитывается как w*h / (roomL * roomW).
 */
function ensureZoneCoords(project) {
  const room = project.room;
  const zones = project.zones;
  const total = zones.reduce((s, z) => s + (z.area_share || 0), 0) || 1;
  let accX = 0;
  for (const z of zones) {
    if (typeof z.x !== 'number' || typeof z.w !== 'number') {
      const share = (z.area_share || 0.2) / total;
      z.x = accX;
      z.y = 0;
      z.w = room.length * share;
      z.h = room.width;
      accX += z.w;
    }
    // Клампим в комнату
    z.x = Math.max(0, Math.min(room.length - 0.3, z.x));
    z.y = Math.max(0, Math.min(room.width - 0.3, z.y));
    z.w = Math.max(0.3, Math.min(room.length - z.x, z.w));
    z.h = Math.max(0.3, Math.min(room.width - z.y, z.h));
    // area_share синхронизируется по факту (w*h / total_area)
    z.area_share = (z.w * z.h) / (room.length * room.width);
  }
}

/** Меняет площадь прямоугольной зоны, сохраняя её пропорции насколько возможно. */
function resizeZoneToShare(zone, share, room) {
  const roomArea = room.length * room.width;
  const targetArea = Math.max(0.09, Math.min(roomArea, roomArea * share));
  const currentArea = Math.max(0.09, (zone.w || 0.3) * (zone.h || 0.3));
  const scale = Math.sqrt(targetArea / currentArea);
  const maxW = Math.max(0.3, room.length - (zone.x || 0));
  const maxH = Math.max(0.3, room.width - (zone.y || 0));

  let w = Math.max(0.3, Math.min(maxW, (zone.w || 0.3) * scale));
  let h = Math.max(0.3, Math.min(maxH, targetArea / w));
  // Если высота упёрлась в границу, пробуем добрать площадь шириной.
  w = Math.max(0.3, Math.min(maxW, targetArea / h));

  zone.w = w;
  zone.h = h;
  zone.area_share = (w * h) / roomArea;
}

/**
 * Свободный XY-редактор зон.
 * Каждая зона — прямоугольник {x, y, w, h} в метрах.
 * Механика:
 *   - Тяните за середину зоны — перемещаете её (dragging move)
 *   - Тяните за угол (SE/SW/NE/NW) — меняете размер
 *   - Тяните за ребро — меняете размер по одной оси
 *   - Клик по зоне — выделяет её (жёлтая обводка)
 *   - Кнопка "↕" — переставить зоны местами в списке (влияет на порядок z-index на плане)
 */
function buildZonesVisualEditor() {
  const room = state.project.room;
  ensureZoneCoords(state.project);
  const zones = state.project.zones;

  const wrap = el('div', { class: 'zones-visual-editor' });

  // Тулбар над планом
  const toolbar = el('div', { class: 'zones-toolbar' },
    el('span', { class: 'zones-toolbar-hint' }, '↔ Тяните зону, углы/рёбра для ресайза • клик — выделить'),
    el('button', {
      class: 'btn-mini',
      onClick: () => {
        // Автораскладка: если несколько зон — раскладываем в grid
        autoLayoutZones(state.project);
        recompute(); emit();
      },
    }, '⊞ Авто-раскладка'),
  );
  wrap.appendChild(toolbar);

  const svgNS = 'http://www.w3.org/2000/svg';

  // Адаптивный размер: считаем от контейнера. Основной свёрстанный размер 700×340,
  // но SVG — responsive через viewBox.
  const roomAspect = room.length / room.width;
  const W = 700;
  const padL = 40, padR = 40, padT = 30, padB = 40;
  const drawW = W - padL - padR;
  const drawH = drawW / roomAspect;
  const H = drawH + padT + padB;
  const scaleX = drawW / room.length;
  const scaleY = drawH / room.width;
  const m2pxX = (m) => m * scaleX;
  const m2pxY = (m) => m * scaleY;
  const pxToMxX = (px) => (px - padL) / scaleX;
  const pxToMxY = (py) => (py - padT) / scaleY;

  const svgEl = document.createElementNS(svgNS, 'svg');
  svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svgEl.setAttribute('style', `display:block; width:100%; max-width:${W}px; height:auto;`);
  svgEl.classList.add('zones-svg');
  svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // Сетка 0.5м
  const gridSize = 0.5;
  const pattern = document.createElementNS(svgNS, 'pattern');
  pattern.setAttribute('id', 'zonesGrid');
  pattern.setAttribute('width', m2pxX(gridSize));
  pattern.setAttribute('height', m2pxY(gridSize));
  pattern.setAttribute('patternUnits', 'userSpaceOnUse');
  const gridPath = document.createElementNS(svgNS, 'path');
  gridPath.setAttribute('d', `M ${m2pxX(gridSize)} 0 L 0 0 0 ${m2pxY(gridSize)}`);
  gridPath.setAttribute('fill', 'none');
  gridPath.setAttribute('stroke', '#e0e0e0');
  gridPath.setAttribute('stroke-width', '0.5');
  pattern.appendChild(gridPath);
  const defs = document.createElementNS(svgNS, 'defs');
  defs.appendChild(pattern);
  svgEl.appendChild(defs);

  // Фон комнаты
  const roomRect = document.createElementNS(svgNS, 'rect');
  roomRect.setAttribute('x', padL); roomRect.setAttribute('y', padT);
  roomRect.setAttribute('width', drawW); roomRect.setAttribute('height', drawH);
  roomRect.setAttribute('fill', '#fff');
  roomRect.setAttribute('stroke', '#b0b0b0');
  roomRect.setAttribute('stroke-width', '2');
  roomRect.setAttribute('rx', '4');
  svgEl.appendChild(roomRect);
  // Сетка
  const gridRect = document.createElementNS(svgNS, 'rect');
  gridRect.setAttribute('x', padL); gridRect.setAttribute('y', padT);
  gridRect.setAttribute('width', drawW); gridRect.setAttribute('height', drawH);
  gridRect.setAttribute('fill', 'url(#zonesGrid)');
  gridRect.setAttribute('pointer-events', 'none');
  svgEl.appendChild(gridRect);

  // Зоны (в порядке — задние выше в DOM, передние — ниже)
  const zonesGroup = document.createElementNS(svgNS, 'g');
  zonesGroup.classList.add('zones-group');
  svgEl.appendChild(zonesGroup);

  zones.forEach((z, idx) => {
    const color = ZONE_COLORS[idx % ZONE_COLORS.length];
    const norm = state.db.norms.zones.find(nz => nz.id === z.zone_id);
    const isSelected = state.selectedZoneIdx === idx;

    const zg = document.createElementNS(svgNS, 'g');
    zg.classList.add('zone-group');
    zg.dataset.idx = String(idx);
    zonesGroup.appendChild(zg);

    // Основной прямоугольник зоны
    const zx = padL + m2pxX(z.x);
    const zy = padT + m2pxY(z.y);
    const zw = m2pxX(z.w);
    const zh = m2pxY(z.h);

    const rect = document.createElementNS(svgNS, 'rect');
    rect.setAttribute('x', zx); rect.setAttribute('y', zy);
    rect.setAttribute('width', zw); rect.setAttribute('height', zh);
    rect.setAttribute('fill', color.fill);
    rect.setAttribute('stroke', isSelected ? '#4182f5' : color.stroke);
    rect.setAttribute('stroke-width', isSelected ? 2.5 : 1.5);
    rect.setAttribute('stroke-dasharray', isSelected ? '' : '5,3');
    rect.setAttribute('rx', '3');
    rect.style.cursor = 'move';
    zg.appendChild(rect);

    // Метка
    let zoneLabel = null;
    let zoneAreaLabel = null;
    if (norm) {
      zoneLabel = document.createElementNS(svgNS, 'text');
      zoneLabel.setAttribute('x', zx + zw / 2);
      zoneLabel.setAttribute('y', zy + zh / 2 - 4);
      zoneLabel.setAttribute('text-anchor', 'middle');
      zoneLabel.setAttribute('fill', color.stroke);
      zoneLabel.setAttribute('font-weight', '700');
      zoneLabel.setAttribute('font-size', '12');
      zoneLabel.setAttribute('pointer-events', 'none');
      const shortName = norm.name.length > 22 ? norm.name.slice(0, 22) + '…' : norm.name;
      zoneLabel.textContent = `${idx + 1}. ${shortName}`;
      zg.appendChild(zoneLabel);

      zoneAreaLabel = document.createElementNS(svgNS, 'text');
      zoneAreaLabel.setAttribute('x', zx + zw / 2);
      zoneAreaLabel.setAttribute('y', zy + zh / 2 + 12);
      zoneAreaLabel.setAttribute('text-anchor', 'middle');
      zoneAreaLabel.setAttribute('fill', color.stroke);
      zoneAreaLabel.setAttribute('font-size', '10');
      zoneAreaLabel.setAttribute('pointer-events', 'none');
      zoneAreaLabel.textContent = `${(z.w * z.h).toFixed(1)} м² · ${z.w.toFixed(1)}×${z.h.toFixed(1)}`;
      zg.appendChild(zoneAreaLabel);
    }

    // Drag-move всей зоны
    rect.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      state.selectedZoneIdx = idx;
      rect.setPointerCapture(e.pointerId);
      const startX = e.clientX, startY = e.clientY;
      const initX = z.x, initY = z.y;
      const svgBB = svgEl.getBoundingClientRect();
      const domToViewport = W / svgBB.width;

      const onMove = (ev) => {
        const dxPx = (ev.clientX - startX) * domToViewport;
        const dyPx = (ev.clientY - startY) * domToViewport;
        let nx = initX + dxPx / scaleX;
        let ny = initY + dyPx / scaleY;
        // Клампим в комнату
        nx = Math.max(0, Math.min(room.length - z.w, nx));
        ny = Math.max(0, Math.min(room.width - z.h, ny));
        // Snap к сетке 0.1м (при нажатом Shift — 0.5м)
        const snap = ev.shiftKey ? 0.5 : 0.1;
        z.x = Math.round(nx / snap) * snap;
        z.y = Math.round(ny / snap) * snap;
        z.area_share = (z.w * z.h) / (room.length * room.width);
        // Пока указатель движется, смещаем существующую SVG-группу без
        // уничтожения DOM. Полный расчёт и render выполняются один раз в onUp.
        zg.setAttribute('transform', `translate(${m2pxX(z.x - initX)} ${m2pxY(z.y - initY)})`);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        recompute(); emit();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });

    // Ресайз-ручки (только для выделенной)
    if (isSelected) {
      // Не менее ~20 SVG-px на touch-устройствах: после адаптивного
      // масштабирования ручка остаётся пригодной для пальца.
      const handleSize = window.matchMedia?.('(pointer: coarse)')?.matches ? 22 : 10;
      const handles = [
        { key: 'nw', x: zx - handleSize/2, y: zy - handleSize/2, cursor: 'nwse-resize' },
        { key: 'ne', x: zx + zw - handleSize/2, y: zy - handleSize/2, cursor: 'nesw-resize' },
        { key: 'sw', x: zx - handleSize/2, y: zy + zh - handleSize/2, cursor: 'nesw-resize' },
        { key: 'se', x: zx + zw - handleSize/2, y: zy + zh - handleSize/2, cursor: 'nwse-resize' },
        { key: 'n', x: zx + zw/2 - handleSize/2, y: zy - handleSize/2, cursor: 'ns-resize' },
        { key: 's', x: zx + zw/2 - handleSize/2, y: zy + zh - handleSize/2, cursor: 'ns-resize' },
        { key: 'w', x: zx - handleSize/2, y: zy + zh/2 - handleSize/2, cursor: 'ew-resize' },
        { key: 'e', x: zx + zw - handleSize/2, y: zy + zh/2 - handleSize/2, cursor: 'ew-resize' },
      ];
      for (const h of handles) {
        const hr = document.createElementNS(svgNS, 'rect');
        hr.setAttribute('x', h.x); hr.setAttribute('y', h.y);
        hr.setAttribute('width', handleSize); hr.setAttribute('height', handleSize);
        hr.setAttribute('fill', '#4182f5');
        hr.setAttribute('stroke', '#fff');
        hr.setAttribute('stroke-width', '1.5');
        hr.setAttribute('rx', '2');
        hr.style.cursor = h.cursor;
        zg.appendChild(hr);

        hr.addEventListener('pointerdown', (e) => {
          e.preventDefault(); e.stopPropagation();
          hr.setPointerCapture(e.pointerId);
          const startX = e.clientX, startY = e.clientY;
          const init = { x: z.x, y: z.y, w: z.w, h: z.h };
          const svgBB = svgEl.getBoundingClientRect();
          const domToViewport = W / svgBB.width;

          const onMove = (ev) => {
            const dxM = (ev.clientX - startX) * domToViewport / scaleX;
            const dyM = (ev.clientY - startY) * domToViewport / scaleY;
            let nx = init.x, ny = init.y, nw = init.w, nh = init.h;
            const minSize = 0.3;
            // Обрабатываем каждый handle
            if (h.key.includes('w')) { nx = init.x + dxM; nw = init.w - dxM; }
            if (h.key.includes('e')) { nw = init.w + dxM; }
            if (h.key.includes('n')) { ny = init.y + dyM; nh = init.h - dyM; }
            if (h.key.includes('s')) { nh = init.h + dyM; }
            // Клампы: не меньше minSize, не выйти за комнату
            if (nw < minSize) { nw = minSize; nx = init.x + init.w - minSize; }
            if (nh < minSize) { nh = minSize; ny = init.y + init.h - minSize; }
            if (nx < 0) { nw += nx; nx = 0; }
            if (ny < 0) { nh += ny; ny = 0; }
            if (nx + nw > room.length) nw = room.length - nx;
            if (ny + nh > room.width) nh = room.width - ny;

            const snap = ev.shiftKey ? 0.5 : 0.1;
            z.x = Math.round(nx / snap) * snap;
            z.y = Math.round(ny / snap) * snap;
            z.w = Math.max(minSize, Math.round(nw / snap) * snap);
            z.h = Math.max(minSize, Math.round(nh / snap) * snap);
            z.area_share = (z.w * z.h) / (room.length * room.width);

            // Локальный preview без полного render/recompute на каждый pointermove.
            const nextX = padL + m2pxX(z.x);
            const nextY = padT + m2pxY(z.y);
            const nextW = m2pxX(z.w);
            const nextH = m2pxY(z.h);
            rect.setAttribute('x', nextX); rect.setAttribute('y', nextY);
            rect.setAttribute('width', nextW); rect.setAttribute('height', nextH);
            if (zoneLabel) {
              zoneLabel.setAttribute('x', nextX + nextW / 2);
              zoneLabel.setAttribute('y', nextY + nextH / 2 - 4);
            }
            if (zoneAreaLabel) {
              zoneAreaLabel.setAttribute('x', nextX + nextW / 2);
              zoneAreaLabel.setAttribute('y', nextY + nextH / 2 + 12);
              zoneAreaLabel.textContent = `${(z.w * z.h).toFixed(1)} м² · ${z.w.toFixed(1)}×${z.h.toFixed(1)}`;
            }
          };
          const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            recompute(); emit();
          };
          window.addEventListener('pointermove', onMove);
          window.addEventListener('pointerup', onUp);
          window.addEventListener('pointercancel', onUp);
        });
      }
    }
  });

  // Клик по пустому фону — снять выделение
  roomRect.addEventListener('click', () => {
    state.selectedZoneIdx = null;
    emit();
  });

  // Размеры комнаты (подпись)
  const dimTextBottom = document.createElementNS(svgNS, 'text');
  dimTextBottom.setAttribute('x', padL + drawW / 2);
  dimTextBottom.setAttribute('y', H - 10);
  dimTextBottom.setAttribute('text-anchor', 'middle');
  dimTextBottom.setAttribute('fill', '#737373');
  dimTextBottom.setAttribute('font-size', '11');
  dimTextBottom.setAttribute('font-weight', '600');
  dimTextBottom.textContent = `${room.length} м × ${room.width} м = ${(room.length * room.width).toFixed(1)} м²`;
  svgEl.appendChild(dimTextBottom);

  wrap.appendChild(svgEl);
  return wrap;
}

/** Автораскладка зон в grid */
function autoLayoutZones(project) {
  const room = project.room;
  const zones = project.zones;
  const n = zones.length;
  if (n === 0) return;
  // Раскладываем в 1 строку если <=3 зоны, иначе в 2 ряда
  const rows = n <= 3 ? 1 : 2;
  const cols = Math.ceil(n / rows);
  const cellW = room.length / cols;
  const cellH = room.width / rows;
  zones.forEach((z, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    z.x = col * cellW;
    z.y = row * cellH;
    z.w = cellW;
    z.h = cellH;
    z.area_share = (z.w * z.h) / (room.length * room.width);
  });
}

// --- Шаг 3: Система освещения ---

function renderStep3() {
  const container = document.getElementById('step-3');
  container.innerHTML = '';
  const s = state.project.system;

  container.appendChild(el('h2', {}, '⚡ Система освещения'));
  container.appendChild(el('p', { class: 'hint' },
    'Тип трека (48В магнитный или 220В однофазный), геометрия разводки, дополнительные опции.'));

  // Напряжение
  container.appendChild(el('div', { class: 'form-row' },
    el('label', { html: 'Тип системы' }),
    el('div', { class: 'radio-tabs' },
      el('input', { type: 'radio', name: 'v', id: 'v-48',
        checked: s.voltage_v === 48 ? '' : null,
        onChange: () => setSystem({ voltage_v: 48 }) }),
      el('label', { for: 'v-48' }, '48 В магнитный'),
      el('input', { type: 'radio', name: 'v', id: 'v-220',
        checked: s.voltage_v === 220 ? '' : null,
        onChange: () => setSystem({ voltage_v: 220 }) }),
      el('label', { for: 'v-220' }, '220 В однофазный'),
    ),
  ));

  // Цвет
  container.appendChild(el('div', { class: 'form-row' },
    el('label', { html: 'Цвет системы' }),
    el('div', { class: 'radio-tabs' },
      el('input', { type: 'radio', name: 'col', id: 'col-b',
        checked: s.color === 'black' ? '' : null,
        onChange: () => setSystem({ color: 'black' }) }),
      el('label', { for: 'col-b' }, 'Чёрный'),
      el('input', { type: 'radio', name: 'col', id: 'col-w',
        checked: s.color === 'white' ? '' : null,
        onChange: () => setSystem({ color: 'white' }) }),
      el('label', { for: 'col-w' }, 'Белый'),
    ),
  ));

  // Тип монтажа
  container.appendChild(el('div', { class: 'form-row' },
    el('label', { html: 'Тип монтажа шинопровода' }),
    el('div', { class: 'radio-tabs' },
      el('input', { type: 'radio', name: 'm', id: 'm-n',
        checked: s.mount === 'nakladnoi' ? '' : null,
        onChange: () => setSystem({ mount: 'nakladnoi' }) }),
      el('label', { for: 'm-n' }, 'Накладной/подвесной'),
      el('input', { type: 'radio', name: 'm', id: 'm-v',
        checked: s.mount === 'vstraivaemyy' ? '' : null,
        onChange: () => setSystem({ mount: 'vstraivaemyy' }) }),
      el('label', { for: 'm-v' }, 'Встраиваемый'),
    ),
  ));

  // Схема разводки трека
  container.appendChild(el('div', { class: 'form-row' },
    el('label', { html: 'Схема разводки трека' }),
    el('select', {
      onChange: (e) => { state.project.layout = e.target.value; recompute(); emit(); },
    }, ...state.db.presets.track_layouts.map(l => el('option',
      { value: l.id, selected: state.project.layout === l.id ? '' : null },
      `${l.title} — ${l.description}`))),
  ));

  // Разводка по зонам: если в проекте несколько зон — каждый трек строится
  // внутри своей зоны, а не через весь план.
  const hasMultipleZones = (state.project.zones || []).length > 1;
  container.appendChild(el('div', { class: 'form-row' },
    el('label', { html: 'Разводка по зонам' }),
    el('div', { class: 'radio-tabs' },
      el('input', { type: 'radio', name: 'zlayout', id: 'zl-whole',
        checked: s.zoneLayout === 'whole' ? '' : null,
        onChange: () => setSystem({ zoneLayout: 'whole' }) }),
      el('label', { for: 'zl-whole' }, 'Весь план'),
      el('input', { type: 'radio', name: 'zlayout', id: 'zl-zone',
        checked: s.zoneLayout !== 'whole' ? '' : null,
        onChange: () => setSystem({ zoneLayout: 'zone' }) }),
      el('label', { for: 'zl-zone' }, 'По каждой зоне'),
    ),
  ));
  if (hasMultipleZones) {
    container.appendChild(el('p', { class: 'hint zone-layout-hint' },
      s.zoneLayout === 'whole'
        ? '⚠️ Несколько зон, но выбран один трек через весь план. Рекомендуем «По каждой зоне», чтобы свет лёг в каждую функциональную зону.'
        : '✓ Несколько зон — разводка строится внутри каждой зоны.'));
  }

  // Токоподводы (питание): сколько питающих соединителей учесть в BOM.
  // Авто — 1 на трек; вручную можно задать больше (например, на длинных треках).
  container.appendChild(el('div', { class: 'form-row' },
    el('label', { html: 'Токоподводы (питание)' }),
    el('select', {
      onChange: (e) => {
        const v = e.target.value;
        if (v === 'auto') setSystem({ feedMode: 'auto' });
        else setSystem({ feedMode: 'manual', feeds: clampNum(parseInt(v, 10), 1, 12) });
      },
    },
      el('option', { value: 'auto', selected: s.feedMode !== 'manual' ? '' : null }, 'Авто (1 на трек)'),
      ...[1, 2, 3, 4, 6, 8].map(n => el('option',
        { value: String(n), selected: s.feedMode === 'manual' && s.feeds === n ? '' : null },
        `${n} шт`))),
  ));

  // Диммирование
  container.appendChild(el('div', { class: 'form-row' },
    el('label', { html: 'Диммирование' }),
    el('div', { class: 'radio-tabs' },
      el('input', { type: 'radio', name: 'dim', id: 'dim-y',
        checked: s.dimmable ? '' : null,
        onChange: () => setSystem({ dimmable: true }) }),
      el('label', { for: 'dim-y' }, 'Да'),
      el('input', { type: 'radio', name: 'dim', id: 'dim-n',
        checked: !s.dimmable ? '' : null,
        onChange: () => setSystem({ dimmable: false }) }),
      el('label', { for: 'dim-n' }, 'Нет'),
    ),
  ));

  // === Типы светильников и количество (встраиваемые + трековые) ===
  // Позволяет вручную задать, сколько светильников каждого типа света
  // использовать. Эти количества затем управляются в Редакторе плана.
  container.appendChild(el('h3', { class: 'mt-lg' }, '💡 Типы светильников и количество'));
  container.appendChild(el('p', { class: 'hint' },
    'Задайте, сколько встраиваемых и трековых светильников каждого типа света добавить. ' +
    '«Авто» — подбор по норме освещённости; «Вручную» — ровно указанные количества. ' +
    'Все значения далее можно менять в Редакторе плана.'));

  container.appendChild(el('div', { class: 'form-row' },
    el('label', { html: 'Режим количества' }),
    el('div', { class: 'radio-tabs' },
      el('input', { type: 'radio', name: 'ltmode', id: 'ltm-auto',
        checked: s.lightMode !== 'manual' ? '' : null,
        onChange: () => setSystem({ lightMode: 'auto' }) }),
      el('label', { for: 'ltm-auto' }, 'Авто'),
      el('input', { type: 'radio', name: 'ltmode', id: 'ltm-manual',
        checked: s.lightMode === 'manual' ? '' : null,
        onChange: () => setSystem({ lightMode: 'manual' }) }),
      el('label', { for: 'ltm-manual' }, 'Вручную'),
    ),
  ));

  const mix = s.lightMix || { downlight: {}, track: {} };
  const mixRow = (label, hint, category, typeIds, typeLabels) => {
    const row = el('div', { class: 'form-row' },
      el('label', { html: label }),
      el('div', { class: 'light-type-grid' },
        ...typeIds.map((id, i) => {
          const opt = typeLabels[id] || { label: id, icon: '•', desc: '' };
          const val = mix[category]?.[id] || 0;
          const change = (n) => {
            const next = { ...(s.lightMix || {}), [category]: { ...(mix[category] || {}), [id]: n } };
            setSystem({ lightMode: 'manual', lightMix: next });
          };
          return el('div', { class: 'light-type-cell', title: opt.desc },
            el('div', { class: 'light-type-head' },
              el('span', { class: 'light-type-icon' }, opt.icon),
              el('span', { class: 'light-type-name' }, opt.label),
            ),
            el('div', { class: 'light-type-qty' },
              el('button', { class: 'btn btn-sm btn-secondary', type: 'button',
                onClick: () => change(Math.max(0, val - 1)) }, '−'),
              el('span', { class: 'light-type-num' }, String(val)),
              el('button', { class: 'btn btn-sm btn-secondary', type: 'button',
                onClick: () => change(Math.min(50, val + 1)) }, '＋'),
            ),
          );
        }),
      ),
    );
    if (hint) row.appendChild(el('p', { class: 'hint light-type-hint' }, hint));
    return row;
  };

  const downTypes = {
    rasseivayushchiy: { label: 'Рассеивающий', icon: '◎', desc: 'Широкий мягкий рассеянный свет' },
    napravlennyy:     { label: 'Направленный', icon: '◉', desc: 'Узкий направленный пучок вниз' },
    fokus_lens:       { label: 'Фокус-линза', icon: '✺', desc: 'Очень узкий акцентный луч' },
    povorotnyy:       { label: 'Поворотный', icon: '↻', desc: 'Спот с наклоном и вращением' },
    staticheskiy:     { label: 'Статический', icon: '▪', desc: 'Фиксированная ориентация' },
  };
  container.appendChild(mixRow('Встраиваемые (натяжной потолок)',
    'Светильники с направленным вниз светом, для потолков с натяжным полотном.',
    'downlight', ['rasseivayushchiy', 'napravlennyy', 'fokus_lens', 'povorotnyy', 'staticheskiy'], downTypes));

  const trackTypes = {
    rasseivayushchiy: { label: 'Рассеивающий', icon: '◎', desc: 'Широкий мягкий свет' },
    napravlennyy:     { label: 'Направленный', icon: '◉', desc: 'Узкий направленный пучок' },
    fokus_lens:       { label: 'Фокус-линза', icon: '✺', desc: 'Узкий акцентный луч' },
    povorotnyy:       { label: 'Поворотный', icon: '↻', desc: 'Спот с наклоном и вращением' },
  };
  container.appendChild(mixRow('Трековые',
    'Светильники на треке — рассеивающие, направленные, фокус-линза, поворотные.',
    'track', ['rasseivayushchiy', 'napravlennyy', 'fokus_lens', 'povorotnyy'], trackTypes));

  container.appendChild(el('div', { class: 'actions' },
    el('button', { class: 'btn btn-secondary', onClick: () => setState({ step: 2 }) }, '← Назад'),
    el('button', { class: 'btn btn-primary', onClick: () => setState({ step: 4 }) }, 'Редактор →'),
  ));
}

// --- Шаг 4: Редактор плана (drag-and-drop) ---

/**
 * Шаг 4 — «Редактор плана». В теле мастера показывается landing-плашка
 * с кнопкой «Открыть редактор». По клику разворачивается fullscreen-overlay
 * с интерфейсом в стиле 3ds Max.
 */
function renderStepEditor() {
  const container = document.getElementById('step-4');
  if (!container) return;
  container.innerHTML = '';
  container.appendChild(el('h2', {}, '🎨 Редактор плана'));

  if (!state.db || !state.scene) {
    container.appendChild(el('div', { class: 'editor-placeholder' },
      'Заполните шаги 1–3 (габариты, зоны, система) — редактор появится здесь.'));
    container.appendChild(el('div', { class: 'actions' },
      el('button', { class: 'btn btn-secondary', onClick: () => setState({ step: 1 }) }, '← К шагу 1'),
    ));
    return;
  }

  // Landing-карточка: показывает мини-статистику и кнопку «Открыть»
  const stats = state.scene ? {
    tracks: state.scene.tracks.length,
    luminaires: state.scene.luminaires.length,
    price: state.result?.grand_total_rub || 0,
  } : null;

  container.appendChild(el('p', { class: 'hint' },
    'Интерактивный редактор в стиле 3ds Max с двумя режимами: точный план сверху и объёмная 3D-комната. ' +
    'Перетаскивайте светильники и трассы в любом виде, вращайте 3D-камеру — цена и спецификация обновляются мгновенно.'));

  const launcher = el('div', { class: 'editor-fullscreen-launcher', onClick: () => openEditor() },
    el('h3', {}, '🖥 Открыть редактор на весь экран'),
    stats && el('p', {}, `В сцене: ${stats.tracks} треков, ${stats.luminaires} светильников · Итого ${stats.price.toLocaleString('ru-RU')} ₽`),
    el('p', {}, 'Переключайтесь между 2D и 3D: колесо — масштаб, пустое место в 3D — вращение камеры, палитра — drag-and-drop.'),
    el('div', { class: 'cta' }, 'Открыть редактор →'),
  );
  container.appendChild(launcher);

  container.appendChild(el('div', { class: 'actions' },
    el('button', { class: 'btn btn-secondary', onClick: () => setState({ step: 3 }) }, '← Назад'),
    el('button', { class: 'btn btn-primary', onClick: () => goToResults() }, 'К результату →'),
  ));
}

/**
 * Открывает fullscreen-редактор (создаётся отдельный overlay-контейнер вне мастера).
 */
function openEditor() {
  if (!state.scene || !state.db) return;
  // Уже открыт?
  if (document.getElementById('editor-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'editor-overlay';
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';

  try {
    state.editorInstance = createEditor(overlay, {
      project: state.project,
      scene: state.scene,
      db: state.db,
      onSceneChange,
      onScenePreview,
      onClose: (finalScene) => closeEditor(finalScene),
      onSave: (payload) => saveLocalProject(payload),   // Ctrl+S
      computeFn: (scene) => Calc.computeFromScene(state.project, scene, state.db),
    });
  } catch (e) {
    console.error('Ошибка инициализации редактора:', e);
    // Показываем ошибку БЕЗОПАСНО: текст — через textContent (экранируется от XSS),
    // без inline-onclick (CSP-дружелюбно).
    overlay.innerHTML = '';
    const box = document.createElement('div');
    box.style.cssText = 'padding:40px;color:#ff5555;background:#2a2a2a;position:fixed;inset:0;font-family:sans-serif';
    const h = document.createElement('h2'); h.textContent = 'Ошибка редактора';
    const p = document.createElement('p'); p.textContent = String((e && e.message) || e);
    const btn = document.createElement('button');
    btn.textContent = 'Закрыть';
    btn.addEventListener('click', () => { overlay.remove(); document.body.style.overflow = ''; });
    box.appendChild(h); box.appendChild(p); box.appendChild(btn);
    overlay.appendChild(box);
  }
}

/**
 * Забирает последнюю сцену непосредственно из редактора и пересчитывает результат.
 * Нельзя полагаться только на промежуточные onSceneChange: последний drag/input
 * может завершиться непосредственно перед нажатием «Готово».
 */
function commitEditorScene(candidateScene = null) {
  let finalScene = candidateScene;
  if (!finalScene && state.editorInstance) {
    try { finalScene = state.editorInstance.getScene?.() || state.editorInstance.scene; }
    catch (e) { console.error('Не удалось получить финальную сцену редактора:', e); }
  }
  if (finalScene && Array.isArray(finalScene.tracks) && Array.isArray(finalScene.luminaires)) {
    state.scene = finalScene;
  }
  // Всегда пересчитываем перед результатом: это исключает показ устаревшего BOM,
  // даже если объект сцены остался той же ссылкой.
  recomputeFromScene();
  return state.scene;
}

function closeEditor(finalScene = null) {
  commitEditorScene(finalScene);
  if (state.editorInstance) {
    try { state.editorInstance.destroy && state.editorInstance.destroy(); } catch (e) {}
    state.editorInstance = null;
  }
  const overlay = document.getElementById('editor-overlay');
  if (overlay) overlay.remove();
  document.body.style.overflow = '';
  // Обновляем UI мастера уже после финального пересчёта сцены.
  emit();
}

function goToResults() {
  commitEditorScene();
  setState({ step: 5 });
}

// (updateEditorSummary удалён — statusbar внутри редактора сам обновляется через computeFn)

// --- Шаг 5: Результат ---

function renderStep5() {
  const container = document.getElementById('step-5');
  if (!container) return;
  // Последняя защитная точка: результат никогда не строится по кэшу до сцены.
  commitEditorScene();
  container.innerHTML = '';

  container.appendChild(el('h2', {}, '📊 Результат расчёта'));

  if (!state.result) {
    container.appendChild(el('p', { class: 'hint' }, 'Заполните предыдущие шаги — расчёт появится здесь.'));
    return;
  }

  const r = state.result;

  // 2D-визуализация
  container.appendChild(renderPlanCard(r));

  // Резюме
  const safetyValues = r.geometry.k_safety_values || [r.geometry.k_safety];
  const safetyLabel = safetyValues.length > 1
    ? `${Math.min(...safetyValues)}–${Math.max(...safetyValues)}`
    : String(safetyValues[0]);
  const integrityLabel = r.integrity?.valid ? '✓ проверены' : '⚠ требуют внимания';
  const summary = el('div', { class: 'result-card' },
    el('h3', {}, '📌 Резюме проекта'),
    el('div', { class: 'kv' },
      el('div', { class: 'k' }, 'Площадь помещения'),
      el('div', { class: 'v' }, `${r.geometry.area_m2} м²`),
      el('div', { class: 'k' }, 'Требуемый световой поток'),
      el('div', { class: 'v' }, `${r.lumens.totalLumens.toLocaleString('ru-RU')} лм`),
      el('div', { class: 'k' }, 'Индекс помещения (i)'),
      el('div', { class: 'v' }, `${r.geometry.room_index} (η=${r.geometry.eta}, k=${safetyLabel})`),
      el('div', { class: 'k' }, 'Финальная сцена'),
      el('div', { class: 'v' }, `${state.resultScene?.tracks.length || 0} трек. • ${state.resultScene?.luminaires.length || 0} свет.`),
      el('div', { class: 'k' }, 'Целостность данных'),
      el('div', { class: 'v' }, integrityLabel),
      el('div', { class: 'k' }, 'Светильники всего'),
      el('div', { class: 'v' }, `${r.totals_luminaires.qty} шт • ${r.totals_luminaires.power_w} Вт`),
      el('div', { class: 'k' }, 'Длина шинопровода'),
      el('div', { class: 'v' }, `${r.track.actual_length_m} м (нужно ${r.track.required_length_m} м)`),
      el('div', { class: 'k' }, 'Ток на линии / лимит'),
      el('div', { class: 'v', html: `${r.electrical.current_per_line_a} А / <strong>${r.electrical.limit_recommended} А</strong>` }),
    ),
  );
  container.appendChild(summary);

  // Warnings
  if (state.warnings.length > 0) {
    const wrap = el('div', { class: 'result-card' },
      el('h3', {}, '⚠️ Валидация и рекомендации'),
      el('div', { class: 'warnings' },
        ...state.warnings.map(w => el('div', { class: 'warning-item ' + w.level },
          el('div', { class: 'title' }, ({ error: '🔴 ', warning: '🟡 ', info: '🔵 ' })[w.level] + w.title),
          el('div', { class: 'message' }, w.message),
          w.fix && el('div', { class: 'fix' }, w.fix),
        )),
      ),
    );
    container.appendChild(wrap);
  }

  // BOM
  const bomWrap = el('div', { class: 'result-card' },
    el('h3', {}, '🧾 Спецификация (BOM)'),
    buildBomTable(r),
  );
  container.appendChild(bomWrap);

  // Actions
  container.appendChild(el('div', { class: 'actions' },
    el('button', { class: 'btn btn-secondary', onClick: () => setState({ step: 4 }) }, '← В редактор'),
    el('div', {},
      el('button', { class: 'btn btn-secondary', style: 'margin-right:8px',
        onClick: () => copyLink() }, '🔗 Ссылка на проект'),
      el('button', { class: 'btn btn-primary', onClick: (ev) => sendProjectToCart(ev) },
        `🛒 Добавить всё в корзину`),
    ),
  ));
}

// renderStep4 — алиас: старое имя ссылки на «результат» переведено в шаг 5.
// Оставляем совместимость: если что-то ещё вызывает renderStep4 — рендерим редактор.
function renderStep4() { renderStepEditor(); }

function renderPlanCard(r) {
  const opts = state.viewOptions;
  const finalScene = state.resultScene || state.scene || { tracks: [], luminaires: [] };
  const containerWidth = document.getElementById('main')?.clientWidth || 800;
  const sidePadding = containerWidth <= 600 ? 16 : 60;
  const planWidth = Math.max(280, Math.min(containerWidth - sidePadding, 900));

  const renderVisual = (width) => {
    if (opts.viewMode === '3d') {
      return R3D.renderScene3D(state.project, finalScene, state.db, {
        width,
        height: Math.max(340, Math.round(width * 0.62)),
        camera: opts.camera3d,
        showZones: opts.showZones,
        showGrid: true,
        showBeams: opts.showBeams,
        showDimensions: opts.showDimensions,
        showLegend: opts.showLegend,
      });
    }
    return R2D.renderFloorPlan(state.project, r, state.db, {
      width,
      showZones: opts.showZones,
      showBeams: opts.showBeams,
      showDimensions: opts.showDimensions,
      showLegend: opts.showLegend,
      scene: finalScene,
    });
  };

  const svgWrap = el('div', { class: `plan-wrap plan-wrap-${opts.viewMode}` });
  const svgEl = renderVisual(planWidth);
  svgWrap.appendChild(svgEl);

  // 3D-вид на странице результата: вращение камеры перетаскиванием (мышь
  // и тач). Раньше курсор показывал «grab», но перетаскивание не работало —
  // на мобильных пользователь вынужден был только тыкать кнопки.
  if (opts.viewMode === '3d') {
    let drag = null;
    const startCam = () => ({ yaw: opts.camera3d.yaw, pitch: opts.camera3d.pitch });
    const onPointerDown = (e) => {
      if (e.button !== 0 && e.pointerType !== 'touch') return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, cam: startCam() };
      svgWrap.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    };
    const onPointerMove = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      opts.camera3d.yaw = drag.cam.yaw + dx * 0.35;
      opts.camera3d.pitch = Math.max(12, Math.min(72, drag.cam.pitch + dy * 0.35));
      // Только обновляем svg, без полного перерендера всей страницы.
      const next = renderVisual(planWidth);
      svgWrap.replaceChild(next, svgWrap.firstChild);
    };
    const onPointerUp = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      try { svgWrap.releasePointerCapture?.(e.pointerId); } catch {}
      emit(); // фиксируем камеру в состоянии (для экспорта PNG/SVG)
    };
    svgWrap.addEventListener('pointerdown', onPointerDown);
    svgWrap.addEventListener('pointermove', onPointerMove);
    svgWrap.addEventListener('pointerup', onPointerUp);
    svgWrap.addEventListener('pointercancel', onPointerUp);
  }

  const toggle = (label, key) => el('label', { class: 'toggle' },
    el('input', {
      type: 'checkbox', checked: opts[key] ? '' : null,
      onChange: (event) => { opts[key] = event.target.checked; emit(); },
    }),
    ' ' + label,
  );
  const modeButton = (mode, label) => el('button', {
    class: `btn btn-sm ${opts.viewMode === mode ? 'btn-primary' : 'btn-secondary'}`,
    'data-result-view': mode,
    onClick: () => { opts.viewMode = mode; emit(); },
  }, label);
  const cameraButton = (label, title, yaw = 0, pitch = 0, zoom = 1) => el('button', {
    class: 'btn btn-secondary btn-sm', title,
    onClick: () => {
      opts.camera3d.yaw += yaw;
      opts.camera3d.pitch = Math.max(12, Math.min(72, opts.camera3d.pitch + pitch));
      opts.camera3d.zoom = Math.max(0.35, Math.min(4, opts.camera3d.zoom * zoom));
      emit();
    },
  }, label);

  const controls = el('div', { class: 'plan-controls' },
    modeButton('2d', '▦ Вид сверху'),
    modeButton('3d', '◇ 3D-вид'),
    toggle('Зоны', 'showZones'),
    toggle('Пятна света', 'showBeams'),
    toggle('Размеры', 'showDimensions'),
    toggle('Легенда', 'showLegend'),
    ...(opts.viewMode === '3d' ? [
      cameraButton('↶', 'Повернуть камеру влево', -15),
      cameraButton('↷', 'Повернуть камеру вправо', 15),
      cameraButton('↑', 'Поднять камеру', 0, 6),
      cameraButton('↓', 'Опустить камеру', 0, -6),
      cameraButton('＋', 'Приблизить', 0, 0, 1.2),
      cameraButton('−', 'Отдалить', 0, 0, 0.8),
    ] : []),
    el('span', { class: 'plan-controls-spacer' }),
    el('button', {
      class: 'btn btn-secondary btn-sm',
      onClick: () => {
        const visual = renderVisual(1200);
        if (opts.viewMode === '3d') R3D.downloadSvg(visual, `scene-3d-zima-${Date.now()}.svg`);
        else R2D.downloadSvg(visual, `plan-zima-${Date.now()}.svg`);
      },
    }, `↓ ${opts.viewMode === '3d' ? '3D ' : ''}SVG`),
    el('button', {
      class: 'btn btn-secondary btn-sm',
      onClick: async (event) => {
        const btn = event.currentTarget;
        const original = btn.textContent;
        let bigSvg = null;
        btn.textContent = 'Готовим...'; btn.disabled = true;
        try {
          bigSvg = renderVisual(1600);
          document.body.appendChild(bigSvg);
          bigSvg.style.position = 'absolute'; bigSvg.style.left = '-9999px';
          await R2D.downloadPng(bigSvg,
            `${opts.viewMode === '3d' ? 'scene-3d' : 'plan'}-zima-${Date.now()}.png`, 2);
        } catch (error) {
          alert('Ошибка экспорта PNG: ' + error.message);
        } finally {
          if (bigSvg?.isConnected) bigSvg.remove();
          btn.textContent = original; btn.disabled = false;
        }
      },
    }, '↓ PNG'),
  );

  const viewTitle = opts.viewMode === '3d'
    ? '🏠 3D-модель освещения'
    : '🗺️ План освещения (вид сверху)';
  const viewHint = opts.viewMode === '3d'
    ? `Финальная 3D-сцена: ${finalScene.tracks.length} трек. • ${finalScene.luminaires.length} свет. • вращайте камеру кнопками под моделью`
    : `Финальная сцена редактора: ${finalScene.tracks.length} трек. • ${finalScene.luminaires.length} свет. • позиции, модели и углы сохранены`;
  return el('div', { class: 'result-card' },
    el('h3', {}, viewTitle),
    el('p', { class: 'hint' }, viewHint),
    svgWrap,
    controls,
  );
}

function buildBomTable(r) {
  const rows = [];

  // Светильники
  for (const l of r.luminaires) {
    rows.push({
      name: l.luminaire.name,
      hint: `${l.zone.name} • ${l.luminaire.power_w}Вт • ${l.luminaire.lumen}лм • ${l.luminaire.beam_deg}°`,
      qty: l.qty,
      price: l.luminaire.price_rub,
      total: l.subtotal_price,
      url: l.luminaire.product_url,
    });
  }
  // Шинопровод
  for (const s of r.track.segments) {
    rows.push({
      name: s.product.name,
      hint: `Шинопровод ${s.product.length_m}м`,
      qty: s.qty,
      price: s.product.price_rub,
      total: (s.product.price_rub || 0) * s.qty,
      url: s.product.product_url,
    });
  }
  // Коннекторы
  for (const c of r.connectors.items) {
    rows.push({
      name: c.product.name,
      hint: c.purpose,
      qty: c.qty,
      price: c.product.price_rub,
      total: (c.product.price_rub || 0) * c.qty,
      url: c.product.product_url,
    });
  }
  // БП
  if (r.power_supply.product) {
    rows.push({
      name: r.power_supply.product.name,
      hint: `Требуется ${r.power_supply.required_w}Вт, покрывается ${r.power_supply.product.power_w * r.power_supply.qty}Вт`,
      qty: r.power_supply.qty,
      price: r.power_supply.product.price_rub,
      total: r.power_supply.price_rub,
      url: r.power_supply.product.product_url,
    });
  }

  const tbl = el('table', { class: 'bom-table' },
    el('thead', {}, el('tr', {},
      el('th', {}, 'Наименование'),
      el('th', { class: 'num' }, 'Кол-во'),
      el('th', { class: 'num' }, 'Цена'),
      el('th', { class: 'num' }, 'Сумма'),
    )),
    el('tbody', {}, ...rows.map(row => el('tr', {},
      el('td', { 'data-label': 'Товар' },
        el('a', { href: row.url, target: '_blank', rel: 'noopener' }, row.name),
        el('div', { class: 'zone-meta muted' }, row.hint),
      ),
      el('td', { class: 'num', 'data-label': 'Количество' }, String(row.qty)),
      el('td', { class: 'num', 'data-label': 'Цена' }, fmtRub(row.price)),
      el('td', { class: 'num', 'data-label': 'Сумма' }, fmtRub(row.total)),
    ))),
    el('tfoot', {}, el('tr', {},
      el('td', { colspan: '3', class: 'text-right' }, 'ИТОГО:'),
      el('td', { class: 'num grand', 'data-label': 'Итого' }, fmtRub(r.grand_total_rub)),
    )),
  );

  return tbl;
}

async function buildShareUrl() {
  const compact = Share.buildShareData(state.project, state.scene);
  const encoded = await Share.encodeSharePayload(compact);
  // Самопроверка: закодировали → декодировали → должно совпасть байт-в-байт.
  // Это гарантия, что ссылка восстановится у получателя (никаких «битых»
  // ссылок из-за окружения отправителя).
  const back = await Share.decodeSharePayload(encoded);
  if (JSON.stringify(back) !== JSON.stringify(compact)) {
    throw new Error('Самопроверка ссылки не прошла');
  }
  // Короткая ссылка через API рейтинга (#s=ID): регистрируем шеринг и получаем
  // ID. Это и статистика для «Топ-12», и удобная короткая ссылка. Если API
  // недоступен — безотказный вариант #p=… (payload целиком в hash).
  const reg = await Share.apiRegisterShare(encoded);
  if (reg) return location.origin + location.pathname + '#s=' + reg.id;
  // Payload — в hash-фрагменте: сервер его не видит, страница всегда 200.
  return location.origin + location.pathname + '#p=' + encoded;
}

async function copyLink() {
  let url;
  try {
    url = await buildShareUrl();
  } catch (e) {
    console.error('[app] Не удалось построить ссылку на проект:', e);
    alert('Не удалось построить ссылку на проект. Попробуйте ещё раз или сохраните проект (Ctrl+S).');
    return;
  }
  if (!navigator.clipboard?.writeText) {
    prompt('Скопируйте ссылку вручную:', url);
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    alert('Ссылка скопирована! Открывший увидит тот же проект и расстановку.');
  } catch {
    prompt('Скопируйте ссылку вручную:', url);
  }
}

/**
 * Сохранение проекта + сцены по Ctrl+S.
 * Кладём в localStorage (браузер пользователя) — переживает перезагрузку.
 * Также обновляет versioned-ссылку проекта, чтобы её можно было отправить клиенту.
 */
function saveLocalProject(payload) {
  const key = 'zlc_saved_project';
  let ok = false;

  // Ctrl+S приходит непосредственно из редактора и несёт его самую свежую
  // сцену. Сначала синхронизируем её, затем строим localStorage/share payload.
  if (payload?.scene && Array.isArray(payload.scene.tracks) && Array.isArray(payload.scene.luminaires)) {
    state.scene = payload.scene;
    recomputeFromScene();
  }

  try {
    // Сохраняем и проект, и сцену, и время
    localStorage.setItem(key, JSON.stringify({
      saved_at: payload?.saved_at || new Date().toISOString(),
      project: payload?.project || state.project,
      scene: state.scene,
    }));
    ok = true;
  } catch (e) {
    console.warn('[app] Не удалось записать localStorage:', e);
  }

  // Обновляем кликабельную ссылку проекта в том же versioned-формате,
  // который использует кнопка «Ссылка на проект».
  buildShareUrl()
    .then(url => { window.__zlc_lastSaveUrl = url; })
    .catch(e => { /* не критично */ });

  if (ok) console.info('[app] Проект сохранён (localStorage).');
  return ok;
}

/** Восстановление ранее сохранённого проекта (для кнопки в UI, если понадобится) */
function loadLocalProject() {
  try {
    const raw = localStorage.getItem('zlc_saved_project');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { return null; }
}

/** Публичный API для отладки/проверки сохранения */
window.__zlc_saveLocalProject = saveLocalProject;
window.__zlc_loadLocalProject = loadLocalProject;

/** Добавляет всю спецификацию проекта в корзину сайта и открывает /cart/ */
async function sendProjectToCart(ev) {
  if (!state.result) return;
  const items = collectCartItems(state.result);
  if (items.length === 0) { alert('Нечего добавить в корзину'); return; }

  const totalQty = items.reduce((s, i) => s + i.qty, 0);
  if (!confirm(`Добавить в корзину сайта zima-led.ru:\n${items.length} позиций / ${totalQty} шт?\n\nПосле добавления откроется страница корзины.`)) return;

  const btn = ev?.target;
  const orig = btn?.textContent;
  if (btn) { btn.textContent = '⏳ Добавляем...'; btn.disabled = true; }

  const result = await addToSiteCart(items);
  if (btn) { btn.textContent = orig; btn.disabled = false; }

  if (result.added === 0) {
    alert(`Не удалось добавить в корзину.\n${result.error || 'Проверьте, что вы на сайте zima-led.ru'}`);
    return;
  }
  const failMsg = result.failed.length > 0 ? `\n(Пропущено: ${result.failed.length} позиций)` : '';
  alert(`✓ В корзину добавлено: ${result.added} шт.${failMsg}\nОткрываем корзину...`);
  openSiteCart();
}

/** Собирает список позиций для корзины из результата расчёта */
function collectCartItems(r) {
  const items = [];
  for (const l of r.luminaires) {
    if (l.luminaire.x5_id) items.push({ x5_id: l.luminaire.x5_id, slug: l.luminaire.slug, qty: l.qty, name: l.luminaire.name });
  }
  for (const s of r.track.segments) {
    if (s.product.x5_id) items.push({ x5_id: s.product.x5_id, slug: s.product.slug, qty: s.qty, name: s.product.name });
  }
  for (const c of r.connectors.items) {
    if (c.product.x5_id) items.push({ x5_id: c.product.x5_id, slug: c.product.slug, qty: c.qty, name: c.product.name });
  }
  if (r.power_supply.product?.x5_id) {
    items.push({ x5_id: r.power_supply.product.x5_id, slug: r.power_supply.product.slug, qty: r.power_supply.qty, name: r.power_supply.product.name });
  }
  return items;
}

/** Публичная API — вызывается из редактора для добавления ОДНОГО товара */
window.__zlc_addOneToCart = async function(product) {
  if (!product?.x5_id) return false;
  const result = await addToSiteCart([{ x5_id: product.x5_id, slug: product.slug, qty: 1, name: product.name }]);
  return result.added > 0;
};

// Восстановление проекта из URL.
// Читает форматы (в порядке приоритета):
//   #s=ID — короткая ссылка через API рейтинга (payload на сервере);
//   #p=…  — самодостаточная ссылка (payload в hash, сервер не нужен);
//   ?p=…  — легаси-ссылки старых версий (продолжают открываться).
function readShareParam() {
  try {
    const hash = location.hash.replace(/^#/, '');
    if (hash) {
      const params = new URLSearchParams(hash);
      const s = params.get('s');
      if (s && /^[A-Za-z0-9_-]{6,16}$/.test(s)) return { kind: 's', value: s };
      const p = params.get('p');
      if (p) return { kind: 'p', value: p };
    }
  } catch { /* повреждённый hash — пробуем легаси-query */ }
  const legacy = new URLSearchParams(location.search).get('p');
  return legacy ? { kind: 'p', value: legacy } : null;
}

async function tryRestoreFromURL() {
  const param = readShareParam();
  if (!param) return false;
  try {
    let encoded;
    if (param.kind === 's') {
      // Короткая ссылка: payload живёт на сервере (заодно это событие «открытие»).
      // API недоступен — показываем чистый мастер, без падений.
      const shared = await Share.apiFetchShare(param.value);
      encoded = shared.payload;
    } else {
      encoded = param.value;
    }
    if (encoded.length > 400_000) throw new Error('Ссылка проекта слишком большая');
    const decoded = await Share.decodeSharePayload(encoded);
    return applyRestoredDecoded(decoded);
  } catch (e) {
    console.warn('Не удалось восстановить проект из URL:', e);
    return false;
  }
}

/**
 * Применяет ДЕКОДИРОВАННЫЙ payload ссылки к состоянию (общий путь для
 * восстановления из URL и открытия проекта из витрины «Топ-12»).
 * Вся валидация — белые списки + клампы, вводу из ссылки/сервера не доверяем.
 */
function applyRestoredDecoded(decoded) {
  try {
    // v3 — компактный формат: разворачиваем в полную структуру.
    // version 2 хранит {project, scene}; старые ссылки содержали project напрямую.
    const isV3 = decoded && decoded.v === 3;
    const expanded = isV3 ? Share.expandShareData(decoded) : null;
    const parsed = isV3 ? expanded.project : (decoded?.project || decoded);
    const sharedScene = isV3 ? expanded.scene : (decoded?.scene || null);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Некорректный формат проекта');
    }

    // Валидация структуры — не доверяем произвольному вводу из URL.
    if (parsed.room && typeof parsed.room.length === 'number') {
      const room = parsed.room;
      state.project.room = {
        length: clampNum(room.length, 1, 20),
        width: clampNum(room.width ?? state.project.room.width, 1, 20),
        height: clampNum(room.height ?? state.project.room.height, 2, 5),
        shape: validEnum(room.shape, ['rect'], 'rect'),
        ceiling: validEnum(room.ceiling,
          ['gkl', 'natjazh', 'beton', 'armstrong', 'reechnyy'], 'gkl'),
      };
    }
    if (parsed.system) {
      const sys = parsed.system;
      state.project.system = {
        ...state.project.system,
        voltage_v: sys.voltage_v === 220 ? 220 : 48,
        color: validEnum(sys.color, ['black', 'white'], 'black'),
        mount: validEnum(sys.mount, ['nakladnoi', 'vstraivaemyy'], 'nakladnoi'),
        dimmable: !!sys.dimmable,
        // Новые поля с защитой от мусора из ссылки
        feedMode: validEnum(sys.feedMode, ['auto', 'manual'], 'auto'),
        feeds: clampNum(parseInt(sys.feeds, 10) || 1, 1, 12),
        zoneLayout: validEnum(sys.zoneLayout, ['whole', 'zone'], 'zone'),
        // Ручной режим типов светильников: lightMode белым списком, lightMix —
        // только допустимые типы с клампом количества 0..50.
        lightMode: validEnum(sys.lightMode, ['auto', 'manual'], 'auto'),
        lightMix: sanitizeLightMix(sys.lightMix),
      };
    }
    if (Array.isArray(parsed.zones)) {
      const allowedZoneIds = new Set(state.db.norms.zones.map(z => z.id));
      state.project.zones = parsed.zones
        .filter(z => z && typeof z === 'object' && allowedZoneIds.has(z.zone_id))
        .slice(0, 30)
        .map(z => ({
          zone_id: z.zone_id,
          cct_k: clampNum(z.cct_k, 2700, 6500),
          area_share: clampNum(z.area_share, 0.05, 1),
          x: Number.isFinite(z.x) ? z.x : 0,
          y: Number.isFinite(z.y) ? z.y : 0,
          w: Number.isFinite(z.w) ? z.w : 1,
          h: Number.isFinite(z.h) ? z.h : 1,
        }));
      ensureZoneCoords(state.project);
    }
    const allowedPresetIds = state.db.presets.presets.map(preset => preset.id);
    state.project.presetId = validEnum(parsed.presetId, allowedPresetIds, null);
    const allowedLayouts = state.db.presets.track_layouts.map(layout => layout.id);
    state.project.layout = validEnum(parsed.layout, allowedLayouts, 'line_center');

    state.scene = sanitizeSharedScene(sharedScene, state.project, state.db);
    state.step = state.project.zones.length > 0 ? 4 : 1;
    return !!state.scene;
  } catch (e) {
    console.warn('Не удалось восстановить проект:', e);
    return false;
  }
}

// ============================================================
// Витрина «🏆 Популярные проекты» (Топ-12 по звёздам)
// ============================================================

/**
 * Самопроба API + загрузка топа + декодирование payload карточек.
 * Никогда не бросает и не мешает мастеру.
 */
async function initGallery() {
  const ok = await Share.apiProbe();
  if (!ok) {
    state.gallery = { status: 'off', items: [] };
    if (state.step === 1) emit();
    return;
  }
  try {
    const items = (await Share.apiTop(12)).slice(0, 12);
    // Декодируем payload заранее (async deflate) — рендер карточек синхронный.
    await Promise.all(items.map(async (item) => {
      try {
        item._expanded = Share.expandShareData(await Share.decodeSharePayload(item.p));
      } catch { item._expanded = null; }
    }));
    const usable = items.filter(i => i._expanded && i._expanded.project?.room);
    state.gallery = { status: usable.length > 0 ? 'on' : 'off', items: usable };
  } catch (e) {
    console.warn('[app] Не удалось загрузить топ проектов:', e);
    state.gallery = { status: 'off', items: [] };
  }
  if (state.step === 1) emit();
}

/**
 * Мини-план проекта для карточки: лёгкий SVG — комната, треки и точки
 * светильников. Только числа из payload, прошедшего валидацию.
 */
function galleryMiniPlanSvg(expanded) {
  const room = expanded.project.room;
  const W = Math.max(1, room.length), H = Math.max(1, room.width);
  const m = Math.min(W, H); // базовая единица толщин
  const esc = (s) => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const parts = [
    `<rect x="0" y="0" width="${(+W).toFixed(2)}" height="${(+H).toFixed(2)}" rx="${(m * 0.03).toFixed(3)}" fill="#f8fafc" stroke="#94a3b8" stroke-width="${(m * 0.014).toFixed(3)}"/>`,
  ];
  for (const tr of expanded.scene?.tracks || []) {
    const pts = (tr.points || []).map(p => `${(+p.x).toFixed(2)},${(+p.y).toFixed(2)}`).join(' ');
    if (pts) parts.push(`<polyline points="${esc(pts)}" fill="none" stroke="#475569" stroke-width="${(m * 0.022).toFixed(3)}" stroke-linecap="round" stroke-linejoin="round"/>`);
  }
  const r = m * 0.034;
  for (const lum of expanded.scene?.luminaires || []) {
    parts.push(`<circle cx="${(+lum.x).toFixed(2)}" cy="${(+lum.y).toFixed(2)}" r="${r.toFixed(3)}" fill="${lum.lightType === 'fokus_lens' ? '#f59e0b' : '#fbbf24'}" stroke="#b45309" stroke-width="${(r * 0.22).toFixed(3)}"/>`);
  }
  return `<svg class="tp-plan" viewBox="${(-W * 0.05).toFixed(2)} ${(-H * 0.05).toFixed(2)} ${(W * 1.1).toFixed(2)} ${(H * 1.1).toFixed(2)}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="План проекта">${parts.join('')}</svg>`;
}

/** Короткое описание проекта для карточки. */
function galleryCardTitle(expanded) {
  const room = expanded.project.room;
  const area = Math.round(room.length * room.width);
  const lums = (expanded.scene?.luminaires || []).length;
  const zoneCount = expanded.project.zones.length;
  const zoneWord = zoneCount <= 1 ? '1 зона' : `${zoneCount} зоны`;
  return `${area} м² · ${zoneWord} · ${lums} светильников`;
}

/** Смета проекта карточки — реальным движком (12 × мс, не блокирует UI). */
function galleryCardBudget(expanded) {
  try {
    const clean = sanitizeSharedScene(expanded.scene, expanded.project, state.db);
    if (!clean) return null;
    const res = Calc.computeFromScene(expanded.project, clean, state.db);
    return Number.isFinite(res.grand_total_rub) ? res.grand_total_rub : null;
  } catch { return null; }
}

function galleryStatsLine(item) {
  const votes = item.votes || 0;
  const stars = (item.stars || 0).toFixed(1);
  const opens = item.opens || 0;
  const shares = item.shares || 0;
  return `★ ${stars} · ${votes} голос(ов) · ${shares} шеринг(ов) · ${opens} открытий` + (item.fresh ? ' · 🆕' : '');
}

function galleryStarsRow(item) {
  const mine = Share.getMyVotes()[item.id] || 0;
  const wrap = el('div', { class: 'tp-stars', role: 'group', 'aria-label': 'Ваша оценка проекта' });
  const fill = (upto, cls) => {
    wrap.querySelectorAll('.tp-star').forEach((s, i) => {
      s.classList.toggle(cls, i < upto);
    });
  };
  for (let n = 1; n <= 5; n++) {
    const star = el('button', {
      type: 'button',
      class: 'tp-star' + (n <= mine ? ' mine' : '') + (n <= Math.round(item.stars || 0) && !mine ? ' filled' : ''),
      title: `Оценить на ${n} из 5`,
      'aria-label': `Оценить на ${n} из 5`,
    }, '★');
    star.addEventListener('mouseenter', () => fill(n, 'preview'));
    star.addEventListener('mouseleave', () => fill(0, 'preview'));
    star.addEventListener('click', () => voteGalleryProject(item, n, wrap));
    wrap.appendChild(star);
  }
  return wrap;
}

async function voteGalleryProject(item, stars, wrap) {
  const prev = Share.getMyVotes()[item.id] || 0;
  if (prev === stars) return; // тот же клик по своей оценке — ничего не делаем
  const res = await Share.apiVote(item.id, stars);
  if (!res) {
    alert('Не удалось отправить оценку. Попробуйте позже.');
    return;
  }
  Share.setMyVote(item.id, stars);
  item.stars = res.avg;
  item.votes = res.count;
  // Обновляем карточку на месте, без полной перерисовки мастера
  const card = wrap.closest('.tp-card');
  if (card) {
    const stats = card.querySelector('.tp-stats');
    if (stats) stats.textContent = galleryStatsLine(item);
    const starsRow = card.querySelector('.tp-stars');
    if (starsRow) starsRow.replaceWith(galleryStarsRow(item));
  }
}

/** Открыть проект из витрины: тот же путь валидации, что и переход по ссылке. */
async function openGalleryProject(item) {
  let decoded;
  try {
    decoded = await Share.decodeSharePayload(item.p);
  } catch (e) {
    console.warn('[app] битый payload в топе:', e);
    return;
  }
  const applied = applyRestoredDecoded(decoded);
  if (applied) {
    state.autoResult = Calc.computeProject(state.project, state.db);
    recomputeFromScene();
    emit();
    // Считаем открытие (fire-and-forget)
    Share.apiFetchShare(item.id).catch(() => {});
    try { document.getElementById('step-1')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch { /* опционально */ }
  }
}

/** Рендер секции «Топ-12» (вызывается из renderStep1 под сеткой пресетов). */
function renderTopGallery() {
  if (state.gallery.status !== 'on') return null;
  const section = el('section', { class: 'top-projects', 'aria-label': 'Популярные проекты пользователей' },
    el('h3', { class: 'mt-lg' }, '🏆 Популярные проекты'),
    el('p', { class: 'hint' }, 'Этими проектами поделились посетители калькулятора. Откройте понравившийся или поставьте свою оценку — звёзды формируют рейтинг.'),
  );
  const grid = el('div', { class: 'tp-grid' });
  state.gallery.items.forEach((item, idx) => {
    const exp = item._expanded;
    const budget = galleryCardBudget(exp);
    const planHost = el('div', { class: 'tp-plan-host' });
    planHost.innerHTML = galleryMiniPlanSvg(exp); // только сгенерированный нами SVG
    const card = el('article', { class: 'tp-card', 'data-share-id': item.id },
      el('div', { class: 'tp-rank' }, ['🥇', '🥈', '🥉'][idx] || `${idx + 1}`),
      planHost,
      el('div', { class: 'tp-title' }, galleryCardTitle(exp)),
      el('div', { class: 'tp-budget' }, budget ? `≈ ${fmtRub(budget)}` : 'Смета считается…'),
      el('div', { class: 'tp-stats' }, galleryStatsLine(item)),
      galleryStarsRow(item),
      el('button', { class: 'btn btn-secondary tp-open', onClick: () => openGalleryProject(item) }, 'Открыть проект'),
    );
    grid.appendChild(card);
  });
  section.appendChild(grid);
  return section;
}

/** Строгая нормализация сцены из недоверенной ссылки. */
function sanitizeSharedScene(rawScene, project, db) {
  if (!rawScene || !Array.isArray(rawScene.tracks) || !Array.isArray(rawScene.luminaires)) return null;
  const room = project.room;
  const trackIdMap = new Map();
  const tracks = [];

  for (const [index, rawTrack] of rawScene.tracks.slice(0, 100).entries()) {
    if (!rawTrack || !Array.isArray(rawTrack.points)) continue;
    const points = rawTrack.points.slice(0, 100)
      .filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y))
      .map(p => ({
        x: clampNum(p.x, 0, room.length),
        y: clampNum(p.y, 0, room.width),
      }));
    if (points.length < 2) continue;
    const id = `shared_trk_${index + 1}`;
    if (typeof rawTrack.id === 'string') trackIdMap.set(rawTrack.id, id);
    tracks.push({
      id,
      points,
      voltage_v: project.system.voltage_v,
      color: project.system.color,
      mount: project.system.mount,
      pinned: true,
    });
  }

  const productsBySlug = new Map(db.catalog.map(product => [product.slug, product]));
  const luminaires = [];
  for (const [index, rawLum] of rawScene.luminaires.slice(0, 500).entries()) {
    if (!rawLum || !productsBySlug.has(rawLum.slug) ||
        !Number.isFinite(rawLum.x) || !Number.isFinite(rawLum.y)) continue;
    const mappedTrackId = typeof rawLum.on_track_id === 'string'
      ? trackIdMap.get(rawLum.on_track_id) || null
      : null;
    const lumObj = {
      id: `shared_lum_${index + 1}`,
      x: clampNum(rawLum.x, 0, room.length),
      y: clampNum(rawLum.y, 0, room.width),
      angle_deg: clampNum(rawLum.angle_deg ?? 90, -180, 360),
      slug: rawLum.slug,
      on_track_id: mappedTrackId,
      t: mappedTrackId && Number.isFinite(rawLum.t) ? clampNum(rawLum.t, 0, 1) : null,
      pinned: true,
    };
    // Пользовательский override типа света — только из белого списка (безопасно).
    if (['rasseivayushchiy', 'napravlennyy', 'fokus_lens', 'povorotnyy', 'staticheskiy'].includes(rawLum.lightType)) {
      lumObj.lightType = rawLum.lightType;
    }
    luminaires.push(lumObj);
  }

  return { tracks, luminaires, version: 1 };
}

/** Ограничивает число в диапазон [min, max], с защитой от NaN/Infinity */
function clampNum(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}
/** Проверка значения по белому списку, иначе — дефолт */
function validEnum(v, allowed, def) {
  return allowed.includes(v) ? v : def;
}

/** Безопасная нормализация lightMix из недоверенной ссылки (белый список + кламп). */
function sanitizeLightMix(mix) {
  const downTypes = ['rasseivayushchiy', 'napravlennyy', 'fokus_lens', 'povorotnyy', 'staticheskiy'];
  const trackTypes = ['rasseivayushchiy', 'napravlennyy', 'fokus_lens', 'povorotnyy'];
  const clean = (src, ids) => {
    const out = {};
    for (const id of ids) {
      out[id] = clampNum(Number.parseInt(src?.[id], 10) || 0, 0, 50);
    }
    return out;
  };
  return {
    downlight: clean(mix?.downlight, downTypes),
    track: clean(mix?.track, trackTypes),
  };
}

// ============================================================
// Главный рендер
// ============================================================

function render() {
  if (!state.db) {
    document.getElementById('main').innerHTML =
      '<div style="padding:60px;text-align:center;"><div class="loader"></div><p class="muted">Загрузка каталога zima-led.ru...</p></div>';
    return;
  }
  renderSteps();
  updateCatalogBadge();
  ['1', '2', '3', '4', '5'].forEach(n => {
    const el = document.getElementById('step-' + n);
    if (el) el.classList.toggle('active', String(state.step) === n);
  });
  // Строим только видимый шаг. Раньше любое изменение пересоздавало DOM всех
  // пяти экранов, включая тяжёлый SVG результата и скрытый редактор зон.
  const renderActiveStep = {
    1: renderStep1,
    2: renderStep2,
    3: renderStep3,
    4: renderStepEditor,
    5: renderStep5,
  }[state.step];
  if (renderActiveStep) renderActiveStep();
}

/** Обновление шапки-бейджа: показывает число товаров и источник */
function updateCatalogBadge() {
  const badge = document.getElementById('zlc-catalog-badge');
  if (!badge || !state.catalogMeta) return;
  const m = state.catalogMeta;
  let icon, title, text;
  if (m.from_fallback) {
    icon = '⚠️'; text = `${m.products_count} товаров (offline)`;
    title = 'Каталог из аварийной копии — /cart/x5cart.js недоступен';
  } else if (m.from_cache) {
    icon = '💾'; text = `${m.products_count} товаров · ${m.cache_age_min} мин назад`;
    title = 'Кэш обновляется каждый час автоматически. Клик — обновить сейчас.';
  } else {
    icon = '🟢'; text = `${m.products_count} товаров · live`;
    title = 'Каталог загружен из /cart/x5cart.js. Клик — принудительно обновить.';
  }
  badge.textContent = icon + ' ' + text;
  badge.title = title;
  badge.style.cursor = 'pointer';
  // Клик — реинит каталога
  badge.onclick = async () => {
    badge.textContent = '⏳ Обновление...';
    const msg = await window.__zlc_reloadCatalog();
    badge.textContent = msg;
    setTimeout(() => updateCatalogBadge(), 2000);
  };
}

// ============================================================
// Инициализация
// ============================================================

async function init() {
  subscribe(render);
  await loadData();
  const restoredScene = await tryRestoreFromURL();
  if (restoredScene) {
    // Не прогоняем расстановку из ссылки через reconcileScene(): ссылка должна
    // открыть ровно ту сцену и BOM, которые отправил пользователь.
    state.autoResult = Calc.computeProject(state.project, state.db);
    recomputeFromScene();
  } else {
    recompute();
  }
  emit();
  // Витрина «Топ-12»: самопроба API + загрузка топа. Не блокирует старт
  // мастера: блок появится позже через emit(), либо не появится вовсе.
  initGallery();
}

init().catch(e => {
  console.error(e);
  const main = document.getElementById('main');
  if (!main) return;
  main.innerHTML = '';
  const box = document.createElement('div');
  box.style.cssText = 'padding:40px;color:#f87171;';
  box.append('Ошибка загрузки: ', document.createTextNode(String(e?.message || e)));
  main.appendChild(box);
});

// Экспорт для отладки в devtools
window.__zima = { state, Calc, Val };
