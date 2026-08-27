/**
 * share.js — механика обмена ссылками и народного рейтинга проектов.
 *
 * Содержит:
 *   1. Кодек v3 (compact + deflate + base64url) — вынесен из app.js (v1.9),
 *      чтобы переиспользовать тем же кодом в скрипте генерации сидов
 *      (scripts/make_seeds.mjs) и в клиенте API рейтинга.
 *   2. Клиент PHP-API рейтинга (/lightcalc-app/api/): probe/share/vote/top.
 *      Все вызовы мягко деградируют: недоступен API — календарь топа не
 *      показывается, ссылки строятся как раньше (#p=…), калькулятор не страдает.
 *   3. Анонимный токен голосующего (localStorage) — БЕЗ фингерпринтов и без
 *      хранения сырых IP. Сервер хранит только хэш (токен + соль + IP-хэш).
 *
 * Формат payload ссылки (см. app.js, «Шаринг ссылки на проект»):
 *   '#p=' + '3z.'|'3.' + base64url — самодостаточная ссылка (без сервера);
 *   '#s=' + ID                      — короткая ссылка через api/share.php
 *                                      (fallback: если API недоступен при
 *                                      открытии — показываем чистый мастер).
 */

// ============================================================
// Кодек v3 (перенесён из app.js без изменений логики)
// ============================================================

const _B64_CHUNK = 0x8000;

export function bytesToBase64Url(bytes) {
  let binary = '';
  // Не разворачиваем весь Uint8Array через spread: крупная сцена может
  // превысить лимит аргументов функции.
  for (let i = 0; i < bytes.length; i += _B64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + _B64_CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function compressDeflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decompressDeflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodeSharePayload(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const plain = '3.' + bytesToBase64Url(bytes);
  if (typeof CompressionStream === 'function') {
    try {
      const packed = '3z.' + bytesToBase64Url(await compressDeflateRaw(bytes));
      return packed.length < plain.length ? packed : plain;
    } catch (e) { /* сжатие недоступно — отдаём несжатый v3 */ }
  }
  return plain;
}

export async function decodeSharePayload(encoded) {
  // v3, сжатый
  if (encoded.startsWith('3z.')) {
    const bytes = await decompressDeflateRaw(base64UrlToBytes(encoded.slice(3)));
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  // v3, без сжатия
  if (encoded.startsWith('3.')) {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded.slice(2))));
  }
  // Легаси: чистый base64 поверх JSON (ссылки ранних версий)
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    // Совместимость со ссылками ранней версии saveLocalProject(), где JSON
    // перед btoa дополнительно проходил через encodeURIComponent().
    return JSON.parse(decodeURIComponent(text));
  }
}

/** Округление координат до миллиметров — компактность payload. */
export function round3(n) {
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
}

const DOWNLIGHT_MIX_KEYS = ['rasseivayushchiy', 'napravlennyy', 'fokus_lens', 'povorotnyy', 'staticheskiy'];
const TRACK_MIX_KEYS = ['rasseivayushchiy', 'napravlennyy', 'fokus_lens', 'povorotnyy'];

/**
 * Компактное представление проекта+сцены для ссылки (v3).
 * Короткие ключи и позиционные массивы: JSON в 2–3 раза меньше →
 * после deflate типичная ссылка занимает 0.5–2.5 КБ.
 */
export function buildShareData(project, scene) {
  const p = project;
  const compact = {
    v: 3,
    room: [round3(p.room.length), round3(p.room.width), round3(p.room.height), p.room.ceiling],
    sys: [
      p.system.voltage_v, p.system.color, p.system.mount, p.system.dimmable ? 1 : 0,
      p.system.feedMode || 'auto', p.system.feeds || 1,
      p.system.zoneLayout || 'zone', p.system.lightMode || 'auto',
    ],
    zones: (p.zones || []).map(z => [
      z.zone_id, z.cct_k, z.area_share,
      round3(z.x || 0), round3(z.y || 0), round3(z.w || 1), round3(z.h || 1),
    ]),
    layout: p.layout,
    preset: p.presetId || 0,
  };
  if (p.system.lightMode === 'manual' && p.system.lightMix) {
    compact.mix = [
      DOWNLIGHT_MIX_KEYS.map(k => p.system.lightMix.downlight?.[k] || 0),
      TRACK_MIX_KEYS.map(k => p.system.lightMix.track?.[k] || 0),
    ];
  }
  if (scene && Array.isArray(scene.tracks)) {
    const trackIndexById = new Map(scene.tracks.map((t, i) => [t.id, i]));
    compact.scene = {
      t: scene.tracks.map(tr => (tr.points || []).map(pt => [round3(pt.x), round3(pt.y)])),
      l: (scene.luminaires || []).map(lum => {
        const trackIdx = lum.on_track_id ? (trackIndexById.has(lum.on_track_id) ? trackIndexById.get(lum.on_track_id) : -1) : -1;
        return [
          round3(lum.x), round3(lum.y), lum.angle_deg ?? 90,
          lum.slug, lum.lightType || 0, trackIdx,
          trackIdx >= 0 && Number.isFinite(lum.t) ? round3(lum.t) : 0,
        ];
      }),
    };
  }
  return compact;
}

/**
 * Обратное преобразование компакт-формата v3 в полную структуру
 * {project, scene} — ту же, что использовал формат v2. Дальше payload
 * проходит ОБЫЧНУЮ валидацию app.js (белые списки + кламп), т.е.
 * компактность не расширяет границы доверия.
 */
