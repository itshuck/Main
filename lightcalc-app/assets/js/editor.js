/**
 * editor.js — интерактивный редактор плана освещения в стиле 3ds Max.
 *
 * Компоновка (fullscreen overlay):
 *   ┌─────────────────────────────────────────────────────┐
 *   │  TOPBAR  (меню, «Готово»)                           │
 *   ├─────────────────────────────────────────────────────┤
 *   │  TOOLBAR (тумблеры вьюпорта, кнопки режимов)        │
 *   ├────────┬────────────────────────────┬───────────────┤
 *   │        │                            │               │
 *   │ LEFT   │        VIEWPORT            │   RIGHT       │
 *   │ DOCK   │        (SVG canvas)        │   DOCK        │
 *   │        │                            │   (props +    │
 *   │ palette│                            │    rollouts)  │
 *   │        │                            │               │
 *   ├────────┴────────────────────────────┴───────────────┤
 *   │  STATUSBAR (метрики + цена)                         │
 *   └─────────────────────────────────────────────────────┘
 *
 * Механика:
 *   - drag из палитры → добавление на план (drop → snap к треку)
 *   - drag светильника по плану → магнитно катится по треку
 *   - drag конца трека → растягивание
 *   - колесо мыши → zoom вьюпорта
 *   - средняя кнопка мыши (или Space+drag) → pan
 *   - клик по объекту → выделение, Del — удалить, стрелки — точное позиционирование
 */

import * as Scene from './scene.js?v=20260826-ui14';
import * as R3D from './render3d.js?v=20260826-ui14';
import { getCCT, getBeamShape, inferLuminaireType, getRotationLimits, CCT_LIST, LIGHT_TYPE_OPTIONS, getLightTypeOption, resolveBeamType } from './cct.js';
import { makeIlluminanceFunction, buildIlluminanceGrid, lxToHeatColor, pickNormLx } from './illuminance.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/* Палитра цветов для SVG-объектов внутри вьюпорта */
const VP = {
  bg:          '#1c1c1c',
  floor:       '#242424',
  grid:        '#2f2f2f',
  gridStrong:  '#3a3a3a',
  wall:        '#4a4a4a',
  track:       '#5aa9dd',
  trackPinned: '#00d4ff',
  trackSel:    '#00d4ff',
  trackShadow: 'rgba(90,169,221,0.25)',
  luminaire:   '#ffb547',
  luminairePin:'#ff9033',
  luminaireSel:'#ffff00',
  beam:        'rgba(255,181,71,0.28)',
  psu:         '#ff5555',
  handle:      '#00d4ff',
  handleHot:   '#7cf0ff',
  ghost:       'rgba(0,212,255,0.4)',
  zone:        ['rgba(0,212,255,0.06)', 'rgba(255,181,71,0.06)', 'rgba(126,201,126,0.06)', 'rgba(255,85,85,0.06)', 'rgba(168,85,247,0.06)'],
  zoneStroke:  ['rgba(0,212,255,0.4)', 'rgba(255,181,71,0.4)', 'rgba(126,201,126,0.4)', 'rgba(255,85,85,0.4)', 'rgba(168,85,247,0.4)'],
};

function svgEl(tag, attrs = {}, kids = []) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    el.setAttribute(k, String(v));
  }
  for (const c of (Array.isArray(kids) ? kids : [kids])) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v != null && v !== false) e.setAttribute(k, String(v));
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    // Числовые значения (например, количество точек/светильников трека)
    // тоже являются текстом. Передача number напрямую в appendChild роняла
    // панель свойств и прерывала синхронизацию трассы с итоговой сценой.
    e.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

// ============================================================
// Публичное API
// ============================================================
export function createEditor(container, opts) {
  const ed = new Editor(container, opts);
  ed.mount();
  return ed;
}

// Экспортируем класс — для тестов конструирования без DOM-вызовов mount().
export { Editor };

// ============================================================
// Класс Editor
// ============================================================
class Editor {
  constructor(container, { project, scene, db, onSceneChange, onScenePreview, onClose, onSave, computeFn }) {
    if (!scene || !scene.tracks || !scene.luminaires)
      throw new Error('Editor: scene должна содержать tracks и luminaires');
    if (!project?.room || !project?.system)
      throw new Error('Editor: project должен содержать room и system');
    if (!db?.catalog) throw new Error('Editor: db должен содержать catalog');

    this.container = container;
    this.project = project;
    this.scene = scene;
    this.db = db;
    this.onSceneChange = onSceneChange || (() => {});
    // Лёгкая синхронизация во время drag: обновляет master-state без расчёта/DOM-render.
    this.onScenePreview = onScenePreview || (() => {});
    this.onClose = onClose || (() => {});
    this.onSave = onSave || (() => {});        // сохранение проекта+сцены (Ctrl+S)
    this.computeFn = computeFn;   // функция получения result из сцены (для statusbar)

    // UI state
    this.selectedId = null;
    this.hoveredId = null;
    this.dragging = null;
    this.paletteDrag = null;
    this.paletteTab = 'luminaires';  // 'luminaires' | 'tracks' | 'downlights' | 'other'
    this.paletteFilterVoltage = null;   // null = все напряжения
    this.paletteSearch = '';
    this.paletteQty = 1;   // количество при добавлении из палитры
    this.paletteLightType = null;   // тип света при добавлении из палитры (null = по модели)
    this._mobileMedia = window.matchMedia?.('(max-width: 820px), (max-height: 500px) and (max-width: 950px)') || null;
    // Робастное определение «мобильного» вида: помимо matchMedia, проверяем и
    // реальный размер окна. Некоторые webview (встроенные браузеры) не дают
    // корректного matches(), при этом CSS-медиа-запрос применяется — из-за
    // этого свёрнутая панель оставалась видимой и занимала половину экрана.
    const _w = typeof window !== 'undefined' ? (window.innerWidth || 0) : 0;
    const _h = typeof window !== 'undefined' ? (window.innerHeight || 0) : 0;
    const narrowBySize = _w <= 820 || (_h <= 500 && _w <= 950);
    this.isMobile = narrowBySize || !!this._mobileMedia?.matches;
    this.isCoarsePointer = !!window.matchMedia?.('(pointer: coarse)')?.matches;
    // На телефоне панели работают как bottom-sheet и изначально закрыты,
    // чтобы вьюпорт сразу занимал всё доступное место.
    this.leftCollapsed = this.isMobile;
    this.rightCollapsed = this.isMobile;
    this._desktopPanelState = { left: false, right: false };
    this.rollouts = { model: true, transform: true, params: true, actions: true };
    this.viewOptions = {
      viewMode: '2d',
      showZones: true,
      showGrid: true,
      showDims: true,
      // Режим света: 'lux' (теплокарта освещённости) | 'beam' (пятна света) | 'off'
      lightMode: 'lux',
      // Разрешение теплокарты в метрах (0.15 = 15 см — качественно, 0.3 — быстро)
      heatmapRes: 0.2,
    };
    this.camera3d = { ...R3D.DEFAULT_CAMERA };
    this._projection3d = null;
    // Кэш теплокарты — пересчёт только при изменении сцены
    this._heatmapCache = null;

    // ============================================================
    // История действий (Undo / Redo) и буфер обмена (Copy / Paste)
    // ============================================================
    this.undoStack = [];        // стек предыдущих снимков сцены (ограничен)
    this.redoStack = [];        // стек для повторного применения
    this.clipboard = null;      // { kind: 'luminaire'|'track', data: {...} }
    this._preChangeScene = null;// снимок сцены на старте непрерывного жеста (drag/slider)
    this._gestureActive = false;// идёт ли непрерывный жест (для истории — один шаг)
    this._interactivePreview = false; // drag-preview без дорогого пересчёта heatmap/BOM
    this.undoLimit = 100;       // максимум шагов отмены

    // Viewport transform (zoom + pan)
    this.vp = { zoom: 1, panX: 0, panY: 0 };  // panX/Y — в м

    // Panning с зажатой средней кнопкой
    this.panning = null;

    // Refs
    this.rootEl = null;
    this.svgEl = null;
    this.svgHostEl = null;
  }

