/**
 * render3d.js — интерактивная аксонометрическая 3D-сцена без внешних зависимостей.
 *
 * Один и тот же renderer используется fullscreen-редактором и итоговым результатом.
 * Координаты объектов остаются в общей scene-модели (метры по полу); 3D является
 * представлением и способом редактирования, а не отдельной копией проекта.
 */

import { getCCT, inferLuminaireType, getBeamShape, resolveBeamType } from './cct.js';

// Управляемые пользователем типы света (согласовано с cct.LIGHT_TYPE_OPTIONS)
const LIGHT_TYPE_BEAM = {
  rasseivayushchiy: 'downlight',
  napravlennyy:     'downlight_lens',
  fokus_lens:       'spot_lens',
  povorotnyy:       'spot',
  staticheskiy:     'linear_fold',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

export const DEFAULT_CAMERA = Object.freeze({ yaw: -38, pitch: 32, zoom: 1 });

function node(tag, attrs = {}, children = []) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined && value !== false) el.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function rad(deg) { return deg * Math.PI / 180; }
function normalizeAngle(deg) { return ((deg % 360) + 360) % 360; }

export function normalizeCamera(camera = {}) {
  return {
    yaw: Number.isFinite(camera.yaw) ? camera.yaw : DEFAULT_CAMERA.yaw,
    pitch: clamp(Number.isFinite(camera.pitch) ? camera.pitch : DEFAULT_CAMERA.pitch, 12, 72),
    zoom: clamp(Number.isFinite(camera.zoom) ? camera.zoom : DEFAULT_CAMERA.zoom, 0.35, 4),
  };
}

/** Создаёт прямое и обратное преобразование world↔screen для текущей камеры. */
export function createProjection(room, width, height, camera = DEFAULT_CAMERA, padding = 42) {
  const cam = normalizeCamera(camera);
  const yaw = rad(cam.yaw);
  const pitch = rad(cam.pitch);
  const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
  const cosP = Math.cos(pitch), sinP = Math.max(0.08, Math.sin(pitch));
  const cx = room.length / 2, cy = room.width / 2;

  const raw = (x, y, z = 0) => {
    const dx = x - cx, dy = y - cy;
    return {
      x: cosY * dx - sinY * dy,
      y: (sinY * dx + cosY * dy) * sinP - z * cosP,
    };
  };

  const corners = [];
  for (const z of [0, room.height]) {
    for (const x of [0, room.length]) {
      for (const y of [0, room.width]) corners.push(raw(x, y, z));
    }
  }
  const minX = Math.min(...corners.map(p => p.x));
  const maxX = Math.max(...corners.map(p => p.x));
  const minY = Math.min(...corners.map(p => p.y));
  const maxY = Math.max(...corners.map(p => p.y));
  const spanX = Math.max(0.1, maxX - minX);
  const spanY = Math.max(0.1, maxY - minY);
  const scale = Math.max(1, Math.min(
    (width - padding * 2) / spanX,
    (height - padding * 2) / spanY,
  )) * cam.zoom;
  const offsetX = width / 2 - ((minX + maxX) / 2) * scale;
  const offsetY = height / 2 - ((minY + maxY) / 2) * scale;

  const project = (x, y, z = 0) => {
    const p = raw(x, y, z);
    return { x: offsetX + p.x * scale, y: offsetY + p.y * scale };
  };

  const screenDeltaToWorld = (dxPx, dyPx) => {
    const a = dxPx / scale;
    const b = dyPx / (scale * sinP);
    return {
      x: cosY * a + sinY * b,
      y: -sinY * a + cosY * b,
    };
  };

  const screenToWorld = (sx, sy, z = 0) => {
    const a = (sx - offsetX) / scale;
    const b = ((sy - offsetY) / scale + z * cosP) / sinP;
    return {
      x: cx + cosY * a + sinY * b,
      y: cy - sinY * a + cosY * b,
    };
  };

  return { camera: cam, scale, offsetX, offsetY, project, screenDeltaToWorld, screenToWorld };
}

function pointsAttr(points) {
  return points.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
}

