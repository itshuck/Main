/**
 * cart-integration.js — интеграция с корзиной WebSite X5 сайта zima-led.ru.
 *
 * Публичное API:
 *   addToSiteCart(items) — добавляет массив {x5_id, qty} в корзину сайта.
 *                          Возвращает Promise<{added, failed, cartUrl}>
 *   getSiteCartCount()   — сколько сейчас позиций в корзине пользователя
 *   openSiteCart()       — открывает /cart/ в новой вкладке
 *
 * Стратегия:
 *   1) Если на странице уже подгружен x5engine (например, встраивание в
 *      /lightcalc самого сайта zima-led) — используем нативный API
 *      window.x5engine.cart.manager.add(id, qty).
 *   2) Иначе (локальное демо, тестирование) — пишем напрямую в localStorage
 *      в формате, совместимом с WebSite X5. Формат — reverse-engineered
 *      из x5cartengine.js (объект {products: {hash: {...}}, itemKeys: [...], ...}).
 *
 * Требования:
 *   - На prod-странице должен быть загружен `/cart/x5cart.js` (он лежит на
 *     всех страницах сайта с корзиной). Мы явно ждём его через промис.
 */

// Имя cookie/localStorage-ключа для корзины zima-led.ru — из x5CartData.settings.cartCookie
export const CART_STORAGE_KEY = 'x5CartProductshka9od7l5ty97fpr';
export const CART_URL = 'https://zima-led.ru/cart/';
export const X5CART_JS_URL = 'https://zima-led.ru/cart/x5cart.js';

// Кеш загрузки x5cart.js (для локального демо)
let _x5CartScriptPromise = null;

/**
 * Гарантирует, что window.x5CartData и window.x5engine доступны.
 * На prod-странице zima-led.ru они обычно уже есть (загружены сайтом).
 * В локальном демо мы подгружаем /cart/x5cart.js вручную.
 */
async function ensureX5CartLoaded() {
  if (window.x5engine?.cart?.manager && typeof window.x5engine.cart.manager.add === 'function') {
    return 'native';
  }
  if (window.x5CartData && window.x5CartData.settings) {
    return 'partial'; // есть данные, но нет engine — придётся писать в localStorage напрямую
  }
  // Пробуем подгрузить (только раз)
  if (!_x5CartScriptPromise) {
    _x5CartScriptPromise = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = X5CART_JS_URL;
      s.async = true;
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
  }
  await _x5CartScriptPromise;
  if (window.x5engine?.cart?.manager?.add) return 'native';
  if (window.x5CartData?.settings) return 'partial';
  return 'none';
}

/**
 * Основной метод. Добавляет все позиции из items в корзину.
 * @param {Array<{x5_id: string, qty: number}>} items
 * @returns {Promise<{added: number, failed: string[], mode: string, cartUrl: string}>}
 */
export async function addToSiteCart(items) {
  const mode = await ensureX5CartLoaded();
  if (mode === 'none') {
    return {
      added: 0, failed: items.map(i => i.x5_id), mode: 'none',
      cartUrl: CART_URL,
      error: 'Не удалось загрузить систему корзины zima-led.ru',
    };
  }

  if (mode === 'native') {
    return await addViaEngine(items);
  }
  // partial: пишем напрямую в localStorage
  return await addViaLocalStorage(items);
}

// ============================================================
// Способ 1: через нативный движок x5engine (предпочтительно)
// ============================================================
async function addViaEngine(items) {
  const failed = [];
  let added = 0;
  const mgr = window.x5engine.cart.manager;
  for (const it of items) {
    if (!it.x5_id) { failed.push(it.slug || 'unknown'); continue; }
    try {
      await mgr.add(it.x5_id, it.qty || 1);
      added += it.qty || 1;
    } catch (e) {
      console.warn('[cart] не добавлен', it, e);
      failed.push(it.x5_id);
    }
  }
  return { added, failed, mode: 'native', cartUrl: CART_URL };
}

// ============================================================
// Способ 2: пишем напрямую в localStorage (fallback)
// ============================================================
async function addViaLocalStorage(items) {
  const cartKey = window.x5CartData?.settings?.cartCookie || CART_STORAGE_KEY;
  // Читаем текущее состояние
  let cart;
  try {
    const raw = localStorage.getItem(cartKey);
    cart = raw ? JSON.parse(raw) : null;
  } catch { cart = null; }
  if (!cart || typeof cart !== 'object') {
    cart = { version: '2', itemKeys: [], itemKeysLastAccess: {}, items: {}, products: {} };
  }
  if (!cart.items) cart.items = {};
  if (!cart.products) cart.products = {};
  if (!cart.itemKeys) cart.itemKeys = [];
  if (!cart.itemKeysLastAccess) cart.itemKeysLastAccess = {};

  const failed = [];
  let added = 0;
  const now = Date.now();

  const productsSrc = window.x5CartData?.products || {};

  for (const it of items) {
    const pid = it.x5_id;
    if (!pid) { failed.push(it.slug || 'unknown'); continue; }
    const src = productsSrc[pid];
    if (!src) { failed.push(pid); continue; }

    // hash-ключ: обычно id-товара (для товаров без опций/вариантов)
    const hash = pid;
    // Если товар уже в корзине — увеличиваем количество, иначе создаём
    if (cart.items[hash]) {
      cart.items[hash].quantity = (parseInt(cart.items[hash].quantity, 10) || 0) + (it.qty || 1);
    } else {
      cart.items[hash] = {
        id: pid,
        productId: pid,
        quantity: it.qty || 1,
        option: null,
        suboption: null,
        addedAt: now,
      };
      cart.itemKeys.push(hash);
    }
    cart.itemKeysLastAccess[hash] = now;
    // Дублируем в products для совместимости с некоторыми версиями движка
    cart.products[hash] = cart.items[hash];
    added += it.qty || 1;
  }

  try {
    localStorage.setItem(cartKey, JSON.stringify(cart));
  } catch (e) {
    return { added: 0, failed: items.map(i => i.x5_id), mode: 'localStorage', cartUrl: CART_URL, error: e.message };
  }
  return { added, failed, mode: 'localStorage', cartUrl: CART_URL };
}

// ============================================================
// Утилиты
// ============================================================

export function getSiteCartCount() {
  try {
    const raw = localStorage.getItem(CART_STORAGE_KEY);
    if (!raw) return 0;
    const cart = JSON.parse(raw);
    const items = cart.items || cart.products || {};
    return Object.values(items).reduce((s, it) => s + (parseInt(it.quantity, 10) || 0), 0);
  } catch { return 0; }
}

export function openSiteCart() {
  window.open(CART_URL, '_blank', 'noopener');
}