export function expandShareData(c) {
  const room = Array.isArray(c.room) ? c.room : [];
  const sys = Array.isArray(c.sys) ? c.sys : [];
  const project = {
    room: { length: room[0], width: room[1], height: room[2], shape: 'rect', ceiling: room[3] },
    system: {
      voltage_v: sys[0], color: sys[1], mount: sys[2], dimmable: !!sys[3],
      feedMode: sys[4], feeds: sys[5], zoneLayout: sys[6], lightMode: sys[7],
      lightMix: {
        downlight: Object.fromEntries(DOWNLIGHT_MIX_KEYS.map((k, i) => [k, c.mix?.[0]?.[i] || 0])),
        track: Object.fromEntries(TRACK_MIX_KEYS.map((k, i) => [k, c.mix?.[1]?.[i] || 0])),
      },
    },
    zones: (Array.isArray(c.zones) ? c.zones : []).map(z => ({
      zone_id: z[0], cct_k: z[1], area_share: z[2], x: z[3], y: z[4], w: z[5], h: z[6],
    })),
    layout: c.layout,
    presetId: c.preset || null,
  };
  let scene = null;
  if (c.scene && Array.isArray(c.scene.t)) {
    scene = {
      tracks: c.scene.t.map((pts, i) => ({
        id: `sh_t${i}`,
        points: (pts || []).map(pt => ({ x: pt[0], y: pt[1] })),
      })),
      luminaires: (c.scene.l || []).map((l, i) => {
        const o = { id: `sh_l${i}`, x: l[0], y: l[1], angle_deg: l[2], slug: l[3] };
        if (l[4]) o.lightType = l[4];
        if (Number.isInteger(l[5]) && l[5] >= 0) {
          o.on_track_id = `sh_t${l[5]}`;
          if (l[6]) o.t = l[6];
        }
        return o;
      }),
    };
  }
  return { project, scene };
}

// ============================================================
// API рейтинга (PHP, /lightcalc-app/api/)
// ============================================================

// База API вычисляется от URL этого модуля: …/assets/js/share.js → …/api/.
// Работает и в embed (…/lightcalc-app/assets/js/…), и в локальной демо-странице.
export const API_BASE = new URL('../../api/', import.meta.url).href;

/** fetch с таймаутом — API не должен тормозить интерфейс. */
async function apiFetch(path, opts = {}, timeoutMs = 2500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(new URL(path, API_BASE).href, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function apiJson(path, opts = {}, timeoutMs = 2500) {
  const r = await apiFetch(path, opts, timeoutMs);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const data = await r.json();
  if (data && data.ok !== true) throw new Error(data.error || 'api error');
  return data;
}

/** Проверка доступности API (2.5 с). Возвращает true/false, никогда не бросает. */
export async function apiProbe() {
  try {
    const data = await apiJson('probe.php', {}, 2500);
    return data.api === 'zlc';
  } catch { return false; }
}

/**
 * Регистрация шеринга: отправляем ЗАКОДИРОВАННЫЙ payload (ровно тот, что
 * идёт в #p=). Серера хранит его как есть и возвращает короткий ID.
 * Возвращает { id } или null (API недоступен — используем #p=).
 */
export async function apiRegisterShare(encodedPayload, timeoutMs = 1800) {
  try {
    const data = await apiJson('share.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: encodedPayload }),
    }, timeoutMs);
    return typeof data.id === 'string' && /^[A-Za-z0-9_-]{6,16}$/.test(data.id) ? { id: data.id } : null;
  } catch { return null; }
}

/** Получение payload по короткому ID (заодно сервер считает открытие). */
export async function apiFetchShare(id, timeoutMs = 2500) {
  const data = await apiJson('share.php?id=' + encodeURIComponent(id), {}, timeoutMs);
  if (typeof data.payload !== 'string') throw new Error('bad share payload');
  return data;
}

/**
 * Голос звёздами (1–5). Токен — анонимный идентификатор в localStorage,
 * НЕ персональные данные. Возвращает { avg, count } или null.
 */
export async function apiVote(id, stars, timeoutMs = 2500) {
  try {
    const data = await apiJson('vote.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, stars, token: getVoterToken() }),
    }, timeoutMs);
    return { avg: Number(data.avg) || 0, count: Number(data.count) || 0 };
  } catch { return null; }
}

/** Топ-N проектов: [{id, p, stars, votes, shares, opens, wr, fresh}] */
export async function apiTop(limit = 12, timeoutMs = 2500) {
  const data = await apiJson('top.php?limit=' + Math.max(1, Math.min(24, limit)), {}, timeoutMs);
  return Array.isArray(data.items) ? data.items : [];
}

// ============================================================
// Анонимный токен голосующего (выбор пользователя, без фингерпринтов)
// ============================================================

const VOTER_KEY = 'zlc_voter_id';
const MY_VOTES_KEY = 'zlc_my_votes';

function randomToken() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* fallthrough */ }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** Стабильный анонимный токен (создаётся при первом голосовании). */
export function getVoterToken() {
  try {
    let t = localStorage.getItem(VOTER_KEY);
    if (!t || !/^[A-Za-z0-9-]{8,64}$/.test(t)) {
      t = randomToken();
      localStorage.setItem(VOTER_KEY, t);
    }
    return t;
  } catch { return randomToken(); } // приватный режим — разовый токен
}

/** Мои оценки: {shareId: stars} — чтобы показать свою звезду и не голосовать дважды. */
export function getMyVotes() {
  try { return JSON.parse(localStorage.getItem(MY_VOTES_KEY) || '{}') || {}; }
  catch { return {}; }
}

export function setMyVote(shareId, stars) {
  try {
    const all = getMyVotes();
    if (stars) all[shareId] = stars; else delete all[shareId];
    localStorage.setItem(MY_VOTES_KEY, JSON.stringify(all));
  } catch { /* приватный режим — просто не запоминаем */ }
}