  mount() {
    this.container.innerHTML = '';
    // корневой узел — берёт всё окно
    this.rootEl = el('div', { class: 'editor-3dsmax' });
    this.container.appendChild(this.rootEl);

    this._buildTopbar();
    this._buildToolbar();
    this._buildBody();
    this._buildStatusbar();

    this._attachKeyboard();
    this._attachViewportEvents();
    this._responsiveHandler = (event) => this._handleResponsiveChange(event.matches);
    if (this._mobileMedia?.addEventListener) {
      this._mobileMedia.addEventListener('change', this._responsiveHandler);
    } else {
      // Safari/iOS до MediaQueryList.addEventListener.
      this._mobileMedia?.addListener?.(this._responsiveHandler);
    }
    this._viewportResizeHandler = () => {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        if (this.svgHostEl?.isConnected) this._fitViewport();
      }, 80);
    };
    window.addEventListener('resize', this._viewportResizeHandler, { passive: true });

    // При первом монтировании — auto-fit чтобы план был крупным
    requestAnimationFrame(() => this._fitViewport());
    this._render();
  }

  destroy() {
    if (this._keyHandler) window.removeEventListener('keydown', this._keyHandler);
    if (this._keyUpHandler) window.removeEventListener('keyup', this._keyUpHandler);
    if (this._mobileMedia?.removeEventListener) {
      this._mobileMedia.removeEventListener('change', this._responsiveHandler);
    } else {
      this._mobileMedia?.removeListener?.(this._responsiveHandler);
    }
    window.removeEventListener('resize', this._viewportResizeHandler);
    clearTimeout(this._resizeTimer);
    clearTimeout(this._flashTimer);
    if (this.container) this.container.innerHTML = '';
  }

  update({ project, scene, db }) {
    if (project) this.project = project;
    if (scene) this.scene = scene;
    if (db) this.db = db;
    // Полный рендер только левой панели (если сменилось напряжение → палитра меняется)
    this._render();
  }

  /** Актуальная сцена редактора — используется при закрытии для финальной синхронизации. */
  getScene() {
    return this.scene;
  }

  setScene(newScene, { silent = false, record = true, preview = false } = {}) {
    // Записываем в историю отмены ПРЕДЫДУЩЕЕ состояние, если это не продолжение жеста.
    // Во время drag/slider record=false — снимок ставится один раз на старте жеста.
    if (record && newScene !== this.scene) this._recordUndo(this.scene);
    this.scene = newScene;
    if (!preview) this._heatmapCache = null;   // финальное состояние пересчитаем точно
    this._interactivePreview = preview;
    try {
      this._renderViewport();
    } finally {
      this._interactivePreview = false;
    }
    if (!preview) {
      this._renderRightDock();
      this._renderStatusbar();
    } else {
      // Master всегда знает последнюю локальную сцену, даже если браузер
      // потеряет pointerup при системном жесте или смене ориентации.
      this.onScenePreview(newScene);
    }
    if (!silent) this.onSceneChange(newScene);
  }

  // ============================================================
  // ИСТОРИЯ: Undo / Redo
  // ============================================================

  /** Копия сцены (глубокая, безопасная для сериализации в localStorage) */
  _snapshotScene(scene) {
    try {
      return JSON.parse(JSON.stringify(scene));
    } catch (e) {
      return null;
    }
  }

  /**
   * Записать снимок сцены в стек отмены.
   * Снимаем «до»-состояние при каждом изменении. Если уже есть идентичный
   * снимок — не дублируем. Ограничиваем стек, чтобы не утекала память.
   */
  _recordUndo(sceneBefore) {
    const snap = this._snapshotScene(sceneBefore);
    if (!snap) return;
    // Не кладём два одинаковых снимка подряд
    const top = this.undoStack[this.undoStack.length - 1];
    if (top && JSON.stringify(top) === JSON.stringify(snap)) return;
    this.undoStack.push(snap);
    if (this.undoStack.length > this.undoLimit) this.undoStack.shift();
    // Любое новое действие сбрасывает стек Redo
    this.redoStack = [];
    this._updateUndoRedoUI();
  }

  /** Начало непрерывного жеста (drag, слайдер). Ставим один снимок «до». */
  _beginGesture() {
    if (this._gestureActive) return;
    this._gestureActive = true;
    this._preChangeScene = this._snapshotScene(this.scene);
  }

  /**
   * Конец непрерывного жеста. Если сцена реально изменилась с момента начала —
   * кладём «до»-снимок в историю как ОДИН шаг отмены.
   */
  _endGesture() {
    if (!this._gestureActive) return;
    this._gestureActive = false;
    const before = this._preChangeScene;
    this._preChangeScene = null;
    if (!before) return;
    // Сравнение «до» и «после» — если ничего не менялось, шаг не нужен
    if (JSON.stringify(before) === JSON.stringify(this.scene)) return;
    this.undoStack.push(before);
    if (this.undoStack.length > this.undoLimit) this.undoStack.shift();
    this.redoStack = [];
    this._updateUndoRedoUI();
  }

  /** Финальный тяжёлый рендер после drag/slider и синхронизация с мастером. */
  _finishInteractiveChange() {
    this._heatmapCache = null;
    this._renderViewport();
    this._renderRightDock();
    this._renderStatusbar();
    this.onSceneChange(this.scene);
  }

  /** Может ли пользователь отменить последнее действие */
  canUndo() { return this.undoStack.length > 0; }
  /** Может ли пользователь повторить отменённое действие */
  canRedo() { return this.redoStack.length > 0; }

  /** Ctrl+Z — отменить последнее действие */
  undo() {
    if (this.undoStack.length === 0) return false;
    // Текущую сцену сохраняем для Redo
    const current = this._snapshotScene(this.scene);
    const prev = this.undoStack.pop();
    this.redoStack.push(current);
    this.scene = prev;
    this._heatmapCache = null;
    this._renderViewport();
    this._renderRightDock();
    this._renderStatusbar();
    this.onSceneChange(this.scene);
    this._updateUndoRedoUI();
    return true;
  }

  /** Ctrl+Y (или Ctrl+Shift+Z) — повторить отменённое действие */
  redo() {
    if (this.redoStack.length === 0) return false;
    const current = this._snapshotScene(this.scene);
    const next = this.redoStack.pop();
    this.undoStack.push(current);
    this.scene = next;
    this._heatmapCache = null;
    this._renderViewport();
    this._renderRightDock();
    this._renderStatusbar();
    this.onSceneChange(this.scene);
    this._updateUndoRedoUI();
    return true;
  }

  /** Обновить визуальное состояние кнопок Undo/Redo */
  _updateUndoRedoUI() {
    // Ищем в тулбаре (или в левой панели, куда могут переехать кнопки)
    const undoBtn = this.toolbarEl?.querySelector('[data-undo]') || this.rootEl?.querySelector('[data-undo]');
    const redoBtn = this.toolbarEl?.querySelector('[data-redo]') || this.rootEl?.querySelector('[data-redo]');
    if (undoBtn) { undoBtn.disabled = !this.canUndo(); undoBtn.title = `Отменить (Ctrl+Z) — ${this.undoStack.length}`; }
    if (redoBtn) { redoBtn.disabled = !this.canRedo(); redoBtn.title = `Повторить (Ctrl+Y) — ${this.redoStack.length}`; }
  }

  /**
   * Встраиваемый ли светильник направленного света БЕЗ явного поворота.
   * Такие модели светят СТРОГО ВНИЗ — вращать/наклонять нельзя (нет ручки и ползунка).
   */
  _isFixedDownlight(cat) {
    if (!cat || cat.role !== 'downlight_luminaire') return false;
    const limits = getRotationLimits(cat);
    return !limits.canRotateH && !limits.canRotateV;
  }

  // ============================================================
  // БУФЕР ОБМЕНА: Copy / Paste
  // ============================================================

  /** Ctrl+C — копировать выделенный объект (светильник или трек) */
  copySelected() {
    if (!this.selectedId) return false;
    const lum = this.scene.luminaires.find(l => l.id === this.selectedId);
    if (lum) {
      this.clipboard = {
        kind: 'luminaire',
        data: {
          slug: lum.slug,
          angle_deg: lum.angle_deg != null ? lum.angle_deg : 90,
          // метаданные из каталога — для повторной вставки на трек
          power_w: this._catFor(lum)?.power_w,
          lumen: this._catFor(lum)?.lumen,
        },
      };
      this._flashStatus('Скопирован светильник');
      return true;
    }
    const trk = this.scene.tracks.find(t => t.id === this.selectedId);
    if (trk) {
      this.clipboard = {
        kind: 'track',
        data: {
          points: trk.points.map(p => ({ x: p.x, y: p.y })),
          voltage_v: trk.voltage_v,
          color: trk.color,
          mount: trk.mount,
        },
      };
      this._flashStatus('Скопирован трек');
      return true;
    }
    return false;
  }

  /** Вспомогательно: карточка товара по светильнику */
  _catFor(lum) {
    return lum ? this.db.catalog.find(p => p.slug === lum.slug) : null;
  }

  /**
   * Ctrl+V — вставить скопированный объект.
   * Смещаем копию относительно оригинала, чтобы она не совпадала с ним.
   * Трек можно вставлять несколько раз (копия позиции смещается по сетке).
   */
  pasteClipboard() {
    let clip = this.clipboard;
    if (!clip) { this._flashStatus('Буфер пуст — скопируйте объект (Ctrl+C)'); return false; }
    if (!this._canPaste(clip)) { this._flashStatus('Уже есть объекты — вставка пропущена'); return false; }

    const OFFSET = 0.35;         // смещение копии в метрах (по X)
    const OFFSET_Y = 0.3;        // и немного по Y, чтобы копия была различима
    const room = this.project.room;
    let newScene;

    if (clip.kind === 'luminaire') {
      // Позиция копии — относительно места, где стоит выделенный светильник,
      // иначе — чуть внутрь комнаты
      const base = this._pasteBasePoint();
      const nx = Math.max(0.1, Math.min(room.length - 0.1, base.x + OFFSET));
      const ny = Math.max(0.1, Math.min(room.width - 0.1, base.y + OFFSET_Y));
      newScene = Scene.addLuminaire(this.scene, {
        x: nx, y: ny,
        slug: clip.data.slug,
        angle_deg: clip.data.angle_deg || 90,
      });
      // После вставки — выделяем только что добавленную
      const addedId = newScene.luminaires[newScene.luminaires.length - 1]?.id;
      this._flashStatus('Светильник вставлен');
      this._applyNewSceneAndSelect(newScene, addedId);
      return true;
    }

    if (clip.kind === 'track') {
      // Трек в буфере обязан содержать минимум 2 точки (иначе нечего вставлять)
      if (!Array.isArray(clip.data.points) || clip.data.points.length < 2) {
        this._flashStatus('Буфер трека повреждён — вставка пропущена');
        return false;
      }
      const base = this._pasteBasePoint();
      const dx = OFFSET, dy = OFFSET_Y;
      // Сдвигаем каждую точку скопированного трека, клампим в комнату
      const pts = clip.data.points.map(p => {
        let x = p.x + dx, y = p.y + dy;
        if (x < 0.1) x = 0.1;
        if (y < 0.1) y = 0.1;
        if (x > room.length - 0.1) x = room.length - 0.1;
        if (y > room.width - 0.1) y = room.width - 0.1;
        return { x, y };
      });
      const baseScene = Scene.addTrack(this.scene, {
        x: pts[0].x, y: pts[0].y,
        voltage_v: clip.data.voltage_v,
        color: clip.data.color,
        mount: clip.data.mount,
        lengthM: Math.max(0.2, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)),
      });
      // baseScene уже содержит новый трек в конце; заменяем его точки
      // на скопированные (с сохранением фактической ориентации копии).
      const tracks = [...baseScene.tracks];
      tracks[tracks.length - 1] = { ...tracks[tracks.length - 1], points: pts };
      newScene = { ...baseScene, tracks };
      const addedId = newScene.tracks[newScene.tracks.length - 1]?.id;
      this._flashStatus('Трек вставлен');
      this._applyNewSceneAndSelect(newScene, addedId);
      return true;
    }
    return false;
  }

  /** Базовое место вставки: у выделенного объекта, иначе центр комнаты */
  _pasteBasePoint() {
    const room = this.project.room;
    const lum = this.scene.luminaires.find(l => l.id === this.selectedId);
    if (lum) return { x: lum.x, y: lum.y };
    const trk = this.scene.tracks.find(t => t.id === this.selectedId);
    if (trk && trk.points[0]) return { x: trk.points[0].x, y: trk.points[0].y };
    return { x: room.length / 2, y: room.width / 2 };
  }

  /** Простая защита от вставки «в никуда» — проверяем наличие буфера и сцены */
  _canPaste(clip) {
    return !!clip && !!this.scene;
  }

  /** Применить новую сцену (без лишней записи в историю) и выделить объект */
  _applyNewSceneAndSelect(newScene, id) {
    this._recordUndo(this.scene);   // фиксируем «до» — вставку можно отменить
    this.scene = newScene;
    this._heatmapCache = null;
    this.selectedId = id || null;
    this._renderViewport();
    this._renderRightDock();
    this._renderStatusbar();
    this.onSceneChange(this.scene);
  }

  // ============================================================
  // СОХРАНЕНИЕ: Ctrl+S
  // ============================================================

  /**
   * Сохранить проект + сцену. По умолчанию — в localStorage,
   * с колбэком наружу (если хочется отправить на сервер / открыть ссылку).
   */
  save() {
    const payload = {
      saved_at: new Date().toISOString(),
      project: this.project,
      scene: this.scene,
    };
    let ok = false, detail = '';
    try {
      localStorage.setItem(this._storageKey(), JSON.stringify(payload));
      ok = true;
      detail = 'сохранено в браузере';
    } catch (e) {
      ok = false;
      detail = 'localStorage недоступен: ' + (e.message || e);
    }
    // Дополнительно отдаём наружу (для ссылки/сервера)
    try { this.onSave(payload); } catch (e) { /* игнорируем ошибку колбэка */ }
    this._flashStatus(ok ? `💾 Проект сохранён (${detail})` : `⚠️ ${detail}`);
    return ok;
  }

  /** Ключ localStorage для автосохранения редактора */
  _storageKey() {
    return this._saveKey || (this._saveKey = 'zlc_editor_scene');
  }

  /** Восстановить ранее сохранённую сцену (опционально при открытии) */
  restore() {
    try {
      const raw = localStorage.getItem(this._storageKey());
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (p?.scene) return p.scene;
    } catch (e) { /* повреждённые данные — игнорируем */ }
    return null;
  }

  /** Краткая вспышка-статус в панели подсказок вьюпорта и в статус-баре */
  _flashStatus(text) {
    this._flashMsg = text;
    const hint = this.viewportEl?.querySelector('.ed-viewport-hint .zhk');
    if (hint) hint.textContent = text;   // обновляем текст в подсказке вьюпорта
    this._renderStatusbar();             // также показываем в статус-баре
    // авто-скрытие через 2.5с
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => { this._flashMsg = null; this._renderStatusbar(); }, 2500);
  }

  // ============================================================
  // TOPBAR
  // ============================================================
  _buildTopbar() {
    this.topbarEl = el('div', { class: 'ed-topbar' },
      el('div', { class: 'ed-topbar-brand' },
        el('span', { class: 'ed-brand-icon', 'aria-hidden': 'true' }, '💡'),
        el('span', { class: 'ed-brand-full' }, 'ZimaLED · Редактор плана')),
      el('div', { class: 'ed-menu' },
        el('div', { class: 'ed-menu-item', onClick: () => this._fitViewport() }, 'Вид'),
        el('div', { class: 'ed-menu-item', onClick: () => this._resetToAuto() }, 'Сброс к авто'),
        el('div', { class: 'ed-menu-item', onClick: () => this._showHelp() }, 'Справка'),
      ),
      el('div', { class: 'ed-topbar-spacer' }),
      el('button', {
        class: 'ed-topbar-btn ed-panel-toggle', 'data-panel-toggle': 'left',
        'aria-controls': 'ed-left-panel', 'aria-expanded': String(!this.leftCollapsed),
        onClick: () => this._toggleLeft(),
      }, this.isMobile ? '＋ Каталог' : (this.leftCollapsed ? '▶ Палитра' : '◀ Палитра')),
      el('button', {
        class: 'ed-topbar-btn ed-panel-toggle', 'data-panel-toggle': 'right',
        'aria-controls': 'ed-right-panel', 'aria-expanded': String(!this.rightCollapsed),
        onClick: () => this._toggleRight(),
      }, this.isMobile ? '＋ Свойства' : (this.rightCollapsed ? 'Свойства ◀' : 'Свойства ▶')),
      // На телефоне Save всегда видим в верхней строке — его не нужно искать
      // в горизонтально прокручиваемом toolbar.
      el('button', {
        class: 'ed-topbar-btn ed-mobile-save', title: 'Сохранить проект',
        'aria-label': 'Сохранить проект', onClick: () => this.save(),
      }, '💾'),
      // Всегда отдаём наружу именно последнюю локальную сцену. Это страхует
      // финальный input/drag, который мог ещё не успеть пройти через callback.
      el('button', { class: 'ed-topbar-btn primary', onClick: () => this.onClose(this.scene) }, '✓ Готово'),
      el('button', { class: 'ed-topbar-btn close', title: 'Закрыть редактор', 'aria-label': 'Закрыть редактор', onClick: () => this.onClose(this.scene) }, '✕'),
    );
    this.rootEl.appendChild(this.topbarEl);
  }

  // ============================================================
  // TOOLBAR
  // ============================================================
  _buildToolbar() {
    this.toolbarEl = el('div', { class: 'ed-toolbar' });
    this._renderToolbar();
    this.rootEl.appendChild(this.toolbarEl);
  }

  _renderToolbar() {
    this.toolbarEl.innerHTML = '';
    const mkToggle = (key, label, icon) => {
      const b = el('button', {
        class: 'ed-tool-btn' + (this.viewOptions[key] ? ' active' : ''),
        title: label,
        onClick: () => {
          this.viewOptions[key] = !this.viewOptions[key];
          this._renderToolbar();
          this._renderViewport();
        },
      }, icon + ' ' + label);
      return b;
    };
    const mkBtn = (label, title, onclick, icon = '') => el('button', {
      class: 'ed-tool-btn', title, onClick: onclick,
    }, (icon ? icon + ' ' : '') + label);

    // 2D и 3D работают с одной scene-моделью: переключение не теряет правки.
    this.toolbarEl.appendChild(el('span', { class: 'ed-tool-label' }, 'Вид:'));
    for (const [mode, label, title] of [
      ['2d', '▦ Сверху', 'Ортографический план сверху'],
      ['3d', '◇ 3D', 'Аксонометрическая 3D-комната с редактированием объектов'],
    ]) {
      this.toolbarEl.appendChild(el('button', {
        class: 'ed-tool-btn' + (this.viewOptions.viewMode === mode ? ' active' : ''),
        title,
        'data-view-mode': mode,
        onClick: () => {
          this.viewOptions.viewMode = mode;
          this.dragging = null; this.panning = null;
          this._renderToolbar();
          this._renderViewport();
        },
      }, label));
    }
    if (this.viewOptions.viewMode === '3d') {
      this.toolbarEl.appendChild(mkBtn('↶', 'Повернуть камеру влево', () => this._rotate3D(-15, 0)));
      this.toolbarEl.appendChild(mkBtn('↷', 'Повернуть камеру вправо', () => this._rotate3D(15, 0)));
      this.toolbarEl.appendChild(mkBtn('↑', 'Поднять камеру', () => this._rotate3D(0, 6)));
      this.toolbarEl.appendChild(mkBtn('↓', 'Опустить камеру', () => this._rotate3D(0, -6)));
    }

    this.toolbarEl.appendChild(el('div', { class: 'ed-tool-divider' }));
    this.toolbarEl.appendChild(mkBtn('', 'Приблизить (+ или колесо)', () => this._zoomBy(1.25), '🔍+'));
    this.toolbarEl.appendChild(mkBtn('', 'Отдалить (- или колесо)', () => this._zoomBy(0.8), '🔍−'));
    this.toolbarEl.appendChild(mkBtn('Вписать', 'Вписать в вьюпорт (F)', () => this._fitViewport(), '⛶'));

    this.toolbarEl.appendChild(el('div', { class: 'ed-tool-divider' }));

    // === ИСТОРИЯ: Отменить / Повторить + Сохранить ===
    const undoBtn = el('button', {
      class: 'ed-tool-btn', title: 'Отменить (Ctrl+Z)', 'data-undo': '',
      onClick: () => this.undo(),
    }, '↩ Отменить');
    const redoBtn = el('button', {
      class: 'ed-tool-btn', title: 'Повторить (Ctrl+Y)', 'data-redo': '',
      onClick: () => this.redo(),
    }, '↪ Повторить');
    this.toolbarEl.appendChild(undoBtn);
    this.toolbarEl.appendChild(redoBtn);
    this.toolbarEl.appendChild(mkBtn('💾 Сохранить', 'Сохранить проект (Ctrl+S)', () => this.save(), ''));
    // Кнопки Copy / Paste
    this.toolbarEl.appendChild(mkBtn('⧉ Копировать', 'Копировать выделенное (Ctrl+C)', () => this.copySelected(), ''));
    this.toolbarEl.appendChild(mkBtn('📋 Вставить', 'Вставить копию (Ctrl+V)', () => this.pasteClipboard(), ''));

    this.toolbarEl.appendChild(el('div', { class: 'ed-tool-divider' }));
    this._updateUndoRedoUI();

    this.toolbarEl.appendChild(mkToggle('showGrid', 'Сетка', '#'));
    this.toolbarEl.appendChild(mkToggle('showZones', 'Зоны', '▦'));
    this.toolbarEl.appendChild(mkToggle('showDims', 'Размеры', '↔'));

    // Радио-режим света: Lux-теплокарта / Beam-пятна / Off
    this.toolbarEl.appendChild(el('div', { class: 'ed-tool-divider' }));
    this.toolbarEl.appendChild(el('span', { class: 'ed-tool-label' }, 'Свет:'));
    const mkLightRadio = (mode, label, title) => el('button', {
      class: 'ed-tool-btn' + (this.viewOptions.lightMode === mode ? ' active' : ''),
      title,
      onClick: () => {
        this.viewOptions.lightMode = mode;
        this._heatmapCache = null;   // сбросить кэш при переключении
        this._renderToolbar();
        this._renderViewport();
      },
    }, label);
    this.toolbarEl.appendChild(mkLightRadio('lux',  '🌡 Освещённость',
      'Теплокарта фактической освещённости на полу в люксах'));
    this.toolbarEl.appendChild(mkLightRadio('beam', '☀ Пятна',
      'Направление и форма пучков светильников'));
    this.toolbarEl.appendChild(mkLightRadio('off',  '○ Нет',
      'Скрыть визуализацию света'));

    this.toolbarEl.appendChild(el('div', { class: 'ed-tool-divider' }));

    const stats = Scene.sceneStats(this.scene);
    const zoom = this.viewOptions.viewMode === '3d' ? this.camera3d.zoom : this.vp.zoom;
    const camera = this.viewOptions.viewMode === '3d'
      ? ` · камера ${Math.round(this.camera3d.yaw)}°/${Math.round(this.camera3d.pitch)}°`
      : '';
    this.toolbarEl.appendChild(el('span', { class: 'ed-tool-label' },
      `Zoom: ${Math.round(zoom * 100)}%${camera} · ${stats.tracks_total} трек. · ${stats.luminaires_total} свет.`));
  }

  // ============================================================
  // BODY (3-колоночный dock)
  // ============================================================
  _buildBody() {
    this.bodyEl = el('div', { class: 'ed-body' });
    this._updateBodyClass();

    // LEFT DOCK — палитра
    this.leftPanelEl = el('aside', { id: 'ed-left-panel', class: 'ed-panel left', 'aria-label': 'Каталог оборудования' });
    this.bodyEl.appendChild(this.leftPanelEl);

    // VIEWPORT
    this.viewportEl = el('div', { class: 'ed-viewport' });
    this.svgHostEl = el('div', { class: 'ed-svg-host' });
    this.viewportEl.appendChild(this.svgHostEl);
    this._buildViewportOverlays();
    this.bodyEl.appendChild(this.viewportEl);

    // RIGHT DOCK — свойства
    this.rightPanelEl = el('aside', { id: 'ed-right-panel', class: 'ed-panel right', 'aria-label': 'Свойства объекта' });
    this.bodyEl.appendChild(this.rightPanelEl);

    this.rootEl.appendChild(this.bodyEl);
  }

  _updateBodyClass() {
    if (!this.bodyEl) return;
    this.bodyEl.className = 'ed-body' +
      (this.leftCollapsed && this.rightCollapsed ? ' both-collapsed' :
       this.leftCollapsed ? ' left-collapsed' :
       this.rightCollapsed ? ' right-collapsed' : '');
  }

  _handleResponsiveChange(nextMobile) {
    if (nextMobile === this.isMobile) return;
    if (nextMobile) {
      this._desktopPanelState = {
        left: this.leftCollapsed,
        right: this.rightCollapsed,
      };
      this.leftCollapsed = true;
      this.rightCollapsed = true;
    } else {
      this.leftCollapsed = this._desktopPanelState.left;
      this.rightCollapsed = this._desktopPanelState.right;
    }
    this.isMobile = nextMobile;
    this.isCoarsePointer = !!window.matchMedia?.('(pointer: coarse)')?.matches;
    this._updateBodyClass();
    this._renderLeftPanel();
    this._renderRightPanel();
    this._renderTopbar();
    requestAnimationFrame(() => this._fitViewport());
  }

  _toggleLeft() {
    const willOpen = this.leftCollapsed;
    this.leftCollapsed = !this.leftCollapsed;
    // Bottom-sheet на телефоне: одновременно открыта только одна панель.
    if (this.isMobile && willOpen) this.rightCollapsed = true;
    this._updateBodyClass();
    this._renderLeftPanel();
    if (this.isMobile) this._renderRightPanel();
    this._renderTopbar();
  }
  _toggleRight() {
    const willOpen = this.rightCollapsed;
    this.rightCollapsed = !this.rightCollapsed;
    if (this.isMobile && willOpen) this.leftCollapsed = true;
    this._updateBodyClass();
    this._renderRightPanel();
    if (this.isMobile) this._renderLeftPanel();
    this._renderTopbar();
  }

  _renderTopbar() {
    const leftBtn = this.topbarEl.querySelector('[data-panel-toggle="left"]');
    const rightBtn = this.topbarEl.querySelector('[data-panel-toggle="right"]');
    if (leftBtn) {
      leftBtn.textContent = this.isMobile
        ? (this.leftCollapsed ? '＋ Каталог' : '− Каталог')
        : (this.leftCollapsed ? '▶ Палитра' : '◀ Палитра');
      leftBtn.setAttribute('aria-expanded', String(!this.leftCollapsed));
    }
    if (rightBtn) {
      rightBtn.textContent = this.isMobile
        ? (this.rightCollapsed ? '＋ Свойства' : '− Свойства')
        : (this.rightCollapsed ? 'Свойства ◀' : 'Свойства ▶');
      rightBtn.setAttribute('aria-expanded', String(!this.rightCollapsed));
    }
  }

  // ============================================================
  // LEFT PANEL: Палитра
  // ============================================================
  _renderLeftPanel() {
    this.leftPanelEl.innerHTML = '';
    // Явный класс свёрнутой панели: CSS на мобильном гарантированно прячет
    // её, даже если isMobile (matchMedia) не совпал с реальным размером окна.
    this.leftPanelEl.classList.toggle('collapsed', this.leftCollapsed);
    if (this.leftCollapsed) {
      // На мобильном панель в свёрнутом виде вообще не рендерим (нет места —
      // bottom-sheet не должен занимать экран). Открытие — через кнопку тулбара.
      // На десктопе остаётся кликабельная вертикальная полоска.
      if (this.isMobile) return;
      this.leftPanelEl.appendChild(el('div', {
        class: 'ed-panel-collapsed',
        onClick: () => this._toggleLeft(),
      }, '◀ ПАЛИТРА'));
      return;
    }

    this.leftPanelEl.appendChild(el('div', { class: 'ed-panel-header' },
      el('div', { class: 'ed-panel-title' }, 'Библиотека'),
      el('button', {
        class: 'ed-panel-collapse', title: 'Закрыть панель', 'aria-label': 'Закрыть каталог',
        onClick: () => this._toggleLeft(),
      }, this.isMobile ? '×' : '◀'),
    ));

    // Быстрая статистика по всему каталогу — покажем реальное число товаров
    const totalCat = this.db.catalog?.length || 0;
    const byRole = {};
    for (const p of this.db.catalog || []) byRole[p.role] = (byRole[p.role] || 0) + 1;

    // Табы: 4 раздела
    const tabs = el('div', { class: 'ed-palette-tabs' });
    const mkTab = (key, label, count) => el('div', {
      class: 'ed-palette-tab' + (this.paletteTab === key ? ' active' : ''),
      onClick: () => { this.paletteTab = key; this._renderLeftPanel(); },
      title: `${count} товаров`,
    }, `${label} (${count})`);
    tabs.appendChild(mkTab('luminaires', 'Светильники', byRole.luminaire || 0));
    tabs.appendChild(mkTab('tracks', 'Треки', (byRole.shinoprovod || 0) + (byRole.connector || 0)));
    tabs.appendChild(mkTab('downlights', 'Встраиваемые', byRole.downlight_luminaire || 0));
    tabs.appendChild(mkTab('psu', 'БП', byRole.psu || 0));
    this.leftPanelEl.appendChild(tabs);

    // Фильтр напряжения + поиск
    const filterBar = el('div', { class: 'ed-palette-filter' },
      el('span', { class: 'ed-palette-filter-label' }, 'Вольт:'),
      el('button', {
        class: 'ed-mini-btn' + (this.paletteFilterVoltage === null ? ' active' : ''),
        onClick: () => { this.paletteFilterVoltage = null; this._renderLeftPanel(); },
      }, 'все'),
      el('button', {
        class: 'ed-mini-btn' + (this.paletteFilterVoltage === 48 ? ' active' : ''),
        onClick: () => { this.paletteFilterVoltage = 48; this._renderLeftPanel(); },
      }, '48'),
      el('button', {
        class: 'ed-mini-btn' + (this.paletteFilterVoltage === 220 ? ' active' : ''),
        onClick: () => { this.paletteFilterVoltage = 220; this._renderLeftPanel(); },
      }, '220'),
    );
    this.leftPanelEl.appendChild(filterBar);

    const searchBar = el('div', { class: 'ed-palette-search-wrap' },
      el('input', {
        type: 'text',
        class: 'ed-palette-search',
        placeholder: '🔎 Поиск...',
        value: this.paletteSearch,
      }),
    );
    const searchInput = searchBar.querySelector('input');
    searchInput.addEventListener('input', (e) => {
      this.paletteSearch = e.target.value.toLowerCase();
      this._renderPaletteList();
    });
    this.leftPanelEl.appendChild(searchBar);

    // Количество добавляемых светильников (управляемое в Редакторе плана)
    const qtyBar = el('div', { class: 'ed-palette-qty' },
      el('span', { class: 'ed-palette-filter-label' }, 'Кол-во:'),
      el('button', { class: 'ed-mini-btn', title: 'Меньше',
        onClick: () => { this.paletteQty = Math.max(1, this.paletteQty - 1); this._renderLeftPanel(); } }, '−'),
      el('span', { class: 'ed-palette-qty-val' }, String(this.paletteQty)),
      el('button', { class: 'ed-mini-btn', title: 'Больше',
        onClick: () => { this.paletteQty = Math.min(20, this.paletteQty + 1); this._renderLeftPanel(); } }, '＋'),
      el('span', { class: 'ed-palette-qty-hint' }, 'шт за клик'),
    );
    this.leftPanelEl.appendChild(qtyBar);

    // Тип света для добавляемых светильников (управляемое в Редакторе плана)
    const ltSel = document.createElement('select');
    ltSel.className = 'ed-select ed-palette-lt';
    ltSel.title = 'Тип света добавляемых светильников';
    const ltOpts = [['', 'Тип света: по модели']];
    for (const o of LIGHT_TYPE_OPTIONS) ltOpts.push([o.id, `${o.icon} ${o.label}`]);
    for (const [val, label] of ltOpts) {
      const o = document.createElement('option');
      o.value = val; o.textContent = label;
      if (val === (this.paletteLightType || '')) o.selected = true;
      ltSel.appendChild(o);
    }
    ltSel.addEventListener('change', () => {
      this.paletteLightType = ltSel.value || null;
      this._renderLeftPanel();
    });
    const ltBar = el('div', { class: 'ed-palette-lt-bar' }, ltSel);
    this.leftPanelEl.appendChild(ltBar);

    const body = el('div', { class: 'ed-panel-body' });
    this._paletteListEl = el('div', { class: 'ed-palette-list' });
    body.appendChild(this._paletteListEl);
    this.leftPanelEl.appendChild(body);
    this._renderPaletteList();
  }

  _renderPaletteList() {
    if (!this._paletteListEl) return;
    const list = this._paletteListEl;
    list.innerHTML = '';

    // Фильтруем по табу, напряжению, поиску
    const search = (this.paletteSearch || '').toLowerCase().trim();
    const matchSearch = (p) => !search || (p.name || '').toLowerCase().includes(search) ||
                                          (p.series || '').toLowerCase().includes(search) ||
                                          (p.subcategory || '').toLowerCase().includes(search);
    const matchVoltage = (p) => this.paletteFilterVoltage === null ||
                                 !p.voltage_v || p.voltage_v === this.paletteFilterVoltage;

    let items = [];
    if (this.paletteTab === 'luminaires') {
      items = this.db.catalog.filter(p => p.role === 'luminaire' && matchVoltage(p) && matchSearch(p));
    } else if (this.paletteTab === 'tracks') {
      // Все шинопроводы и коннекторы
      items = this.db.catalog.filter(p =>
        (p.role === 'shinoprovod' || p.role === 'connector' || p.role === 'kit')
        && matchVoltage(p) && matchSearch(p));
    } else if (this.paletteTab === 'downlights') {
      items = this.db.catalog.filter(p => p.role === 'downlight_luminaire' && matchSearch(p));
    } else if (this.paletteTab === 'psu') {
      items = this.db.catalog.filter(p => p.role === 'psu' && matchVoltage(p) && matchSearch(p));
    }

    if (items.length === 0) {
      list.appendChild(el('div', { class: 'ed-palette-hint' },
        `Нет товаров по фильтру. Всего в каталоге: ${this.db.catalog.length}.`));
      return;
    }

    // Группировка по subcategory
    const groups = new Map();
    for (const p of items) {
      const g = p.subcategory || 'Прочее';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(p);
    }

    for (const [groupName, groupItems] of groups) {
      list.appendChild(el('div', { class: 'ed-palette-group-title' }, `${groupName} · ${groupItems.length}`));
      for (const p of groupItems) {
        list.appendChild(this._buildProductPaletteItem(p));
      }
    }

    // Подсказка внизу
    list.appendChild(el('div', { class: 'ed-palette-hint' },
      el('div', {}, el('b', {}, 'Всего показано:'), ` ${items.length} из ${this.db.catalog.length}`),
      el('div', {}, '• Кнопка ＋ добавляет товар в центр плана'),
      el('div', {}, '• На компьютере карточку можно перетащить'),
      el('div', {}, '• Клик по товару = свойства справа'),
      el('div', {}, '• Del на плане = удалить'),
    ));
  }

  /** Собирает один product-item палитры (унифицирован для всех типов) */
  _buildProductPaletteItem(p) {
    let kind, dragPayload, icon = '●', iconColor = null;
    if (p.role === 'luminaire' || p.role === 'downlight_luminaire') {
      kind = 'luminaire';
      dragPayload = { kind: 'luminaire', slug: p.slug };
      const cct = getCCT(p.cct_k);
      iconColor = cct.emitColor;
    } else if (p.role === 'shinoprovod') {
      kind = 'track';
      dragPayload = { kind: 'track', slug: p.slug, length: p.length_m || 2 };
      icon = '━';
    } else if (p.role === 'connector') {
      kind = 'connector';
      dragPayload = null;   // коннекторы не таскаются, добавляются автоматически
      icon = '⌐';
    } else if (p.role === 'kit') {
      kind = 'kit';
      // Комплект — это BOM-набор, а не геометрический светильник. Добавление его
      // как luminaire создавало на плане фиктивный объект с нулевым световым потоком.
      dragPayload = null;
      icon = '📦';
    } else if (p.role === 'psu') {
      kind = 'psu';
      dragPayload = null;   // БП подбирается автоматом
      icon = '⚡';
    } else {
      kind = 'other';
      dragPayload = null;
    }

    // Недоступный товар остаётся видимым для справки, но добавить его в сцену нельзя.
    if (p.in_stock === false) dragPayload = null;

    const shape = (p.role === 'luminaire' || p.role === 'downlight_luminaire') ? getBeamShape(inferLuminaireType(p)) : null;
    const cct = (p.role === 'luminaire' || p.role === 'downlight_luminaire') ? getCCT(p.cct_k) : null;

    // Название — оставляем полное, только чистим избыточную преамбулу
    const shortName = p.name.replace(/^Светильник(?:\s+светодиодный)?\s+/, '')
                             .replace(/^Трек\s+/, '')
                             .replace(/^Шинопровод\s+/, '');
    const price = p.price_rub ? p.price_rub.toLocaleString('ru-RU') + ' ₽' : '';

    // Подсказка (sub) — компактно: главные параметры
    const parts = [];
    if (p.voltage_v) parts.push(p.voltage_v + 'В');
    if (p.power_w) parts.push(p.power_w + 'Вт');
    if (p.lumen) parts.push(p.lumen + 'лм');
    if (p.beam_deg) {
      parts.push(
        p.beam_deg_cross && p.beam_deg_cross !== p.beam_deg
          ? `${p.beam_deg}°×${p.beam_deg_cross}°`
          : p.beam_deg + '°'
      );
    }
    if (p.length_m) parts.push(p.length_m + 'м');
    if (p.color) parts.push(p.color === 'black' ? 'чёрн.' : 'бел.');
    const subText = parts.join(' · ');

    const draggable = dragPayload !== null;

    const iconEl = el('div', {
      class: 'ed-palette-icon',
      style: iconColor ? { color: iconColor, textShadow: `0 0 8px ${iconColor}` } : {},
    }, icon);

    const titleEl = el('div', { class: 'ed-palette-title' }, shortName);
    const subChildren = [];
    if (cct) {
      subChildren.push(el('span', {
        class: 'ed-palette-cct-chip',
        style: { background: cct.emitColor, color: cct.textColor },
      }, cct.short));
    }
    if (subText) subChildren.push(subText);
    const subEl = el('div', { class: 'ed-palette-sub' }, ...subChildren);

    const addButton = draggable && dragPayload ? el('button', {
      class: 'ed-palette-add',
      title: 'Добавить в центр видимой области',
      'aria-label': `Добавить «${shortName}» на план`,
      onClick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._addPaletteItem(dragPayload);
      },
    }, el('span', { 'aria-hidden': 'true' }, '＋'), el('span', { class: 'ed-palette-add-label' }, 'На план')) : null;

    const item = el('div', {
      class: 'ed-palette-item' + (draggable ? '' : ' ed-palette-item-static'),
      draggable: draggable && !this.isMobile ? 'true' : 'false',
      title: p.name + (p.description ? '\n\n' + p.description : ''),
      onClick: () => this._selectFromPalette(p),
    },
      iconEl,
      el('div', { class: 'ed-palette-body-cell' }, titleEl, subEl),
      el('div', { class: 'ed-palette-actions' },
        price ? el('div', { class: 'ed-palette-price' }, price) : null,
        addButton),
    );

    if (draggable && dragPayload) {
      item.addEventListener('dragstart', (e) => {
        this.paletteDrag = dragPayload;
        e.dataTransfer.effectAllowed = 'copy';
        try { e.dataTransfer.setData('text/plain', JSON.stringify(dragPayload)); } catch {}
      });
      item.addEventListener('dragend', () => { this.paletteDrag = null; });
    }
    return item;
  }

  /**
   * Добавление без HTML5 drag-and-drop. На iOS/Android нативный drag карточек
   * ненадёжен, поэтому кнопка «На план» создаёт объект в центре вьюпорта.
   */
  _addPaletteItem(payload) {
    if (!payload) return;
    const room = this.project.room;
    const hostRect = this.svgHostEl?.getBoundingClientRect();
    let x = room.length / 2;
    let y = room.width / 2;
    if (hostRect && this.viewOptions.viewMode === '3d' && this._projection3d) {
      const center = this._projection3d.screenToWorld(hostRect.width / 2, hostRect.height / 2, 0);
      x = Math.max(0.1, Math.min(room.length - 0.1, center.x));
      y = Math.max(0.1, Math.min(room.width - 0.1, center.y));
    } else if (hostRect && this._pxToMx && this._pxToMy) {
      x = Math.max(0.1, Math.min(room.length - 0.1, this._pxToMx(hostRect.width / 2)));
      y = Math.max(0.1, Math.min(room.width - 0.1, this._pxToMy(hostRect.height / 2)));
    }

    let newScene = this.scene;
    if (payload.kind === 'luminaire') {
      const qty = this.paletteQty || 1;
      const lightType = payload.lightType || this.paletteLightType || null;
      if (qty > 1) {
        newScene = Scene.addLuminaires(this.scene, { x, y, slug: payload.slug, count: qty, lightType });
        this.selectedId = newScene.luminaires[newScene.luminaires.length - 1]?.id || null;
        this._flashStatus(`Добавлено ${qty} светильников`);
      } else {
        newScene = Scene.addLuminaire(this.scene, { x, y, slug: payload.slug, lightType });
        this.selectedId = newScene.luminaires[newScene.luminaires.length - 1]?.id || null;
      }
    } else if (payload.kind === 'track') {
      const maxLength = Math.max(0.2, room.length - 0.2);
      const lengthM = Math.min(payload.length || 2, maxLength);
      const startX = Math.max(0.1, Math.min(room.length - lengthM - 0.1, x - lengthM / 2));
      newScene = Scene.addTrack(this.scene, {
        x: startX,
        y,
        voltage_v: this.project.system.voltage_v,
        color: this.project.system.color,
        mount: this.project.system.mount,
        lengthM,
      });
      this.selectedId = newScene.tracks[newScene.tracks.length - 1]?.id || null;
    }
    if (newScene === this.scene) return;

    this.selectedProductFromPalette = null;
    if (this.isMobile) {
      // После добавления закрываем каталог и сразу открываем свойства объекта.
      this.leftCollapsed = true;
      this.rightCollapsed = false;
      this._updateBodyClass();
      this._renderLeftPanel();
      this._renderTopbar();
    }
    this.setScene(newScene);
    this._flashStatus('Добавлено на план — перетащите объект в нужное место');
  }

  /** Клик по товару в палитре — показать его свойства в правой панели */
  _selectFromPalette(product) {
    this.selectedProductFromPalette = product;
    this.selectedId = null;
    this._renderViewport();
    // На мобильном карточка открывает свойства как отдельный bottom-sheet.
    if (this.isMobile) {
      this.leftCollapsed = true;
      this.rightCollapsed = false;
      this._updateBodyClass();
      this._renderLeftPanel();
      this._renderTopbar();
    }
    // если ничего не выделено на сцене — показываем товар из палитры
    this._renderRightPanel();
  }

  // (_buildPaletteItem удалён — заменён на _buildProductPaletteItem с полными данными)

  // ============================================================
  // VIEWPORT
  // ============================================================
  _buildViewportOverlays() {
    // Метка вида
    this.viewportEl.appendChild(el('div', { class: 'ed-viewport-label' },
      el('span', {}, '[+] '), el('b', { class: 'ed-view-name' }, 'Вид сверху')));

    // Подсказки разделены для mouse/keyboard и touch-интерфейса.
    this.viewportEl.appendChild(el('div', { class: 'ed-viewport-hint' },
      el('div', { class: 'ed-desktop-hints' },
        el('div', {}, el('b', {}, 'ЛКМ'), ' — выделить/тащить'),
        el('div', {}, el('b', {}, 'СКМ'), ' или ', el('b', {}, 'Space+тащить'), ' — панорамирование'),
        el('div', {}, el('b', {}, 'Колесо'), ' — зум · ', el('b', {}, 'F'), ' — вписать'),
        el('div', {}, el('b', {}, 'Del'), ' — удалить · ', el('b', {}, '←↑↓→'), ' — точное перемещение'),
        el('div', { class: 'zhk-editor-keys' },
          el('b', {}, 'Ctrl+Z'), ' отмена · ', el('b', {}, 'Ctrl+Y'), ' повторить · ',
          el('b', {}, 'Ctrl+C'), ' копировать · ', el('b', {}, 'Ctrl+V'), ' вставить · ',
          el('b', {}, 'Ctrl+S'), ' сохранить')),
      el('div', { class: 'ed-mobile-hints' },
        'Тяните объект пальцем · пустое место — панорама · ＋/− — масштаб'),
      this._flashMsg ? el('div', { class: 'zhk' }, this._flashMsg) : null,
    ));

    // Nav-кнопки (право-верх вьюпорта)
    this.viewportEl.appendChild(el('div', { class: 'ed-viewport-nav' },
      el('button', { class: 'ed-nav-btn', title: 'Приблизить', onClick: () => this._zoomBy(1.25) }, '＋'),
      el('button', { class: 'ed-nav-btn', title: 'Отдалить', onClick: () => this._zoomBy(0.8) }, '−'),
      el('button', { class: 'ed-nav-btn', title: 'Вписать (F)', onClick: () => this._fitViewport() }, '⛶'),
    ));
  }

  _attachViewportEvents() {
    // Wheel = zoom к курсору
    this.svgHostEl.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = this.svgHostEl.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      this._zoomAt(factor, cx, cy);
    }, { passive: false });

    // Drop из палитры
    this.svgHostEl.addEventListener('dragover', (e) => {
      if (this.paletteDrag) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
    });
    this.svgHostEl.addEventListener('drop', (e) => this._onCanvasDrop(e));
  }

  _renderViewport() {
    this.svgHostEl.innerHTML = '';
    const hostRect = this.svgHostEl.getBoundingClientRect();
    const W = Math.max(300, hostRect.width);
    const H = Math.max(300, hostRect.height);

    if (this.viewOptions.viewMode === '3d') {
      this._renderViewport3D(W, H);
      return;
    }
    this._updateViewportModeLabel();
    const room = this.project.room;

    // Динамический масштаб: базовый (auto-fit) × zoom
    const padPx = 50;
    const baseScale = Math.min(
      (W - padPx * 2) / room.length,
      (H - padPx * 2) / room.width,
    );
    this._scale = baseScale * this.vp.zoom;

    // Центр вьюпорта минус центр комнаты (в пикселях)
    const roomWpx = room.length * this._scale;
    const roomHpx = room.width * this._scale;
    this._offsetX = (W - roomWpx) / 2 + this.vp.panX * this._scale;
    this._offsetY = (H - roomHpx) / 2 + this.vp.panY * this._scale;

    // m → px
    this._X = (mx) => this._offsetX + mx * this._scale;
    this._Y = (my) => this._offsetY + my * this._scale;
    this._m2px = (m) => m * this._scale;

    // svg → m (для обработчиков)
    this._pxToMx = (px) => (px - this._offsetX) / this._scale;
    this._pxToMy = (py) => (py - this._offsetY) / this._scale;

    const root = svgEl('svg', {
      xmlns: SVG_NS,
      viewBox: `0 0 ${W} ${H}`,
      width: W,
      height: H,
    });
    this.svgEl = root;

    // <defs>
    const defs = svgEl('defs');
    if (this.viewOptions.showGrid) {
      const gPx = this._m2px(0.5);
      const gpat = svgEl('pattern', {
        id: 'ed-grid-vp',
        width: gPx, height: gPx,
        patternUnits: 'userSpaceOnUse',
      }, [
        svgEl('path', { d: `M ${gPx} 0 L 0 0 0 ${gPx}`, fill: 'none', stroke: VP.grid, 'stroke-width': 1 }),
      ]);
      defs.appendChild(gpat);
    }
    // Динамические градиенты для beam-режима — только если он активен.
    // ВАЖНО: beam-пятна сделаны КОМПАКТНЫМИ (hotspot) — только область высокой
    // концентрации света. Полная зона освещённости показывается через lux-теплокарту.
    if (this.viewOptions.lightMode === 'beam') {
      const beamGradIds = new Set();
      for (const lum of this.scene.luminaires) {
        const cat = this.db.catalog.find(p => p.slug === lum.slug);
        if (!cat) continue;
        const cct = getCCT(cat.cct_k);
        const type = inferLuminaireType(cat);
        const shape = getBeamShape(type);
        const id = `ed-beam-${cct.K}-${type}`;
        if (beamGradIds.has(id)) continue;
        beamGradIds.add(id);
        // Компактный hotspot — центр яркий, но быстро гаснет
        const grad = svgEl('radialGradient', { id }, [
          svgEl('stop', { offset: '0%',
            'stop-color': cct.emitColor, 'stop-opacity': Math.min(0.9, shape.intensity + 0.15) }),
          svgEl('stop', { offset: '40%',
            'stop-color': cct.emitColor, 'stop-opacity': shape.intensity * 0.4 }),
          svgEl('stop', { offset: '100%',
            'stop-color': cct.emitColor, 'stop-opacity': 0 }),
        ]);
        defs.appendChild(grad);
      }
    }
    const glow = svgEl('filter', { id: 'ed-glow-vp', x: '-30%', y: '-30%', width: '160%', height: '160%' }, [
      svgEl('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: 2.5, result: 'blur' }),
      svgEl('feMerge', {}, [
        svgEl('feMergeNode', { in: 'blur' }),
        svgEl('feMergeNode', { in: 'SourceGraphic' }),
      ]),
    ]);
    defs.appendChild(glow);
    root.appendChild(defs);

    // Фон вьюпорта — тёмный
    root.appendChild(svgEl('rect', { x: 0, y: 0, width: W, height: H, fill: VP.bg }));

    // Комната
    root.appendChild(svgEl('rect', {
      x: this._X(0), y: this._Y(0),
      width: this._m2px(room.length), height: this._m2px(room.width),
      fill: VP.floor, stroke: VP.wall, 'stroke-width': 2, rx: 2,
    }));
    if (this.viewOptions.showGrid) {
      root.appendChild(svgEl('rect', {
        x: this._X(0), y: this._Y(0),
        width: this._m2px(room.length), height: this._m2px(room.width),
        fill: 'url(#ed-grid-vp)',
      }));
    }

    // Зоны
    if (this.viewOptions.showZones) this._renderZones(root);

    // Размеры
    if (this.viewOptions.showDims) this._renderDims(root);

    // Beams
    // Режим визуализации света
    if (this.viewOptions.lightMode === 'lux') {
      this._renderHeatmap(root);
    } else if (this.viewOptions.lightMode === 'beam') {
      this._renderBeams(root);
    }
    // 'off' — ничего не рисуем

    // Tracks
    this._renderTracks(root);

    // Luminaires
    this._renderLuminaires(root);

    // Общие обработчики
    root.addEventListener('click', (e) => {
      if (e.target === root || e.target.dataset.kind === 'bg') this._select(null);
    });
    root.addEventListener('pointerdown', (e) => {
      const onBackground = e.target === root || e.target.dataset.kind === 'bg';
      const mousePan = e.button === 1 || (e.button === 0 && this._spaceHeld);
      const touchPan = e.pointerType === 'touch' && onBackground;
      if (mousePan || touchPan) {
        e.preventDefault();
        e.stopPropagation();
        this._startViewportPan(e);
      }
    });

    this.svgHostEl.appendChild(root);
  }

  _updateViewportModeLabel() {
    const label = this.viewportEl?.querySelector('.ed-view-name');
    if (label) label.textContent = this.viewOptions.viewMode === '3d' ? '3D-перспектива' : 'Вид сверху';
    const desktopHint = this.viewportEl?.querySelector('.ed-desktop-hints > div:first-child');
    if (desktopHint && this.viewOptions.viewMode === '3d') {
      desktopHint.textContent = 'ЛКМ — объект · пустое место/СКМ — вращать камеру';
    } else if (desktopHint) {
      desktopHint.textContent = 'ЛКМ — выделить/тащить';
    }
    const mobileHint = this.viewportEl?.querySelector('.ed-mobile-hints');
    if (mobileHint) mobileHint.textContent = this.viewOptions.viewMode === '3d'
      ? 'Тяните объект · пустое место — вращайте 3D · ＋/− — масштаб'
      : 'Тяните объект пальцем · пустое место — панорама · ＋/− — масштаб';
  }

  /** Рендер 3D использует ту же scene, что 2D и итоговый расчёт. */
  _renderViewport3D(width, height) {
    this._updateViewportModeLabel();
    const root = R3D.renderScene3D(this.project, this.scene, this.db, {
      width, height,
      camera: this.camera3d,
      selectedId: this.selectedId,
      showZones: this.viewOptions.showZones,
      showGrid: this.viewOptions.showGrid,
      showBeams: this.viewOptions.lightMode !== 'off',
      showDimensions: this.viewOptions.showDims,
      showLegend: true,
      interactive: true,
    });
    this.svgEl = root;
    this._projection3d = root.__projection3d;
    this._scale = this._projection3d.scale;

    root.querySelectorAll('[data-kind="luminaire"], [data-kind="track"], [data-kind="track-handle"]')
      .forEach(object => {
        const id = object.getAttribute('data-id');
        const kind = object.getAttribute('data-kind');
        object.addEventListener('pointerenter', () => {
          this.hoveredId = id;
          this._renderStatusbar();
        });
        object.addEventListener('pointerleave', () => {
          if (this.hoveredId === id) { this.hoveredId = null; this._renderStatusbar(); }
        });
        object.addEventListener('pointerdown', event => this._onPointerDown3D(event, id, kind, {
          pointIdx: Number(object.getAttribute('data-point-index')),
        }));
      });

    root.addEventListener('click', event => {
      if (event.target === root || event.target.dataset.kind === 'bg') this._select(null);
    });
    root.addEventListener('pointerdown', event => {
      const background = event.target === root || event.target.dataset.kind === 'bg';
      const orbit = event.button === 1 || (event.button === 0 && (background || this._spaceHeld));
      if (!orbit) return;
      event.preventDefault(); event.stopPropagation();
      this._startViewportPan(event);
    });
    this.svgHostEl.appendChild(root);
  }

  _rotate3D(yawDelta, pitchDelta) {
    this.camera3d.yaw += yawDelta;
    this.camera3d.pitch = Math.max(12, Math.min(72, this.camera3d.pitch + pitchDelta));
    this._renderViewport();
    this._renderToolbar();
  }

  _onPointerDown3D(event, id, kind, extra = {}) {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    this._select(id);
    this._beginGesture();
    const common = {
      view: '3d', type: kind, id,
      startClientX: event.clientX, startClientY: event.clientY,
    };
    if (kind === 'luminaire') {
      const lum = this.scene.luminaires.find(item => item.id === id);
      if (!lum) return;
      this.dragging = { ...common, initX: lum.x, initY: lum.y };
    } else if (kind === 'track') {
      const track = this.scene.tracks.find(item => item.id === id);
      if (!track) return;
      this.dragging = { ...common, initPoints: track.points.map(point => ({ ...point })) };
    } else if (kind === 'track-handle') {
      const track = this.scene.tracks.find(item => item.id === id);
      const pointIdx = extra.pointIdx;
      if (!track || !Number.isInteger(pointIdx) || !track.points[pointIdx]) return;
      this.dragging = {
        ...common, pointIdx,
        initX: track.points[pointIdx].x, initY: track.points[pointIdx].y,
      };
    }
    if (!this.dragging) return;
    const move = moveEvent => this._onPointerMove(moveEvent);
    const finish = () => {
      this._onPointerUp();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  }

  _onPointerMove3D(event) {
    const drag = this.dragging;
    if (!drag || !this._projection3d) return;
    const delta = this._projection3d.screenDeltaToWorld(
      event.clientX - drag.startClientX,
      event.clientY - drag.startClientY,
    );
    const room = this.project.room;
    const clampX = value => Math.max(0.05, Math.min(room.length - 0.05, value));
    const clampY = value => Math.max(0.05, Math.min(room.width - 0.05, value));

    if (drag.type === 'luminaire') {
      this.setScene(Scene.moveLuminaire(this.scene, drag.id, {
        x: clampX(drag.initX + delta.x), y: clampY(drag.initY + delta.y),
      }), { silent: true, record: false, preview: true });
    } else if (drag.type === 'track') {
      let dx = delta.x, dy = delta.y;
      for (const point of drag.initPoints) {
        if (point.x + dx < 0.1) dx = 0.1 - point.x;
        if (point.x + dx > room.length - 0.1) dx = room.length - 0.1 - point.x;
        if (point.y + dy < 0.1) dy = 0.1 - point.y;
        if (point.y + dy > room.width - 0.1) dy = room.width - 0.1 - point.y;
      }
      const restored = { ...this.scene, tracks: this.scene.tracks.map(track =>
        track.id === drag.id ? { ...track, points: drag.initPoints.map(point => ({ ...point })) } : track) };
      this.setScene(Scene.moveTrack(restored, drag.id, dx, dy),
        { silent: true, record: false, preview: true });
    } else if (drag.type === 'track-handle') {
      this.setScene(Scene.moveTrackPoint(this.scene, drag.id, drag.pointIdx, {
        x: clampX(drag.initX + delta.x), y: clampY(drag.initY + delta.y),
      }), { silent: true, record: false, preview: true });
    }
  }

  _renderZones(root) {
    const room = this.project.room;
    const zones = this.project.zones;
    if (!zones || zones.length === 0) return;
    const g = svgEl('g', { class: 'zones' });

    // Определяем режим: если хоть у одной зоны есть {x,y,w,h} — рисуем по факту
    // (свободный XY-редактор из шага 2). Иначе — legacy fallback (вертикальные полосы).
    const hasFreeXY = zones.some(z =>
      typeof z.x === 'number' && typeof z.w === 'number'
      && typeof z.y === 'number' && typeof z.h === 'number');

    if (hasFreeXY) {
      // Реальные координаты — рисуем каждую зону как прямоугольник {x,y,w,h}
      zones.forEach((z, i) => {
        // Отсутствующие поля — считаем как «полосу» на всю высоту (безопасный дефолт)
        const zx = typeof z.x === 'number' ? z.x : 0;
        const zy = typeof z.y === 'number' ? z.y : 0;
        const zw = typeof z.w === 'number' ? z.w : room.length;
        const zh = typeof z.h === 'number' ? z.h : room.width;

        const zn = this.db.norms.zones.find(nz => nz.id === z.zone_id);
        const fill = VP.zone[i % VP.zone.length];
        const stroke = VP.zoneStroke[i % VP.zoneStroke.length];

        g.appendChild(svgEl('rect', {
          x: this._X(zx), y: this._Y(zy),
          width: this._m2px(zw), height: this._m2px(zh),
          fill, stroke, 'stroke-width': 1.2, 'stroke-dasharray': '5,3',
          'data-kind': 'bg', rx: 2,
        }));
        if (zn) {
          // Подпись — по центру зоны, номер + название + люксы
          const cx = this._X(zx + zw / 2);
          const cy = this._Y(zy + zh / 2);
          g.appendChild(svgEl('text', {
            x: cx, y: cy - 4,
            'font-size': 11, fill: stroke, 'font-weight': 700,
            'text-anchor': 'middle', 'pointer-events': 'none',
          }, [`${i + 1}. ${zn.name}`]));
          g.appendChild(svgEl('text', {
            x: cx, y: cy + 10,
            'font-size': 9, fill: stroke,
            'text-anchor': 'middle', 'pointer-events': 'none', opacity: 0.85,
          }, [`${zn.lux} лк · ${zw.toFixed(1)}×${zh.toFixed(1)} м`]));
        }
      });
    } else {
      // Legacy: старые проекты без {x,y,w,h} — рисуем полосами
      const total = zones.reduce((s, z) => s + (z.area_share || 0), 0) || 1;
      let accX = 0;
      zones.forEach((z, i) => {
        const w = room.length * (z.area_share / total);
        const zn = this.db.norms.zones.find(nz => nz.id === z.zone_id);
        const fill = VP.zone[i % VP.zone.length];
        const stroke = VP.zoneStroke[i % VP.zoneStroke.length];
        g.appendChild(svgEl('rect', {
          x: this._X(accX), y: this._Y(0),
          width: this._m2px(w), height: this._m2px(room.width),
          fill, stroke, 'stroke-width': 1, 'stroke-dasharray': '5,3',
          'data-kind': 'bg',
        }));
        if (zn) {
          g.appendChild(svgEl('text', {
            x: this._X(accX + w / 2), y: this._Y(0.5),
            'font-size': 11, fill: stroke, 'font-weight': 600,
            'text-anchor': 'middle', 'pointer-events': 'none',
          }, [`${zn.name} (${zn.lux} лк)`]));
        }
        accX += w;
      });
    }
    root.appendChild(g);
  }

  _renderDims(root) {
    const room = this.project.room;
    const g = svgEl('g', { class: 'dims', 'pointer-events': 'none' });
    // Верхняя (длина)
    const yTop = this._Y(0) - 22;
    g.appendChild(svgEl('line', { x1: this._X(0), y1: yTop, x2: this._X(room.length), y2: yTop,
      stroke: '#5a5a5a', 'stroke-width': 1 }));
    g.appendChild(svgEl('line', { x1: this._X(0), y1: yTop - 4, x2: this._X(0), y2: yTop + 4, stroke: '#5a5a5a' }));
    g.appendChild(svgEl('line', { x1: this._X(room.length), y1: yTop - 4, x2: this._X(room.length), y2: yTop + 4, stroke: '#5a5a5a' }));
    g.appendChild(svgEl('text', { x: (this._X(0) + this._X(room.length)) / 2, y: yTop - 6,
      'font-size': 11, fill: VP.handle, 'text-anchor': 'middle', 'font-weight': 600 },
      [`${room.length.toFixed(1)} м`]));
    // Правая (ширина)
    const xRight = this._X(room.length) + 22;
    g.appendChild(svgEl('line', { x1: xRight, y1: this._Y(0), x2: xRight, y2: this._Y(room.width),
      stroke: '#5a5a5a', 'stroke-width': 1 }));
    g.appendChild(svgEl('text', { x: xRight + 6, y: (this._Y(0) + this._Y(room.width)) / 2,
      'font-size': 11, fill: VP.handle, 'font-weight': 600 },
      [`${room.width.toFixed(1)} м`]));
    root.appendChild(g);
  }

  /**
   * Рендерит теплокарту освещённости — фактическую E(x,y) в люксах.
   * Основной режим визуализации света (по умолчанию).
   */
  _renderHeatmap(root) {
    const room = this.project.room;
    const norm = pickNormLx(this.project, this.db.norms);
    // Ключ кэша — сцена + разрешение (перерисовываем только при изменениях)
    const cacheKey = this._makeHeatmapCacheKey();
    let cache = this._heatmapCache;
    // Во время непрерывного drag используем последнюю готовую теплокарту:
    // пересчёт сотен/тысяч ячеек на каждый pointermove блокировал интерфейс.
    const mayUseStalePreview = this._interactivePreview && cache;
    if (!cache || (!mayUseStalePreview && cache.key !== cacheKey)) {
      // Пересчитываем
      const withCat = this.scene.luminaires
        .map(lum => ({ ...lum, luminaire: this.db.catalog.find(p => p.slug === lum.slug) }))
        .filter(x => x.luminaire && x.luminaire.lumen);
      const fn = makeIlluminanceFunction(withCat, room, this.scene.tracks);
      const grid = buildIlluminanceGrid(fn, room, this.viewOptions.heatmapRes);
      cache = { key: cacheKey, grid, norm };
      this._heatmapCache = cache;
    }
    const { grid } = cache;

    if (grid.cols === 0 || grid.rows === 0) return;

    const cellPxX = this._m2px(grid.cellSize);
    const cellPxY = this._m2px(grid.cellSize);
    const g = svgEl('g', { class: 'heatmap', 'pointer-events': 'none' });

    // Рендерим сеткой прямоугольников. Для лучшего сглаживания используем rx.
    for (let j = 0; j < grid.rows; j++) {
      for (let i = 0; i < grid.cols; i++) {
        const lx = grid.grid[j][i];
        if (lx < 1) continue;   // не рисуем совсем тёмные ячейки
        const heat = lxToHeatColor(lx, norm, 0.55);
        const x = this._X(i * grid.cellSize);
        const y = this._Y(j * grid.cellSize);
        g.appendChild(svgEl('rect', {
          x, y,
          width: cellPxX + 0.5, height: cellPxY + 0.5,  // +0.5 чтобы не было щелей между ячейками
          fill: heat.fill,
        }));
      }
    }
    root.appendChild(g);

    // Легенда теплокарты (справа сверху вьюпорта)
    this._renderHeatmapLegend(root, grid, norm);
  }

  _makeHeatmapCacheKey() {
    // Компактный хэш сцены + размера комнаты
    const room = this.project.room;
    const l = this.scene.luminaires.map(lm => `${lm.slug}@${lm.x.toFixed(1)},${lm.y.toFixed(1)}@${lm.angle_deg}`).join('|');
    const t = this.scene.tracks.map(tr => tr.points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('~')).join('|');
    return `${room.length}x${room.width}x${room.height}#${this.viewOptions.heatmapRes}#${l}#${t}`;
  }

  /** Легенда теплокарты: цвета + значения в lx + агрегированная статистика */
  _renderHeatmapLegend(root, grid, norm) {
    // Ширина адаптивная: на узком мобильном вьюпорте не должна вылезать за край.
    const vb = this.svgEl.viewBox.baseVal;
    const W = Math.min(210, Math.max(150, vb.width - 64));
    const H = 92;
    // Кнопки масштабирования (ed-viewport-nav) — справа сверху; легенду
    // опускаем НИЖЕ их колонки, чтобы она не перекрывала кнопки (баг на мобильных).
    const navEl = this.viewportEl.querySelector('.ed-viewport-nav');
    const navH = navEl ? navEl.getBoundingClientRect().height : 0;
    const xR = Math.max(8, vb.width - W - 12);
    const yR = navH + 12;   // ниже кнопок nav

    const g = svgEl('g', { class: 'heatmap-legend', 'pointer-events': 'none',
      transform: `translate(${xR}, ${yR})` });

    // Фон
    g.appendChild(svgEl('rect', {
      x: 0, y: 0, width: W, height: H,
      fill: 'rgba(0,0,0,0.75)',
      stroke: 'rgba(0,212,255,0.4)', 'stroke-width': 1, rx: 4,
    }));

    // Заголовок
    g.appendChild(svgEl('text', {
      x: 8, y: 14, 'font-size': 10, fill: '#00d4ff', 'font-weight': 700,
    }, ['Освещённость (норма ' + norm + ' лк)']));

    // Градиент-полоска
    const barX = 8, barY = 22, barW = W - 16, barH = 12;
    const grad = svgEl('linearGradient', { id: 'heat-legend-grad', x1: '0%', x2: '100%' });
    // 0-20-50-85-115-150-200% нормы
    const steps = [
      { ratio: 0.10 },
      { ratio: 0.35 },
      { ratio: 0.65 },
      { ratio: 1.00 },
      { ratio: 1.30 },
      { ratio: 1.80 },
    ];
    steps.forEach((s, i) => {
      const c = lxToHeatColor(s.ratio * norm, norm, 1);
      grad.appendChild(svgEl('stop', {
        offset: `${(i / (steps.length - 1)) * 100}%`,
        'stop-color': c.fill.replace(/rgba?\(([^)]+)\)/, 'rgb($1)').replace(/,1?\.?\d*\)$/, ')').replace(/,\s*[\d.]+\)$/, ')'),
      }));
    });
    // fallback без парсинга rgba — просто hex-цвета
    grad.innerHTML = '';
    for (let i = 0; i < steps.length; i++) {
      const c = lxToHeatColor(steps[i].ratio * norm, norm, 1);
      const rgb = c.fill.match(/(\d+),(\d+),(\d+)/);
      if (!rgb) continue;
      const stop = svgEl('stop', {
        offset: `${(i / (steps.length - 1)) * 100}%`,
        'stop-color': `rgb(${rgb[1]},${rgb[2]},${rgb[3]})`,
      });
      grad.appendChild(stop);
    }
    // defs для градиента должен быть в родительском svg
    let defs = root.querySelector('defs');
    if (!defs) { defs = svgEl('defs'); root.insertBefore(defs, root.firstChild); }
    defs.appendChild(grad);

    g.appendChild(svgEl('rect', {
      x: barX, y: barY, width: barW, height: barH,
      fill: 'url(#heat-legend-grad)', rx: 2,
    }));

    // Подписи под полоской
    ['0%', '50%', '100%', '150%', '200%'].forEach((lbl, i) => {
      g.appendChild(svgEl('text', {
        x: barX + (i * barW / 4), y: barY + barH + 11,
        'font-size': 8, fill: '#d9d9d9', 'text-anchor': 'middle',
      }, [lbl]));
    });

    // Статистика
    let ok = 0, low = 0, high = 0, total = 0;
    for (const row of grid.grid) {
      for (const lx of row) {
        const r = lx / norm;
        total++;
        if (r < 0.85) low++;
        else if (r <= 1.15) ok++;
        else high++;
      }
    }
    const stat = `${grid.avgLx.toFixed(0)} лк среднее · норма ${Math.round(grid.avgLx/norm*100)}%`;
    g.appendChild(svgEl('text', {
      x: 8, y: barY + barH + 26, 'font-size': 10, fill: '#e6e6e6',
    }, [stat]));
    const cov = `✓ ${(ok/total*100).toFixed(0)}%   ⇩ ${(low/total*100).toFixed(0)}%   ⇧ ${(high/total*100).toFixed(0)}%`;
    g.appendChild(svgEl('text', {
      x: 8, y: barY + barH + 40, 'font-size': 9, fill: '#a0a0a0',
    }, [cov]));

    root.appendChild(g);
  }

  _renderBeams(root) {
    const room = this.project.room;
    const g = svgEl('g', { class: 'beams', 'pointer-events': 'none' });
    for (const lum of this.scene.luminaires) {
      const cat = this.db.catalog.find(p => p.slug === lum.slug);
      if (!cat) continue;

      const cct = getCCT(cat.cct_k);
      const type = resolveBeamType(cat, lum.lightType);
      const shape = getBeamShape(type);
      const limits = getRotationLimits(cat);
      const gradId = `ed-beam-${cct.K}-${type}`;

      // Радиус пятна на полу — по формуле R = h · tan(θ/2).
      // Для АСИММЕТРИЧНЫХ линз (LensLine / LensFold) есть два угла:
      //   beam_deg       — вдоль корпуса светильника (по трассе трека)
      //   beam_deg_cross — поперёк корпуса (по обе стороны от трека)
      // Если beam_deg_cross нет — берём тот же угол (симметрия).
      const beamAlong = cat.beam_deg || 60;
      const beamCross = cat.beam_deg_cross || beamAlong;
      const rAlong = room.height * Math.tan((beamAlong / 2) * Math.PI / 180);
      const rCross = room.height * Math.tan((beamCross / 2) * Math.PI / 180);
      // Beam-режим рисует ТОЛЬКО HOTSPOT (яркая центральная область), а не всю
      // геометрическую засветку. Полное поле освещённости лучше видно в lux-режиме.
      // Множитель 0.5 = область где освещённость > ~50% от максимума в центре.
      const HOTSPOT_FRACTION = 0.5;
      // Клампим большие пятна чтобы не выходили на всю комнату
      const maxR = Math.max(room.length, room.width) / 3;
      const rBaseAlong = Math.min(rAlong * HOTSPOT_FRACTION, maxR);
      const rBaseCross = Math.min(rCross * HOTSPOT_FRACTION, maxR);

      // Определяем ось трека под светильником (базовая ориентация линейных)
      let trackAngleDeg = 90;   // если светильник не на треке — по умолчанию вниз
      if (lum.on_track_id) {
        const track = this.scene.tracks.find(t => t.id === lum.on_track_id);
        if (track) {
          const segAngle = this._trackSegmentAngle(track, lum);
          if (segAngle !== null) trackAngleDeg = segAngle;
        }
      }

      // === Логика поворота (соответствует реальной механике светильника) ===
      // Пользовательский угол lum.angle_deg — АБСОЛЮТНЫЙ азимут на плане.
      // Для spot: угол = направление наклона. Если 90° (вниз) — пятно под ним.
      //           Если 0° (вправо) или 180° (влево) — пятно СМЕЩАЕТСЯ в ту сторону.
      // Для linear: угол = поворот КОРПУСА. По умолчанию вдоль трека.
      //           Если пользователь крутит ручку — эллипс поворачивается вокруг центра.
      // Встраиваемый направленный свет (БЕЗ поворота) — всегда СТРОГО ВНИЗ,
      // независимо от сохранённого угла (старые правки не сдвигают/не вращают пятно).
      const fixedDownlight = this._isFixedDownlight(cat);
      const userAngleDeg = fixedDownlight ? 90 : (lum.angle_deg != null ? lum.angle_deg : 90);

      // === Смещение центра пятна (только для spot с наклоном) ===
      // 90° = свет вниз, пятно под светильником.
      // Любое отклонение от 90° = наклон в горизонтали, центр смещается.
      // Формула: смещение = h · tan(отклонение от вертикали).
      // В UI ползунок 0..360 — мы интерпретируем 90° как «строго вниз», 60°/120° как небольшой наклон.
      let offsetX = 0, offsetY = 0, tiltMag = 0;
      let axisAngleDeg;
      if (shape.directional) {
        // Отклонение от вертикали 90°. Берём в диапазоне ±90° (0=правый край, 180=левый край)
        const tiltDeg = userAngleDeg - 90;                    // -90…+270
        const tiltNorm = ((tiltDeg + 180) % 360) - 180;       // → -180…+180
        // Реалистичный максимум наклона трекового спота ≈ 45°
        // (при большем угле шарнир упрётся + свет уйдёт в стену)
        const clampedTilt = Math.max(-45, Math.min(45, tiltNorm));
        // Величина смещения пятна на полу
        const shiftM = room.height * Math.tan(Math.abs(clampedTilt) * Math.PI / 180);
        // Направление смещения — заданный азимут пользователя
        const azimuthRad = userAngleDeg * Math.PI / 180;
        // Компоненты смещения в м; знак sign(clampedTilt) — если наклон отрицательный, смещаем в другую сторону
        const sign = clampedTilt >= 0 ? 1 : -1;
        offsetX = Math.cos(azimuthRad) * shiftM * sign;
        offsetY = Math.sin(azimuthRad) * shiftM * sign;
        tiltMag = Math.abs(clampedTilt);
        // Для spot ротация эллипса — по направлению смещения (для наглядной вытянутости).
        axisAngleDeg = userAngleDeg;
      } else {
        // Linear: базовая ориентация = ось трека, + пользовательский поворот КОРПУСА
        // Дельта относительно трека:
        const deltaFromTrack = ((userAngleDeg - 90) % 360);   // 90° = по умолчанию (не повернут)
        axisAngleDeg = trackAngleDeg + deltaFromTrack;
      }

      // Центр пятна на плане (с учётом смещения от наклона)
      const cx = this._X(lum.x + offsetX);
      const cy = this._Y(lum.y + offsetY);

      // === Размеры пятна ===
      // Для spot с наклоном пятно вытягивается: rxPx (в направлении наклона) растёт,
      // ryPx (поперёк) — практически не меняется.
      let rxPx, ryPx;
      if (!shape.directional) {
        // ЛИНЕЙНЫЙ: rx (вдоль корпуса) = длинная ось, ry (поперёк) = короткая
        rxPx = this._m2px(rBaseAlong);
        ryPx = this._m2px(rBaseCross);
        if (!cat.beam_deg_cross && shape.elongation !== 1) {
          rxPx = this._m2px(rBaseAlong * shape.elongation / 2);
          ryPx = this._m2px(rBaseAlong / (shape.elongation / 2 || 1));
        }
      } else {
        // ТОЧЕЧНЫЙ: базово круг, при наклоне растягивается вдоль направления наклона
        // Коэффициент растяжения = 1 / cos(tilt) (проекция наклонного конуса на плоскость)
        const tiltRad = tiltMag * Math.PI / 180;
        const stretch = 1 / Math.max(0.4, Math.cos(tiltRad));   // не даём стать бесконечным
        rxPx = this._m2px(rBaseAlong * stretch);
        ryPx = this._m2px(rBaseAlong);
      }

      // Рисуем — прямоугольник для рассеивателя, эллипс для линзы/точечного
      if (shape.shape === 'rect') {
        const w = rxPx * 2, h = ryPx * 2;
        g.appendChild(svgEl('rect', {
          x: cx - rxPx, y: cy - ryPx,
          width: w, height: h,
          rx: ryPx * 0.4,
          fill: `url(#${gradId})`,
          transform: `rotate(${axisAngleDeg} ${cx} ${cy})`,
        }));
      } else {
        g.appendChild(svgEl('ellipse', {
          cx: cx, cy: cy,
          rx: rxPx, ry: ryPx,
          fill: `url(#${gradId})`,
          transform: `rotate(${axisAngleDeg} ${cx} ${cy})`,
        }));
      }

      // Для spot с наклоном рисуем линию «источник → центр пятна» — визуальный
      // индикатор направления света. Для linear ничего дополнительно не нужно
      // (поворот эллипса сам показывает ориентацию).
      if (shape.directional && tiltMag > 3) {
        const srcX = this._X(lum.x), srcY = this._Y(lum.y);
        g.appendChild(svgEl('line', {
          x1: srcX, y1: srcY, x2: cx, y2: cy,
          stroke: cct.emitColor, 'stroke-width': 1.5,
          'stroke-dasharray': '3,2', opacity: 0.55,
        }));
      }
    }
    root.appendChild(g);
  }

  /** Угол (deg) первого попавшегося сегмента трека рядом со светильником */
  _trackSegmentAngle(track, lum) {
    if (!track || track.points.length < 2) return null;
    // ищем ближайший сегмент к точке lum
    let bestDist = Infinity, bestAngle = 0;
    for (let i = 1; i < track.points.length; i++) {
      const a = track.points[i - 1], b = track.points[i];
      const dx = b.x - a.x, dy = b.y - a.y;
      const segLen2 = dx * dx + dy * dy;
      if (segLen2 < 1e-9) continue;
      let t = ((lum.x - a.x) * dx + (lum.y - a.y) * dy) / segLen2;
      t = Math.max(0, Math.min(1, t));
      const projX = a.x + dx * t;
      const projY = a.y + dy * t;
      const d = Math.hypot(lum.x - projX, lum.y - projY);
      if (d < bestDist) {
        bestDist = d;
        bestAngle = Math.atan2(dy, dx) * 180 / Math.PI;
      }
    }
    return bestAngle;
  }

  _renderTracks(root) {
    const g = svgEl('g', { class: 'tracks' });
    for (const track of this.scene.tracks) {
      const isSel = this.selectedId === track.id;
      const isHov = this.hoveredId === track.id;
      const d = track.points.map((p, i) => (i === 0 ? 'M' : 'L') + ' ' + this._X(p.x) + ' ' + this._Y(p.y)).join(' ');

      // Тень
      g.appendChild(svgEl('path', {
        d, fill: 'none', stroke: VP.trackShadow,
        'stroke-width': isSel ? 14 : 10,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        'pointer-events': 'none',
      }));
      // Невидимая широкая hit-area делает тонкий трек доступным для пальца.
      if (this.isCoarsePointer) {
        const hitLine = svgEl('path', {
          d, fill: 'none', stroke: 'transparent', 'stroke-width': 36,
          'stroke-linecap': 'round', 'stroke-linejoin': 'round',
          'data-id': track.id, 'data-kind': 'track',
          style: 'cursor: move;',
        });
        this._attach(hitLine, track.id, 'track');
        g.appendChild(hitLine);
      }

      // Линия
      const line = svgEl('path', {
        d, fill: 'none',
        stroke: isSel ? VP.trackSel : (track.pinned ? VP.trackPinned : VP.track),
        'stroke-width': isSel || isHov ? 5 : 3,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        filter: 'url(#ed-glow-vp)',
        'data-id': track.id, 'data-kind': 'track',
        style: 'cursor: move;',
      });
      this._attach(line, track.id, 'track');
      g.appendChild(line);

      // Ручки на концах (только выделенный трек)
      if (isSel) {
        track.points.forEach((p, idx) => {
          const isEnd = idx === 0 || idx === track.points.length - 1;
          const handleSize = this.isCoarsePointer ? 24 : 14;
          const h = svgEl('rect', {
            x: this._X(p.x) - handleSize / 2, y: this._Y(p.y) - handleSize / 2,
            width: handleSize, height: handleSize,
            fill: isEnd ? VP.handleHot : VP.handle,
            stroke: '#000', 'stroke-width': 2, rx: 2,
            'data-id': track.id, 'data-kind': 'track-handle',
            style: 'cursor: crosshair;',
          });
          this._attach(h, track.id, 'track-handle', { pointIdx: idx });
          g.appendChild(h);
        });
      }

      // Токоподводы — отмечаем иконкой на треках в соответствии с настройкой
      // количества питающих (feedMode/feeds). По умолчанию — 1 на 1-й трек.
      if (this.scene.tracks.length > 0) {
        const idx = this.scene.tracks.indexOf(track);
        const feedCount = this._feederCount();
        if (feedCount > 0 && idx < feedCount) {
          const p = track.points[0];
          g.appendChild(svgEl('rect', {
            x: this._X(p.x) - 7, y: this._Y(p.y) - 7,
            width: 14, height: 14,
            fill: VP.psu, stroke: '#000', 'stroke-width': 2, rx: 2,
            'pointer-events': 'none',
          }));
          g.appendChild(svgEl('text', {
            x: this._X(p.x), y: this._Y(p.y) + 4,
            'font-size': 12, fill: '#fff', 'text-anchor': 'middle',
            'font-weight': 700, 'pointer-events': 'none',
          }, ['⚡']));
        }
      }
    }
    root.appendChild(g);
  }

  /** Количество токоподводов по настройке системы (из проекта). */
  _feederCount() {
    const sys = this.project?.system || {};
    if (sys.feedMode === 'manual') {
      const n = parseInt(sys.feeds, 10);
      return Number.isFinite(n) ? Math.max(0, Math.min(12, n)) : 1;
    }
    return 1;   // авто: 1 токоподвод (на 1-й трек)
  }

  _renderLuminaires(root) {
    const g = svgEl('g', { class: 'luminaires' });
    for (const lum of this.scene.luminaires) {
      const isSel = this.selectedId === lum.id;
      const isHov = this.hoveredId === lum.id;
      // Цвет ободка светильника отражает CCT (тёплый = янтарь, холодный = голубой)
      const cat = this.db.catalog.find(p => p.slug === lum.slug);
      const cct = cat ? getCCT(cat.cct_k) : null;
      const baseColor = cct ? cct.emitColor : VP.luminaire;
      const color = isSel ? VP.luminaireSel : (lum.pinned ? VP.luminairePin : baseColor);
      const r = isSel ? 10 : (isHov ? 9 : 7);

      const grp = svgEl('g', {
        'data-id': lum.id, 'data-kind': 'luminaire',
        style: 'cursor: grab;',
        transform: `translate(${this._X(lum.x)}, ${this._Y(lum.y)})`,
      });
      if (this.isCoarsePointer) {
        grp.appendChild(svgEl('circle', {
          cx: 0, cy: 0, r: 22, fill: 'transparent', stroke: 'none', 'pointer-events': 'all',
        }));
      }
      grp.appendChild(svgEl('circle', { cx: 0, cy: 0, r, fill: color, stroke: '#000', 'stroke-width': 1.5 }));
      grp.appendChild(svgEl('circle', { cx: 0, cy: 0, r: 2.5, fill: '#000', 'pointer-events': 'none' }));

      if (lum.pinned) {
        grp.appendChild(svgEl('circle', {
          cx: r * 0.85, cy: -r * 0.85, r: 3.5,
          fill: VP.psu, stroke: '#fff', 'stroke-width': 1,
          'pointer-events': 'none',
        }));
      }

      this._attach(grp, lum.id, 'luminaire');

      // Ручка вращения — для выделенного, если светильник поворотный
      if (isSel) {
        const type = resolveBeamType(cat, lum.lightType);
        const shape = getBeamShape(type);
        const limits = getRotationLimits(cat);

        if (shape.directional && limits.canRotateH) {
          // Определяем ось трека (базовая ориентация ограничения)
          let trackAngleDeg = 90;   // по умолчанию — вниз
          if (lum.on_track_id) {
            const track = this.scene.tracks.find(t => t.id === lum.on_track_id);
            if (track) {
              const a = this._trackSegmentAngle(track, lum);
              if (a !== null) trackAngleDeg = a;
            }
          }

          // Сектор допустимых углов относительно оси трека
          const halfSpread = Math.min(180, limits.maxH / 2);
          // Рисуем сектор-подсказку (легкая заливка)
          if (halfSpread < 175) {
            grp.appendChild(this._buildRotationSector(trackAngleDeg, halfSpread, 28));
          }

          // Стрелка направления
          const arrowLen = 32;
          const rad = (lum.angle_deg || 90) * Math.PI / 180;
          const ax = Math.cos(rad) * arrowLen;
          const ay = Math.sin(rad) * arrowLen;
          grp.appendChild(svgEl('line', {
            x1: 0, y1: 0, x2: ax, y2: ay,
            stroke: VP.handle, 'stroke-width': 2,
            'pointer-events': 'none',
          }));
          const rh = svgEl('circle', {
            cx: ax, cy: ay, r: this.isCoarsePointer ? 16 : 7,
            fill: VP.handleHot, stroke: '#000', 'stroke-width': 2,
            'data-id': lum.id, 'data-kind': 'lum-rotate',
            style: 'cursor: alias;',
          });
          rh._trackAngle = trackAngleDeg;    // сохраняем на элементе для использования при drag
          rh._maxH = limits.maxH;
          this._attach(rh, lum.id, 'lum-rotate');
          grp.appendChild(rh);
        } else if (!shape.directional) {
          // Линейный светильник — стрелка вдоль трека (только индикация, без drag).
          // Для ВСТРАИВАЕМОГО направленного света (фиксированный вниз) стрелку НЕ рисуем:
          // свет идёт строго вниз, без направления по треку.
          if (!this._isFixedDownlight(cat)) {
            let trackAngleDeg = 90;
            if (lum.on_track_id) {
              const track = this.scene.tracks.find(t => t.id === lum.on_track_id);
              if (track) {
                const a = this._trackSegmentAngle(track, lum);
                if (a !== null) trackAngleDeg = a;
              }
            }
            const rad = trackAngleDeg * Math.PI / 180;
            const arrowLen = 24;
            const ax = Math.cos(rad) * arrowLen;
            const ay = Math.sin(rad) * arrowLen;
            grp.appendChild(svgEl('line', {
              x1: -ax, y1: -ay, x2: ax, y2: ay,
              stroke: VP.handle, 'stroke-width': 2, 'stroke-dasharray': '3,2',
              'pointer-events': 'none', opacity: 0.6,
            }));
          }
        }
      }

      g.appendChild(grp);
    }
    root.appendChild(g);
  }

  /** Рисует сектор допустимых углов вращения (визуализация ограничения) */
  _buildRotationSector(centerAngleDeg, halfSpreadDeg, radius) {
    const g = svgEl('g', { 'pointer-events': 'none', opacity: 0.25 });
    const startA = (centerAngleDeg - halfSpreadDeg) * Math.PI / 180;
    const endA = (centerAngleDeg + halfSpreadDeg) * Math.PI / 180;
    const x1 = Math.cos(startA) * radius;
    const y1 = Math.sin(startA) * radius;
    const x2 = Math.cos(endA) * radius;
    const y2 = Math.sin(endA) * radius;
    const large = halfSpreadDeg > 90 ? 1 : 0;
    const d = `M 0 0 L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
    g.appendChild(svgEl('path', { d, fill: VP.handle, stroke: 'none' }));
    return g;
  }

  // ============================================================
  // Interaction: pointer events
  // ============================================================
  _startViewportPan(e) {
    if (this.panning) return;
    this.panning = {
      kind: this.viewOptions.viewMode === '3d' ? 'orbit' : 'pan',
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      initPanX: this.vp.panX,
      initPanY: this.vp.panY,
      initYaw: this.camera3d.yaw,
      initPitch: this.camera3d.pitch,
    };
    const move = (event) => {
      if (event.pointerId !== this.panning?.pointerId) return;
      this._onPointerMove(event);
    };
    const finish = (event) => {
      if (event.pointerId !== this.panning?.pointerId) return;
      this.panning = null;
      if (this.viewOptions.viewMode === '3d') this._renderToolbar();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  }

  _attach(el, id, kind, extra = {}) {
    el.addEventListener('pointerenter', () => {
      this.hoveredId = id;
      this._renderStatusbar();
    });
    el.addEventListener('pointerleave', () => {
      if (this.hoveredId === id) { this.hoveredId = null; this._renderStatusbar(); }
    });
    el.addEventListener('pointerdown', (e) => this._onPointerDown(e, id, kind, extra));
  }

  _onPointerDown(e, id, kind, extra) {
    if (e.button !== 0) return;   // только ЛКМ
    e.preventDefault(); e.stopPropagation();
    this._select(id);
    const pt = this._svgPoint(e);
    const mx = this._pxToMx(pt.x), my = this._pxToMy(pt.y);

    // Начало непрерывного жеста — один снимок «до» для Undo
    this._beginGesture();

    if (kind === 'luminaire') {
      this.dragging = { type: 'luminaire', id };
    } else if (kind === 'lum-rotate') {
      const lum = this.scene.luminaires.find(l => l.id === id);
      if (!lum) return;
      const cat = this.db.catalog.find(p => p.slug === lum.slug);
      const limits = cat ? getRotationLimits(cat) : { canRotateH: true, maxH: 350 };
      // Определяем ось трека (базовое направление)
      let trackAngle = 90;
      if (lum.on_track_id) {
        const track = this.scene.tracks.find(t => t.id === lum.on_track_id);
        if (track) {
          const a = this._trackSegmentAngle(track, lum);
          if (a !== null) trackAngle = a;
        }
      }
      this.dragging = { type: 'lum-rotate', id, cx: lum.x, cy: lum.y, trackAngle, maxH: limits.maxH };
    } else if (kind === 'track') {
      const trk = this.scene.tracks.find(t => t.id === id);
      if (!trk) return;
      this.dragging = { type: 'track', id, startX: mx, startY: my,
                        initPoints: trk.points.map(p => ({ ...p })) };
    } else if (kind === 'track-handle') {
      this.dragging = { type: 'track-handle', id, pointIdx: extra.pointIdx };
    }
    try { e.target.setPointerCapture?.(e.pointerId); } catch {}

    const mv = (ev) => this._onPointerMove(ev);
    const finish = () => {
      this._onPointerUp();
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', finish);
    // На touch/pen браузер может прислать pointercancel вместо pointerup.
    // Это тоже финализирует сцену и отправляет её в итоговый расчёт.
    window.addEventListener('pointercancel', finish);
  }

  _onPointerMove(e) {
    // Панорамирование?
    if (this.panning) {
      if (this.panning.kind === 'orbit') {
        this.camera3d.yaw = this.panning.initYaw + (e.clientX - this.panning.startX) * 0.35;
        this.camera3d.pitch = Math.max(12, Math.min(72,
          this.panning.initPitch - (e.clientY - this.panning.startY) * 0.25));
      } else {
        const dx = (e.clientX - this.panning.startX) / this._scale;
        const dy = (e.clientY - this.panning.startY) / this._scale;
        this.vp.panX = this.panning.initPanX + dx;
        this.vp.panY = this.panning.initPanY + dy;
      }
      this._renderViewport();
      return;
    }
    if (!this.dragging) return;
    if (this.dragging.view === '3d') {
      this._onPointerMove3D(e);
      return;
    }

    const pt = this._svgPoint(e);
    const mx = this._pxToMx(pt.x), my = this._pxToMy(pt.y);
    const room = this.project.room;
    const cmx = Math.max(0.05, Math.min(room.length - 0.05, mx));
    const cmy = Math.max(0.05, Math.min(room.width - 0.05, my));
    const d = this.dragging;

    if (d.type === 'luminaire') {
      this.setScene(Scene.moveLuminaire(this.scene, d.id, { x: cmx, y: cmy }),
        { silent: true, record: false, preview: true });
    } else if (d.type === 'lum-rotate') {
      const dx = cmx - d.cx, dy = cmy - d.cy;
      let a = Math.atan2(dy, dx) * 180 / Math.PI;
      // Клампим угол в пределах допустимого сектора относительно оси трека
      const halfSpread = Math.min(180, (d.maxH || 350) / 2);
      let delta = normalizeAngle(a - d.trackAngle);
      if (delta > halfSpread) delta = halfSpread;
      if (delta < -halfSpread) delta = -halfSpread;
      a = normalizeAngle(d.trackAngle + delta);
      this.setScene(Scene.setLuminaireAngle(this.scene, d.id, Math.round(a)),
        { silent: true, record: false, preview: true });
    } else if (d.type === 'track') {
      const dxM = mx - d.startX, dyM = my - d.startY;
      let clampDx = dxM, clampDy = dyM;
      for (const p of d.initPoints) {
        if (p.x + clampDx < 0.1) clampDx = 0.1 - p.x;
        if (p.x + clampDx > room.length - 0.1) clampDx = room.length - 0.1 - p.x;
        if (p.y + clampDy < 0.1) clampDy = 0.1 - p.y;
        if (p.y + clampDy > room.width - 0.1) clampDy = room.width - 0.1 - p.y;
      }
      const restored = { ...this.scene, tracks: this.scene.tracks.map(t =>
        t.id === d.id ? { ...t, points: d.initPoints.map(p => ({ ...p })) } : t) };
      this.setScene(Scene.moveTrack(restored, d.id, clampDx, clampDy),
        { silent: true, record: false, preview: true });
    } else if (d.type === 'track-handle') {
      this.setScene(Scene.moveTrackPoint(this.scene, d.id, d.pointIdx, { x: cmx, y: cmy }),
        { silent: true, record: false, preview: true });
    }
  }

  _onPointerUp() {
    if (this.panning) { this.panning = null; return; }
    if (!this.dragging) return;
    this.dragging = null;
    // Конец непрерывного жеста — если были реальные изменения,
    // фиксируем их как ОДИН шаг отмены и только теперь пересчитываем heatmap/BOM.
    this._endGesture();
    this._finishInteractiveChange();
  }

  _onCanvasDrop(e) {
    e.preventDefault();
    let payload = this.paletteDrag;
    if (!payload) {
      try {
        const raw = e.dataTransfer.getData('text/plain');
        if (raw) payload = JSON.parse(raw);
      } catch {}
    }
    if (!payload) return;
    const pt = this._svgPoint(e);
    let mx, my;
    if (this.viewOptions.viewMode === '3d' && this._projection3d) {
      const world = this._projection3d.screenToWorld(pt.x, pt.y, 0);
      mx = world.x; my = world.y;
    } else {
      mx = this._pxToMx(pt.x); my = this._pxToMy(pt.y);
    }
    mx = Math.max(0.05, Math.min(this.project.room.length - 0.05, mx));
    my = Math.max(0.05, Math.min(this.project.room.width - 0.05, my));
    let newScene;
    if (payload.kind === 'luminaire') {
      newScene = Scene.addLuminaire(this.scene, { x: mx, y: my, slug: payload.slug });
    } else if (payload.kind === 'track') {
      newScene = Scene.addTrack(this.scene, {
        x: Math.max(0.2, mx - (payload.length || 2) / 2),
        y: my,
        voltage_v: this.project.system.voltage_v,
        color: this.project.system.color,
        mount: this.project.system.mount,
        lengthM: payload.length || 2,
      });
    }
    this.paletteDrag = null;
    if (newScene) this.setScene(newScene);
  }

  _svgPoint(e) {
    const rect = this.svgHostEl.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ============================================================
  // Viewport controls
  // ============================================================
  _zoomBy(factor) {
    const rect = this.svgHostEl.getBoundingClientRect();
    this._zoomAt(factor, rect.width / 2, rect.height / 2);
  }
  _zoomAt(factor, cx, cy) {
    if (this.viewOptions.viewMode === '3d') {
      this.camera3d.zoom = Math.max(0.35, Math.min(4, this.camera3d.zoom * factor));
      this._renderViewport();
      this._renderToolbar();
      return;
    }
    const newZoom = Math.max(0.2, Math.min(8, this.vp.zoom * factor));
    // Компенсируем pan чтобы зум был к курсору
    const oldScale = this._scale;
    const mxAtCursor = this._pxToMx(cx);
    const myAtCursor = this._pxToMy(cy);
    this.vp.zoom = newZoom;
    // После обновления zoom пересчитаем и подкорректируем pan
    // Сначала посмотрим где окажется точка после нового scale
    this._renderViewport();
    const newMxAt = this._pxToMx(cx);
    const newMyAt = this._pxToMy(cy);
    this.vp.panX += (mxAtCursor - newMxAt);
    this.vp.panY += (myAtCursor - newMyAt);
    this._renderViewport();
    this._renderToolbar();
  }
  _fitViewport() {
    if (this.viewOptions.viewMode === '3d') {
      this.camera3d = { ...R3D.DEFAULT_CAMERA };
    } else {
      this.vp = { zoom: 1, panX: 0, panY: 0 };
    }
    this._renderViewport();
    this._renderToolbar();
  }

  // ============================================================
  // KEYBOARD
  // ============================================================
  _attachKeyboard() {
    this._spaceHeld = false;
    this._keyHandler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
      const mod = e.ctrlKey || e.metaKey;   // Ctrl (или Cmd на Mac)

      // === ===== Сочетания с Ctrl/Cmd (в приоритете!) ===== ===
      if (mod) {
        const k = (e.key || '').toLowerCase();
        if (k === 'z') {
          e.preventDefault();
          // Ctrl+Shift+Z = Redo (как в большинстве редакторов)
          if (e.shiftKey) this.redo(); else this.undo();
          return;
        }
        if (k === 'y') {
          e.preventDefault(); this.redo(); return;
        }
        if (k === 'c') {
          e.preventDefault(); this.copySelected(); return;
        }
        if (k === 'v') {
          e.preventDefault(); this.pasteClipboard(); return;
        }
        if (k === 's') {
          e.preventDefault(); this.save(); return;
        }
        // Не перехватываем прочие Ctrl-комбинации (браузерные)
        return;
      }

      if (e.key === ' ') { e.preventDefault(); this._spaceHeld = true; return; }
      if (e.key === 'f' || e.key === 'F') { this._fitViewport(); return; }
      if (e.key === '+' || e.key === '=') { this._zoomBy(1.2); return; }
      if (e.key === '-') { this._zoomBy(0.8); return; }
      if (e.key === 'Escape') { this._select(null); return; }
      if (!this.selectedId) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        this._recordUndo(this.scene);   // фиксируем «до» для возможной отмены
        const s = Scene.removeObject(this.scene, this.selectedId);
        this.selectedId = null;
        this.setScene(s, { record: false });
      } else if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        const step = e.shiftKey ? 0.5 : 0.1;
        const lum = this.scene.luminaires.find(l => l.id === this.selectedId);
        if (!lum) return;
        let dx = 0, dy = 0;
        if (e.key === 'ArrowLeft') dx = -step;
        if (e.key === 'ArrowRight') dx = step;
        if (e.key === 'ArrowUp') dy = -step;
        if (e.key === 'ArrowDown') dy = step;
        this.setScene(Scene.moveLuminaire(this.scene, lum.id, { x: lum.x + dx, y: lum.y + dy }));
      }
    };
    this._keyUpHandler = (e) => {
      if (e.key === ' ') this._spaceHeld = false;
    };
    window.addEventListener('keydown', this._keyHandler);
    window.addEventListener('keyup', this._keyUpHandler);
  }

  // ============================================================
  // RIGHT PANEL: свойства + роллауты
  // ============================================================
  _renderRightPanel() {
    this.rightPanelEl.innerHTML = '';
    // Явный класс свёрнутой панели: CSS на мобильном гарантированно прячет её.
    this.rightPanelEl.classList.toggle('collapsed', this.rightCollapsed);
    if (this.rightCollapsed) {
      // На мобильном свёрнутая панель не рендерится совсем (не занимает экран).
      if (this.isMobile) return;
      this.rightPanelEl.appendChild(el('div', {
        class: 'ed-panel-collapsed',
        onClick: () => this._toggleRight(),
      }, 'СВОЙСТВА ▶'));
      return;
    }

    this.rightPanelEl.appendChild(el('div', { class: 'ed-panel-header' },
      el('button', {
        class: 'ed-panel-collapse', title: 'Закрыть панель', 'aria-label': 'Закрыть свойства',
        onClick: () => this._toggleRight(),
      }, this.isMobile ? '×' : '▶'),
      el('div', { class: 'ed-panel-title' }, 'Свойства'),
    ));

    const body = el('div', { class: 'ed-panel-body' });

    // Приоритет: 1) выделено на плане, 2) выбрано в палитре, 3) заглушка
    const lum = this.selectedId ? this.scene.luminaires.find(l => l.id === this.selectedId) : null;
    const track = this.selectedId ? this.scene.tracks.find(t => t.id === this.selectedId) : null;

    if (lum) {
      this._buildLuminaireProps(body, lum);
    } else if (track) {
      this._buildTrackProps(body, track);
    } else if (this.selectedProductFromPalette) {
      // Показываем свойства товара из палитры (без действий сцены)
      this._buildProductProps(body, this.selectedProductFromPalette);
    } else {
      body.appendChild(el('div', { class: 'ed-prop-empty' },
        el('div', { style: { fontSize: '24px', marginBottom: '8px' } }, '▢'),
        'Выберите объект на плане или в палитре — здесь появятся его параметры и характеристики.',
        el('div', { style: { marginTop: '12px', color: 'var(--ed-text-dim)' } },
          'Общая статистика сцены — в статус-баре внизу'),
      ));
    }

    this.rightPanelEl.appendChild(body);
  }

  _renderRightDock() { this._renderRightPanel(); }

  _rollout(title, key, ...body) {
    const isOpen = this.rollouts[key];
    return el('div', { class: 'ed-rollout' + (isOpen ? ' open' : '') },
      el('div', {
        class: 'ed-rollout-header',
        onClick: (e) => {
          this.rollouts[key] = !this.rollouts[key];
          e.currentTarget.parentElement.classList.toggle('open');
        },
      },
        el('span', { class: 'ed-rollout-caret' }, '▶'),
        el('span', {}, title),
      ),
      el('div', { class: 'ed-rollout-body' }, ...body),
    );
  }

  /** Просмотр товара из палитры (клик по товару) — без действий сцены */
  _buildProductProps(host, cat) {
    host.appendChild(el('div', { class: 'ed-prop-obj' },
      el('div', { class: 'ed-prop-kind' }, this._roleLabel(cat.role)),
      el('div', { class: 'ed-prop-name' }, cat.name),
      cat.description ? el('div', { class: 'ed-prop-desc' }, cat.description) : null,
    ));

    host.appendChild(this._buildCatalogRollout(cat));
    host.appendChild(this._buildActionsRollout(cat));
  }

  /** Rollout «Характеристики» с ПОЛНЫМИ данными карточки товара */
  _buildCatalogRollout(cat) {
    const rows = [];
    const addRow = (k, v, opts = {}) => {
      if (v == null || v === '' || v === false) return;
      const vEl = typeof v === 'string' || typeof v === 'number'
        ? (opts.bold ? el('span', { class: 'v' }, el('b', {}, String(v))) : el('span', { class: 'v' }, String(v)))
        : el('span', { class: 'v' }, v);
      rows.push(el('div', { class: 'ed-prop-row' }, el('span', { class: 'k' }, k + ':'), vEl));
    };

    // 1) Артикул и цена
    if (cat.sku) addRow('Артикул', cat.sku);
    if (cat.price_rub) addRow('Цена', cat.price_rub.toLocaleString('ru-RU') + ' ₽', { bold: true });
    if (cat.subcategory) addRow('Категория', cat.subcategory);

    // 2) Электрика
    if (cat.voltage_v) addRow('Напряжение', cat.voltage_v + ' В', { bold: true });
    if (cat.power_w) {
      // Для «под лампу» — показываем реальную мощность LED-лампы + max допустимую
      if (cat.max_lamp_w && cat.max_lamp_w !== cat.power_w) {
        addRow('Мощность',
          el('span', {},
            el('b', {}, cat.power_w + ' Вт'),
            el('span', { style: { color: 'var(--ed-text-mut)', marginLeft: '6px', fontSize: '10px' } },
              `(типовая LED, max: ${cat.max_lamp_w}Вт)`),
          ));
      } else {
        addRow('Мощность', cat.power_w + ' Вт', { bold: true });
      }
    }

    // 3) Оптика
    if (cat.lumen) {
      const lmSuffix = cat.tags?.includes('power_from_lamp') ? ' (LED-лампа)' :
                       cat.tags?.includes('lumen_estimated') ? ' (≈ оценка)' : '';
      addRow('Световой поток',
        lmSuffix
          ? el('span', {}, el('b', {}, cat.lumen + ' лм'), el('span', { style: { color: 'var(--ed-text-mut)', fontSize: '10px', marginLeft: '4px' } }, lmSuffix))
          : cat.lumen + ' лм');
    }
    // Угол — с учётом асимметрии для линейных
    if (cat.beam_deg) {
      const angleTxt = (cat.beam_deg_cross && cat.beam_deg_cross !== cat.beam_deg)
        ? `${cat.beam_deg}° × ${cat.beam_deg_cross}° (продольно × поперёк)`
        : cat.beam_deg + '°';
      addRow('Угол рассеивания', angleTxt);
    }
    if (cat.cri) addRow('CRI', cat.cri + (cat.cri >= 90 ? ' (высокая цветопередача)' : ''));

    // 4) Температура (с чипом)
    if (cat.cct_k) {
      const cctInfo = getCCT(cat.cct_k);
      addRow('Температура',
        el('span', {},
          el('span', {
            style: {
              display: 'inline-block', padding: '2px 8px', borderRadius: '3px',
              background: cctInfo.emitColor, color: cctInfo.textColor,
              fontWeight: '700', fontSize: '10px', marginRight: '6px',
            },
          }, cctInfo.short),
          cctInfo.label,
        ));
    }

    // 5) Тип пятна
    if (cat.role === 'luminaire' || cat.role === 'downlight_luminaire') {
      const beamInfo = getBeamShape(inferLuminaireType(cat));
      addRow('Тип пятна', beamInfo.label);
    }

    // 6) Серия
    if (cat.series) addRow('Серия', cat.series);

    // 7) Габариты (для треков)
    if (cat.length_m) addRow('Длина', cat.length_m + ' м');
    if (cat.color) addRow('Цвет корпуса', cat.color === 'black' ? 'чёрный' : cat.color === 'white' ? 'белый' : cat.color);

    // 8) Механика — поворотные возможности
    if (cat.rot_h_deg != null || cat.rot_v_deg != null) {
      if (cat.rot_h_deg != null) {
        const hLabel = cat.rot_h_deg === 0 ? 'не поворотный' :
                        cat.rot_h_deg >= 350 ? `${cat.rot_h_deg}° (почти полный оборот)` :
                        cat.rot_h_deg >= 180 ? `${cat.rot_h_deg}° (широкий диапазон)` :
                        `${cat.rot_h_deg}° (ограничен)`;
        addRow('Поворот гориз.', hLabel);
      }
      if (cat.rot_v_deg != null) {
        const vLabel = cat.rot_v_deg === 0 ? 'фиксированный' :
                        cat.rot_v_deg >= 90 ? `${cat.rot_v_deg}° (наклон вверх/вниз)` :
                        `${cat.rot_v_deg}°`;
        addRow('Наклон верт.', vLabel);
      }
    }

    // 9) Монтаж и лампа
    if (cat.mount_type) addRow('Монтаж', cat.mount_type);
    if (cat.lamp_base) addRow('Цоколь', cat.lamp_base);
    if (cat.ip) addRow('Влагозащита', cat.ip);

    // 10) Наличие
    addRow('Наличие', cat.in_stock ? '✓ в наличии' : 'под заказ');

    // 11) Флаги/теги
    if (cat.tags && cat.tags.length > 0) {
      addRow('Особенности', cat.tags.map(t => ({
        lamp_required: 'под сменную лампу',
        power_assumed: 'мощность оценочная',
      }[t] || t)).join(', '));
    }

    // 12) Ссылка на карточку
    rows.push(el('div', { class: 'ed-prop-row-full' },
      el('a', {
        href: cat.product_url, target: '_blank', rel: 'noopener',
        class: 'ed-prop-link',
      }, '→ Открыть карточку товара на zima-led.ru'),
    ));

    return this._rollout('Характеристики', 'catalog', ...rows);
  }

  /** Rollout действий: добавить в корзину, копировать артикул */
  _buildActionsRollout(cat) {
    return this._rollout('Действия', 'catalog_actions',
      el('button', {
        class: 'ed-btn wide',
        style: { background: '#4a7fbf', color: '#fff', borderColor: '#4a7fbf' },
        onClick: async () => {
          if (window.__zlc_addOneToCart) {
            const ok = await window.__zlc_addOneToCart(cat);
            alert(ok ? '✓ Добавлено в корзину' : 'Не удалось добавить');
          }
        },
      }, '🛒 Добавить в корзину сайта'),
      el('button', {
        class: 'ed-btn wide', style: { marginTop: '4px' },
        onClick: () => window.open(cat.product_url, '_blank', 'noopener'),
      }, '↗ Открыть карточку товара'),
    );
  }

  _roleLabel(role) {
    return {
      luminaire: '● Светильник трековый',
      downlight_luminaire: '○ Светильник встраиваемый',
      shinoprovod: '━ Шинопровод',
      connector: '⌐ Коннектор',
      kit: '📦 Комплект',
      psu: '⚡ Блок питания',
      led_strip: '≡ LED лента',
      other: 'Прочее',
    }[role] || role;
  }

  _buildLuminaireProps(host, lum) {
    const cat = this.db.catalog.find(p => p.slug === lum.slug);
    if (!cat) return;

    host.appendChild(el('div', { class: 'ed-prop-obj' },
      el('div', { class: 'ed-prop-kind' }, this._roleLabel(cat.role)),
      el('div', { class: 'ed-prop-name' }, cat.name),
    ));

    // 1) Полные характеристики из каталога (наш универсальный блок)
    host.appendChild(this._buildCatalogRollout(cat));

    // 1.5) Управляемый тип света (для встраиваемых и трековых светильников).
    // Позволяет выбрать характер светового потока независимо от модели каталога.
    const isLightTypeApplicable = cat.role === 'downlight_luminaire' || cat.role === 'luminaire';
    if (isLightTypeApplicable) {
      const curLightType = lum.lightType || null;
      const curOpt = getLightTypeOption(curLightType);
      const ltSel = document.createElement('select');
      ltSel.className = 'ed-select';
      const placeholders = [
        el('option', { value: '', disabled: 'disabled' }, curOpt ? curOpt.label : '— по модели —'),
      ];
      ltSel.appendChild(placeholders[0]);
      for (const opt of LIGHT_TYPE_OPTIONS) {
        const o = document.createElement('option');
        o.value = opt.id;
        o.textContent = `${opt.icon} ${opt.label} — ${opt.desc}`;
        if (opt.id === curLightType) o.selected = true;
        ltSel.appendChild(o);
      }
      ltSel.addEventListener('change', (e) => {
        const v = e.target.value || null;
        this.setScene(Scene.setLuminaireLightType(this.scene, lum.id, v));
      });
      const ltHint = curOpt
        ? `Выбран «${curOpt.label}» (${curOpt.icon}) — пучок ${curOpt.desc.toLowerCase()}.`
        : 'Тип света взят из характеристик модели каталога. Переопределите здесь при необходимости.';
      host.appendChild(this._rollout('Тип света (пучок)', 'light_type', ltSel, el('div', { class: 'ed-prop-hint' }, ltHint)));
    }

    // 2) Замена модели (выпадающий список)
    const sel = document.createElement('select');
    sel.className = 'ed-select';
    // Показываем ВСЕ светильники того же напряжения (и без указанного напряжения — вдруг ошибка данных)
    const compatible = this.db.catalog.filter(p =>
      (p.role === 'luminaire' || p.role === 'downlight_luminaire')
      && p.in_stock !== false
      && (!p.voltage_v || !this.project.system.voltage_v || p.voltage_v === this.project.system.voltage_v)
    );
    for (const opt of compatible) {
      const o = document.createElement('option');
      o.value = opt.slug;
      o.textContent = `${(opt.name || '').slice(0, 50)}${opt.power_w ? ' — ' + opt.power_w + 'Вт' : ''}`;
      if (opt.slug === lum.slug) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', (e) => {
      this.setScene(Scene.setLuminaireModel(this.scene, lum.id, e.target.value));
    });
    host.appendChild(this._rollout('Заменить модель', 'model_change', sel));

    // Позиция
    const posBody = [
      el('div', { class: 'ed-prop-row' }, el('span', { class: 'k' }, 'X (м):'), el('span', { class: 'v' }, lum.x.toFixed(2))),
      el('div', { class: 'ed-prop-row' }, el('span', { class: 'k' }, 'Y (м):'), el('span', { class: 'v' }, lum.y.toFixed(2))),
      el('div', { class: 'ed-prop-row' }, el('span', { class: 'k' }, 'На треке:'), el('span', { class: 'v' }, lum.on_track_id ? 'да' : 'нет')),
    ];
    host.appendChild(this._rollout('Позиция', 'transform', ...posBody));

    // === Угол/поворот с быстрыми пресетами и объяснением ===
    const type = resolveBeamType(cat, lum.lightType);
    const shape = getBeamShape(type);
    const limits = getRotationLimits(cat);
    const currentAngle = lum.angle_deg != null ? lum.angle_deg : 90;
    const tiltMag = Math.min(45, Math.abs(((currentAngle - 90 + 180) % 360) - 180));

    // Тот же сектор, который используется drag-ручкой на плане. Раньше панель
    // свойств всегда разрешала 0..360° и обходила механические ограничения.
    let trackAngle = 90;
    if (lum.on_track_id) {
      const track = this.scene.tracks.find(t => t.id === lum.on_track_id);
      const angle = track ? this._trackSegmentAngle(track, lum) : null;
      if (angle !== null) trackAngle = angle;
    }
    const halfSpread = Math.min(180, Math.max(0, limits.maxH) / 2);
    const clampPlanAngle = (angle) => {
      const delta = Math.max(-halfSpread, Math.min(halfSpread, normalizeAngle(angle - trackAngle)));
      return Math.round(trackAngle + delta);
    };
    const angleAllowed = (angle) => Math.abs(normalizeAngle(angle - trackAngle)) <= halfSpread + 0.001;

    // Встраиваемый светильник направленного света (БЕЗ явного поворота в данных) —
    // свет направлен СТРОГО ВНИЗ, вращать/наклонять его нельзя.
    // в UI: не показываем ползунок и пресеты, только статус «вниз (фиксированный)».
    const isFixedDownlight = this._isFixedDownlight(cat);

    if (isFixedDownlight) {
      host.appendChild(this._rollout('Направление света', 'params',
        el('div', { class: 'ed-prop-row' },
          el('span', { class: 'k' }, 'Свет направлен:'),
          el('span', { class: 'v' }, el('b', {}, '⬇ вниз (фиксированный)')),
        ),
        el('div', { class: 'ed-prop-hint' },
          'Встраиваемый светильник направленного света — поворот/наклон не предусмотрен. ' +
          'Углы НЕ заданы в характеристиках товара.'),
      ));
    } else if (!limits.canRotateH) {
      host.appendChild(this._rollout('Направление света', 'params',
        el('div', { class: 'ed-prop-row' },
          el('span', { class: 'k' }, 'Ориентация на плане:'),
          el('span', { class: 'v' }, el('b', {}, 'фиксирована')),
        ),
        el('div', { class: 'ed-prop-hint' },
          limits.canRotateV
            ? `Горизонтальный поворот не предусмотрен. Паспортный вертикальный наклон: до ${limits.maxV}°. ` +
              'Текущая 2D-модель не смешивает его с направлением на плане.'
            : 'Поворот корпуса для этой модели не предусмотрен.'),
      ));
    } else {
      const angleExplain = shape.directional
        ? (tiltMag < 3
            ? '⬇ Свет строго вниз (пятно под светильником)'
            : `Наклон ${Math.round(tiltMag)}° → пятно смещено на ~${(this.project.room.height * Math.tan(tiltMag * Math.PI / 180)).toFixed(1)}м`)
        : `Поворот корпуса относительно трека: ${Math.round(currentAngle - 90)}°`;

      const angleLabel = el('div', { class: 'ed-prop-row' },
        el('span', { class: 'k' }, shape.directional ? 'Наклон:' : 'Поворот корпуса:'),
        el('span', { class: 'v' }, `${currentAngle}° `,
          el('span', { style: { color: 'var(--ed-accent)', fontSize: '10px' } },
            shape.directional
              ? (tiltMag < 3 ? '(вниз)' : `(наклон ${Math.round(tiltMag)}°)`)
              : `(${(currentAngle - 90 > 0 ? '+' : '') + (currentAngle - 90)}° от трека)`
          )));

      const angleInput = document.createElement('input');
      angleInput.type = 'range';
      angleInput.min = String(Math.round(trackAngle - halfSpread));
      angleInput.max = String(Math.round(trackAngle + halfSpread));
      angleInput.step = '5';
      angleInput.value = String(clampPlanAngle(currentAngle));
      angleInput.className = 'ed-range';
      angleInput.addEventListener('pointerdown', () => this._beginGesture());
      angleInput.addEventListener('input', (e) => {
        // Keyboard input не вызывает pointerdown, но тоже должен быть одним undo-шагом.
        this._beginGesture();
        const angle = clampPlanAngle(Number(e.target.value));
        this.setScene(Scene.setLuminaireAngle(this.scene, lum.id, angle),
          { silent: true, record: false, preview: true });
      });
      const finishAngleChange = () => {
        if (!this._gestureActive) return;
        this._endGesture();
        this._finishInteractiveChange();
      };
      angleInput.addEventListener('change', finishAngleChange);
      angleInput.addEventListener('pointercancel', finishAngleChange);

      // Быстрые пресеты для точечных
      let presetsRow = null;
      if (shape.directional) {
        const presets = [
          { angle: 90, label: '⬇', title: 'Свет вниз' },
          { angle: 60, label: '↖', title: 'Наклон вверх-влево' },
          { angle: 30, label: '⬉', title: 'Сильный наклон вверх' },
          { angle: 120, label: '↘', title: 'Наклон вниз-вправо' },
          { angle: 150, label: '⬊', title: 'Сильный наклон вниз' },
          { angle: 0, label: '➡', title: 'Наклон вправо' },
          { angle: 180, label: '⬅', title: 'Наклон влево' },
        ];
        presetsRow = el('div', { class: 'ed-angle-presets' },
          ...presets.map(p => el('button', {
            class: 'ed-btn ed-angle-preset' + (currentAngle === p.angle ? ' active' : ''),
            title: angleAllowed(p.angle) ? p.title : `${p.title} — вне паспортного диапазона`,
            disabled: angleAllowed(p.angle) ? null : '',
            onClick: () => this.setScene(Scene.setLuminaireAngle(this.scene, lum.id, clampPlanAngle(p.angle))),
          }, p.label)),
        );
      } else {
        // Для линейных — пресеты для поворота корпуса относительно трека
        const presets = [
          { angle: 90, label: '║', title: 'Свет вдоль трека (по умолчанию)' },
          { angle: 45, label: '╱', title: 'Наклон 45°' },
          { angle: 135, label: '╲', title: 'Наклон -45°' },
          { angle: 0, label: '═', title: 'Поперёк трека' },
        ];
        presetsRow = el('div', { class: 'ed-angle-presets' },
          ...presets.map(p => el('button', {
            class: 'ed-btn ed-angle-preset' + (currentAngle === p.angle ? ' active' : ''),
            title: angleAllowed(p.angle) ? p.title : `${p.title} — вне паспортного диапазона`,
            disabled: angleAllowed(p.angle) ? null : '',
            onClick: () => this.setScene(Scene.setLuminaireAngle(this.scene, lum.id, clampPlanAngle(p.angle))),
          }, p.label)),
        );
      }

      const explanation = el('div', { class: 'ed-prop-hint' }, angleExplain);

      host.appendChild(this._rollout('Направление света', 'params',
        angleLabel, angleInput, presetsRow, explanation));
    }

    // Действия
    host.appendChild(this._rollout('Действия', 'actions',
      el('button', {
        class: 'ed-btn danger wide',
        onClick: () => {
          this.setScene(Scene.removeObject(this.scene, lum.id));
          this.selectedId = null;
        },
      }, '🗑 Удалить светильник'),
    ));
  }

  _buildTrackProps(host, track) {
    const totalLen = track.points.reduce((s, p, i) =>
      i === 0 ? 0 : s + Math.hypot(p.x - track.points[i - 1].x, p.y - track.points[i - 1].y), 0);
    const lumOnTrack = this.scene.luminaires.filter(l => l.on_track_id === track.id).length;

    host.appendChild(el('div', { class: 'ed-prop-obj' },
      el('div', { class: 'ed-prop-kind' }, '━ Шинопровод'),
      el('div', { class: 'ed-prop-name' },
        `${track.voltage_v}В · ${track.color === 'black' ? 'чёрный' : 'белый'}`),
    ));

    host.appendChild(this._rollout('Геометрия', 'transform',
      el('div', { class: 'ed-prop-row' }, el('span', { class: 'k' }, 'Длина:'), el('span', { class: 'v' }, el('b', {}, `${totalLen.toFixed(2)} м`))),
      el('div', { class: 'ed-prop-row' }, el('span', { class: 'k' }, 'Точек:'), el('span', { class: 'v' }, track.points.length)),
      el('div', { class: 'ed-prop-row' }, el('span', { class: 'k' }, 'Светильн.:'), el('span', { class: 'v' }, lumOnTrack)),
    ));

    host.appendChild(this._rollout('Действия', 'actions',
      el('button', {
        class: 'ed-btn danger wide',
        onClick: () => {
          if (lumOnTrack > 0 && !confirm(`На треке ${lumOnTrack} свет. — они станут свободными. Удалить?`)) return;
          this.setScene(Scene.removeObject(this.scene, track.id));
          this.selectedId = null;
        },
      }, '🗑 Удалить трек'),
    ));
  }

  // ============================================================
  // STATUSBAR (низ)
  // ============================================================
  _buildStatusbar() {
    this.statusbarEl = el('div', { class: 'ed-statusbar' });
    this.rootEl.appendChild(this.statusbarEl);
    this._renderStatusbar();
  }

  _renderStatusbar() {
    if (!this.statusbarEl) return;
    this.statusbarEl.innerHTML = '';

    const stats = Scene.sceneStats(this.scene);
    const result = this.computeFn ? this.computeFn(this.scene) : null;

    this.statusbarEl.appendChild(el('div', { class: 'ed-status-item' },
      el('span', {}, 'Помещение:'), el('b', {},
        `${this.project.room.length}×${this.project.room.width} м (${(this.project.room.length * this.project.room.width).toFixed(1)} м²)`)));

    this.statusbarEl.appendChild(el('div', { class: 'ed-status-item accent' },
      el('span', {}, 'Свет.:'), el('b', {}, String(stats.luminaires_total))));

    this.statusbarEl.appendChild(el('div', { class: 'ed-status-item' },
      el('span', {}, 'Трек:'), el('b', {}, `${stats.total_track_length_m.toFixed(1)} м`)));

    if (result) {
      this.statusbarEl.appendChild(el('div', { class: 'ed-status-item' },
        el('span', {}, 'Мощн.:'), el('b', {}, `${result.totals_luminaires.power_w} Вт`)));

      const currCls = result.electrical?.over_absolute ? 'err' :
                       result.electrical?.over_recommended ? 'warn' : '';
      this.statusbarEl.appendChild(el('div', { class: 'ed-status-item ' + currCls },
        el('span', {}, 'Ток:'), el('b', {}, `${result.electrical.current_per_line_a} А`),
        (result.electrical.over_absolute ? ' ⚠️!' : result.electrical.over_recommended ? ' ⚠' : '')));

      const dp = result.lumens?.deltaPct || 0;
      const dpCls = dp > 15 ? 'over' : dp < -15 ? 'under' : 'ok';
      this.statusbarEl.appendChild(el('div', { class: 'ed-status-item' },
        el('span', {}, 'Поток:'), el('b', {}, `${(result.lumens.actual || 0).toLocaleString('ru-RU')} лм`),
        el('span', { class: `ed-delta ${dpCls}` }, `${dp > 0 ? '+' : ''}${dp}%`)));
    }

    if (stats.luminaires_pinned || stats.tracks_pinned) {
      this.statusbarEl.appendChild(el('div', { class: 'ed-status-item warn' },
        `🔴 Ручных правок: ${stats.luminaires_pinned + stats.tracks_pinned}`));
    }

    this.statusbarEl.appendChild(el('div', { class: 'ed-status-spacer' }));

    // Всплывающее сообщение (сохранение/копия/вставка и т.п.)
    if (this._flashMsg) {
      this.statusbarEl.appendChild(el('div', { class: 'ed-status-item flash' }, this._flashMsg));
    }

    if (this.hoveredId) {
      const lum = this.scene.luminaires.find(l => l.id === this.hoveredId);
      const tr = this.scene.tracks.find(t => t.id === this.hoveredId);
      if (lum) {
        const cat = this.db.catalog.find(p => p.slug === lum.slug);
        this.statusbarEl.appendChild(el('div', { class: 'ed-status-item' },
          `► ${cat?.power_w || '?'}Вт · ${cat?.lumen || '?'}лм`));
      } else if (tr) {
        const len = tr.points.reduce((s, p, i) => i === 0 ? 0 : s + Math.hypot(p.x - tr.points[i-1].x, p.y - tr.points[i-1].y), 0);
        this.statusbarEl.appendChild(el('div', { class: 'ed-status-item' }, `► Трек ${len.toFixed(1)}м`));
      }
    }

    if (result) {
      this.statusbarEl.appendChild(el('div', { class: 'ed-status-price' },
        `ИТОГО: ${result.grand_total_rub.toLocaleString('ru-RU')} ₽`));
    }
  }

  // ============================================================
  // Общий пере-рендер
  // ============================================================
  _render() {
    this._renderTopbar();
    this._renderToolbar();
    this._renderLeftPanel();
    this._renderRightPanel();
    this._renderViewport();
    this._renderStatusbar();
  }

  _select(id) {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this._renderViewport();
    this._renderRightPanel();
  }

  _resetToAuto() {
    if (!confirm('Сбросить все ручные правки и вернуться к авто-расстановке?')) return;
    this.onSceneChange('reset-auto');
  }

  _showHelp() {
    alert(
      '📖 СПРАВКА · Редактор ZimaLED\n\n' +
      '━━ Виды взаимодействия ━━\n' +
      '• ЛКМ по объекту — выделить + начать перетаскивание\n' +
      '• Средняя кнопка мыши (или Space+тащить) — панорамирование вьюпорта\n' +
      '• Колесо мыши — зум к курсору\n' +
      '• Клавиша F — вписать план в вьюпорт\n' +
      '• Del/Backspace — удалить выделенное\n' +
      '• Стрелки — точное перемещение (0.1 м, +Shift = 0.5 м)\n' +
      '• Esc — снять выделение\n\n' +
      '━━ Горячие клавиши ━━\n' +
      '• Ctrl+Z — отменить последнее действие\n' +
      '• Ctrl+Y (Ctrl+Shift+Z) — повторить отменённое\n' +
      '• Ctrl+C — копировать выделенный объект\n' +
      '• Ctrl+V — вставить скопированный объект\n' +
      '• Ctrl+S — сохранить проект в браузере\n\n' +
      '━━ Палитра слева ━━\n' +
      '• Тащите светильники и треки на вьюпорт\n' +
      '• Светильники магнитно прищёлкиваются к ближайшему треку\n\n' +
      '━━ Треки ━━\n' +
      '• Тяните за середину — переносит целиком (со светильниками)\n' +
      '• Тяните за квадратные ручки на концах — растягивает длину\n\n' +
      'Все правки обновляют спецификацию, цену и электрику в реальном времени.'
    );
  }
}

/** Нормализует угол в диапазон [-180, 180] */
function normalizeAngle(a) {
  a = a % 360;
  if (a > 180) a -= 360;
  if (a < -180) a += 360;
  return a;
}