function pathAttr(points) {
  return points.map((p, i) => `${i ? 'L' : 'M'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
}

function zoneRects(project) {
  const zones = project.zones || [];
  const complete = zones.length > 0 && zones.every(z =>
    [z.x, z.y, z.w, z.h].every(Number.isFinite));
  if (complete) return zones.map(z => ({ ...z }));
  const total = zones.reduce((sum, z) => sum + (z.area_share || 0), 0) || 1;
  let x = 0;
  return zones.map(z => {
    const w = project.room.length * (z.area_share || 0) / total;
    const rect = { ...z, x, y: 0, w, h: project.room.width };
    x += w;
    return rect;
  });
}

function appendGrid(group, room, projection) {
  const step = room.length > 12 || room.width > 12 ? 1 : 0.5;
  for (let x = 0; x <= room.length + 1e-6; x += step) {
    const a = projection.project(x, 0, 0.006);
    const b = projection.project(x, room.width, 0.006);
    group.appendChild(node('line', {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      stroke: '#42536a', 'stroke-width': 0.7, opacity: 0.42,
      'pointer-events': 'none',
    }));
  }
  for (let y = 0; y <= room.width + 1e-6; y += step) {
    const a = projection.project(0, y, 0.006);
    const b = projection.project(room.length, y, 0.006);
    group.appendChild(node('line', {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      stroke: '#42536a', 'stroke-width': 0.7, opacity: 0.42,
      'pointer-events': 'none',
    }));
  }
}

function appendDimensions(group, room, projection) {
  const a = projection.project(0, room.width, 0);
  const b = projection.project(room.length, room.width, 0);
  const c = projection.project(room.length, 0, 0);
  const d = projection.project(room.length, room.width, 0);
  for (const [p1, p2, label] of [[a, b, `${room.length.toFixed(1)} м`], [c, d, `${room.width.toFixed(1)} м`]]) {
    group.appendChild(node('line', {
      x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
      stroke: '#9aa9bd', 'stroke-width': 1, 'stroke-dasharray': '4,3',
      'pointer-events': 'none',
    }));
    group.appendChild(node('text', {
      x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 - 6,
      fill: '#d8e1ed', 'font-size': 11, 'font-family': 'system-ui,sans-serif',
      'text-anchor': 'middle', 'paint-order': 'stroke', stroke: '#111821', 'stroke-width': 3,
      'pointer-events': 'none',
    }, [label]));
  }
}

function appendBeam(group, lum, product, room, projection) {
  const type = resolveBeamType(product, lum.lightType);
  const shape = getBeamShape(type);
  const cct = getCCT(product.cct_k);
  const height = Math.max(1, room.height - 0.12);
  const beam = clamp(product.beam_deg || 60, 12, 130);
  const baseRadius = clamp(height * Math.tan(rad(beam / 2)) * 0.42, 0.18, Math.max(room.length, room.width) * 0.42);
  const angle = normalizeAngle(lum.angle_deg ?? 90);
  const tilt = shape.directional ? clamp((((angle - 90 + 180) % 360) + 360) % 360 - 180, -38, 38) : 0;
  const shift = height * Math.tan(rad(Math.abs(tilt))) * 0.55;
  const sign = tilt >= 0 ? 1 : -1;
  const targetX = lum.x + Math.cos(rad(angle)) * shift * sign;
  const targetY = lum.y + Math.sin(rad(angle)) * shift * sign;
  const elongation = clamp(shape.elongation || 1, 1, 4);
  const rx = baseRadius * elongation;
  const ry = baseRadius;
  const body = rad(angle);
  const ringWorld = [];
  for (let i = 0; i < 18; i++) {
    const t = i / 18 * Math.PI * 2;
    const ex = Math.cos(t) * rx, ey = Math.sin(t) * ry;
    ringWorld.push({
      x: targetX + ex * Math.cos(body) - ey * Math.sin(body),
      y: targetY + ex * Math.sin(body) + ey * Math.cos(body),
    });
  }
  const ring = ringWorld.map(p => projection.project(p.x, p.y, 0.012));
  const source = projection.project(lum.x, lum.y, room.height - 0.16);
  const color = cct.emitColor || '#ffd49a';

  // Полупрозрачные грани светового конуса.
  for (let i = 0; i < ring.length; i += 3) {
    const next = ring[(i + 3) % ring.length];
    group.appendChild(node('polygon', {
      points: pointsAttr([source, ring[i], next]),
      fill: color, opacity: 0.035, 'pointer-events': 'none',
    }));
  }
  group.appendChild(node('polygon', {
    points: pointsAttr(ring), fill: color, opacity: 0.16,
    stroke: color, 'stroke-width': 1, 'stroke-opacity': 0.55,
    'pointer-events': 'none',
  }));
  const target = projection.project(targetX, targetY, 0.02);
  group.appendChild(node('line', {
    x1: source.x, y1: source.y, x2: target.x, y2: target.y,
    stroke: color, 'stroke-width': 1, 'stroke-dasharray': '4,4', opacity: 0.48,
    'pointer-events': 'none',
  }));
}

/**
 * Рисует комнату и финальную scene в 3D. Интерактивность навешивает редактор
 * по data-kind/data-id, поэтому renderer одинаково пригоден для результата.
 */
export function renderScene3D(project, scene, db, options = {}) {
  const {
    width = 900,
    height = Math.max(430, Math.round(width * 0.62)),
    camera = DEFAULT_CAMERA,
    selectedId = null,
    showZones = true,
    showGrid = true,
    showBeams = true,
    showDimensions = true,
    showLegend = true,
    interactive = false,
  } = options;
  const room = project.room;
  const safeScene = scene && Array.isArray(scene.tracks) && Array.isArray(scene.luminaires)
    ? scene : { tracks: [], luminaires: [] };
  const projection = createProjection(room, width, height, camera);
  const svg = node('svg', {
    xmlns: SVG_NS,
    viewBox: `0 0 ${width} ${height}`,
    width, height,
    class: 'scene-3d',
    role: 'img',
    'aria-label': `3D-модель помещения: ${safeScene.tracks.length} треков, ${safeScene.luminaires.length} светильников`,
    'data-camera-yaw': projection.camera.yaw,
    'data-camera-pitch': projection.camera.pitch,
    'data-camera-zoom': projection.camera.zoom,
    style: 'display:block;max-width:100%;height:auto;background:#10151d;border-radius:10px;touch-action:none;user-select:none',
  });
  // Runtime-only projection is intentionally attached for editor pointer conversion.
  svg.__projection3d = projection;

  const defs = node('defs');
  const glow = node('filter', { id: 'scene3d-glow', x: '-80%', y: '-80%', width: '260%', height: '260%' }, [
    node('feGaussianBlur', { stdDeviation: 3, result: 'b' }),
    node('feMerge', {}, [node('feMergeNode', { in: 'b' }), node('feMergeNode', { in: 'SourceGraphic' })]),
  ]);
  defs.appendChild(glow);
  svg.appendChild(defs);
  svg.appendChild(node('rect', { x: 0, y: 0, width, height, fill: '#10151d', 'data-kind': 'bg' }));

  const floorCorners = [
    projection.project(0, 0, 0), projection.project(room.length, 0, 0),
    projection.project(room.length, room.width, 0), projection.project(0, room.width, 0),
  ];
  svg.appendChild(node('polygon', {
    points: pointsAttr(floorCorners), fill: '#202a38', stroke: '#8b9bb0',
    'stroke-width': 1.5, 'data-kind': 'bg',
  }));

  // Two translucent walls communicate room height without hiding the objects.
  const wallA = [[0, 0, 0], [room.length, 0, 0], [room.length, 0, room.height], [0, 0, room.height]]
    .map(p => projection.project(...p));
  const wallB = [[room.length, 0, 0], [room.length, room.width, 0], [room.length, room.width, room.height], [room.length, 0, room.height]]
    .map(p => projection.project(...p));
  svg.appendChild(node('polygon', { points: pointsAttr(wallA), fill: '#29405a', opacity: 0.2, stroke: '#64758a', 'stroke-width': 1, 'data-kind': 'bg' }));
  svg.appendChild(node('polygon', { points: pointsAttr(wallB), fill: '#243349', opacity: 0.16, stroke: '#64758a', 'stroke-width': 1, 'data-kind': 'bg' }));

  if (showZones) {
    const colors = ['#42a5f5', '#ffb74d', '#66d18f', '#ef6d73', '#aa72e8', '#ec6fb0'];
    const zones = node('g', { class: 'scene3d-zones', 'pointer-events': 'none' });
    zoneRects(project).forEach((z, index) => {
      const points = [
        projection.project(z.x, z.y, 0.018),
        projection.project(z.x + z.w, z.y, 0.018),
        projection.project(z.x + z.w, z.y + z.h, 0.018),
        projection.project(z.x, z.y + z.h, 0.018),
      ];
      const center = projection.project(z.x + z.w / 2, z.y + z.h / 2, 0.025);
      zones.appendChild(node('polygon', {
        points: pointsAttr(points), fill: colors[index % colors.length], opacity: 0.13,
        stroke: colors[index % colors.length], 'stroke-width': 1, 'stroke-dasharray': '5,3',
        'data-zone-index': index,
      }));
      zones.appendChild(node('text', {
        x: center.x, y: center.y, fill: colors[index % colors.length],
        'font-size': 10, 'font-family': 'system-ui,sans-serif', 'font-weight': 700,
        'text-anchor': 'middle', 'paint-order': 'stroke', stroke: '#10151d', 'stroke-width': 3,
      }, [`Зона ${index + 1}`]));
    });
    svg.appendChild(zones);
  }

  if (showGrid) {
    const grid = node('g', { class: 'scene3d-grid' });
    appendGrid(grid, room, projection);
    svg.appendChild(grid);
  }

  if (showBeams) {
    const beams = node('g', { class: 'scene3d-beams' });
    for (const lum of safeScene.luminaires) {
      const product = db.catalog.find(item => item.slug === lum.slug);
      if (product) appendBeam(beams, lum, product, room, projection);
    }
    svg.appendChild(beams);
  }

  const tracks = node('g', { class: 'scene3d-tracks' });
  for (const track of safeScene.tracks) {
    const points = (track.points || []).map(p => projection.project(p.x, p.y, room.height - 0.06));
    if (points.length === 0) continue;
    const selected = selectedId === track.id;
    tracks.appendChild(node('path', {
      d: pathAttr(points), fill: 'none', stroke: '#05080c', 'stroke-width': selected ? 10 : 8,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.78,
      'pointer-events': 'none',
    }));
    tracks.appendChild(node('path', {
      d: pathAttr(points), fill: 'none', stroke: selected ? '#ffcc4d' : (track.color === 'white' ? '#e9edf3' : '#238de0'),
      'stroke-width': selected ? 5 : 3.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      filter: 'url(#scene3d-glow)', 'data-kind': 'track', 'data-id': track.id,
      style: interactive ? 'cursor:move' : '',
    }));
    if (selected && interactive) {
      points.forEach((point, index) => tracks.appendChild(node('circle', {
        cx: point.x, cy: point.y, r: 8, fill: index === 0 || index === points.length - 1 ? '#ff6b45' : '#ffcc4d',
        stroke: '#111', 'stroke-width': 2, 'data-kind': 'track-handle', 'data-id': track.id,
        'data-point-index': index, style: 'cursor:crosshair',
      })));
    }
  }
  svg.appendChild(tracks);

  // Токоподводы: иконка на треках по настройке количества питающих.
  const sys = project?.system || {};
  let feedCount = 1;
  if (sys.feedMode === 'manual') {
    const n = parseInt(sys.feeds, 10);
    feedCount = Number.isFinite(n) ? Math.max(0, Math.min(12, n)) : 1;
  }
  if (feedCount > 0 && safeScene.tracks.length > 0) {
    const feeders = node('g', { class: 'scene3d-feeders' });
    safeScene.tracks.slice(0, feedCount).forEach((track) => {
      const pts = track.points || [];
      if (pts.length === 0) return;
      const p0 = pts[0];
      const fp = projection.project(p0.x, p0.y, room.height - 0.02);
      feeders.appendChild(node('rect', {
        x: fp.x - 7, y: fp.y - 7, width: 14, height: 14,
        fill: '#f87171', stroke: '#fff', 'stroke-width': 1.5, rx: 3,
        'data-kind': 'feeder', 'pointer-events': 'none',
      }));
      feeders.appendChild(node('text', {
        x: fp.x, y: fp.y + 4, 'font-size': 11, fill: '#fff',
        'text-anchor': 'middle', 'font-weight': 700, 'pointer-events': 'none',
      }, ['⚡']));
    });
    svg.appendChild(feeders);
  }

  const fixtures = node('g', { class: 'scene3d-luminaires' });
  for (const lum of safeScene.luminaires) {
    const product = db.catalog.find(item => item.slug === lum.slug);
    if (!product) continue;
    const type = resolveBeamType(product, lum.lightType);
    const cct = getCCT(product.cct_k);
    const selected = selectedId === lum.id;
    const p = projection.project(lum.x, lum.y, room.height - 0.16);
    const pTop = projection.project(lum.x, lum.y, room.height - 0.05);
    const group = node('g', {
      class: `scene3d-luminaire ${type}${selected ? ' selected' : ''}`,
      transform: `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`,
      'data-kind': 'luminaire', 'data-id': lum.id, 'data-slug': lum.slug,
      'data-scene-x': lum.x, 'data-scene-y': lum.y, 'data-scene-angle': lum.angle_deg ?? 90,
      style: interactive ? 'cursor:move' : '',
    });
    group.appendChild(node('line', {
      x1: pTop.x - p.x, y1: pTop.y - p.y, x2: 0, y2: 0,
      stroke: '#aeb9c8', 'stroke-width': 1.5, 'pointer-events': 'none',
    }));
    if (selected) group.appendChild(node('circle', { cx: 0, cy: 0, r: 12, fill: 'none', stroke: '#ffcc4d', 'stroke-width': 2, opacity: 0.9, 'pointer-events': 'none' }));
    const color = cct.emitColor || '#ffe0aa';
    if (type.startsWith('linear_')) {
      const length = 12;
      const a = rad(lum.angle_deg ?? 90);
      group.appendChild(node('line', {
        x1: -Math.cos(a) * length, y1: -Math.sin(a) * length,
        x2: Math.cos(a) * length, y2: Math.sin(a) * length,
        stroke: color, 'stroke-width': 7, 'stroke-linecap': 'round',
        filter: 'url(#scene3d-glow)', 'pointer-events': 'none',
      }));
    } else {
      group.appendChild(node('circle', {
        cx: 0, cy: 0, r: 6, fill: color, stroke: '#fff', 'stroke-width': 1.4,
        filter: 'url(#scene3d-glow)', 'pointer-events': 'none',
      }));
      const shape = getBeamShape(type);
      if (shape.directional) {
        const a = rad(lum.angle_deg ?? 90);
        group.appendChild(node('line', {
          x1: 0, y1: 0, x2: Math.cos(a) * 17, y2: Math.sin(a) * 17,
          stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round', 'pointer-events': 'none',
        }));
      }
    }
    group.appendChild(node('circle', { cx: 0, cy: 0, r: 2, fill: '#fff', 'pointer-events': 'none' }));
    group.appendChild(node('title', {}, [product.name]));
    fixtures.appendChild(group);
  }
  svg.appendChild(fixtures);

  // Каркас верхней грани помещения.
  const top = [
    projection.project(0, 0, room.height), projection.project(room.length, 0, room.height),
    projection.project(room.length, room.width, room.height), projection.project(0, room.width, room.height),
  ];
  svg.appendChild(node('path', {
    d: pathAttr([...top, top[0]]), fill: 'none', stroke: '#8b9bb0',
    'stroke-width': 1.2, 'stroke-dasharray': '6,4', opacity: 0.72, 'pointer-events': 'none',
  }));

  if (showDimensions) {
    const dims = node('g', { class: 'scene3d-dimensions' });
    appendDimensions(dims, room, projection);
    svg.appendChild(dims);
  }

  if (showLegend) {
    svg.appendChild(node('text', {
      x: 16, y: height - 16, fill: '#aeb9c8', 'font-size': 11,
      'font-family': 'system-ui,sans-serif', 'pointer-events': 'none',
    }, [`3D · камера ${Math.round(projection.camera.yaw)}° / ${Math.round(projection.camera.pitch)}° · ${safeScene.tracks.length} трек. · ${safeScene.luminaires.length} свет.`]));
  }
  return svg;
}

export function downloadSvg(svgElement, filename = 'scene-3d.svg') {
  const source = new XMLSerializer().serializeToString(svgElement);
  const blob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
