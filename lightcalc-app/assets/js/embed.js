/**
 * embed.js — точка входа для инъекции калькулятора в HTML-виджет
 * стороннего сайта (zima-led.ru/lightcalc).
 *
 * Что делает:
 *   1. Находит контейнер #zlc-app
 *   2. Строит внутри него ту же DOM-структуру, что в index.html
 *   3. Импортирует и запускает app.js
 *
 * Требования к странице:
 *   - Наличие <div id="zlc-app" class="zlc-root"></div>
 *   - Подключён lightcalc.css со scoped-стилями
 *   - Установлен window.__ZLC_BASE__ (абсолютный путь до ассетов)
 */

const BASE_SETTING = (typeof window !== 'undefined' && window.__ZLC_BASE__) || '/lightcalc-app/';
// Вычисляем BASE относительно страницы-хоста, а не относительно assets/js/embed.js.
// Иначе локальное значение "./" превращалось в ошибочный assets/js/assets/js/app.js.
const BASE = new URL(BASE_SETTING, document.baseURI).href;
const VERSION = (typeof window !== 'undefined' && window.__ZLC_VERSION__) || 'dev';

// Некоторые CMS-шаблоны не добавляют viewport meta. Без него телефон рендерит
// страницу как desktop ~980px и ни один мобильный breakpoint не срабатывает.
function ensureViewportMeta() {
  if (document.querySelector('meta[name="viewport"]')) return;
  const meta = document.createElement('meta');
  meta.name = 'viewport';
  meta.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
  document.head?.appendChild(meta);
}
ensureViewportMeta();

// Патчим fetch-пути в дочерних модулях: они запрашивают 'assets/data/...'
// по относительному пути от текущей страницы. На /lightcalc это работать не будет.
// Решение: перехватываем fetch для наших data-JSON и подставляем BASE.
(function patchFetchForDataPaths() {
  const origFetch = window.fetch.bind(window);
  const DATA_MATCHERS = [
    /(?:^|\/)assets\/data\/([\w-]+\.json)(?:\?.*)?$/,
  ];
  window.fetch = function(input, init) {
    let url = typeof input === 'string' ? input : (input && input.url) || '';
    for (const rx of DATA_MATCHERS) {
      const m = String(url).match(rx);
      if (m) {
        // абсолютный путь через BASE
        const abs = BASE + 'assets/data/' + m[1];
        // подмешиваем cache-buster из query исходного запроса, если он был
        const qMatch = String(url).match(/\?(.*)$/);
        const finalUrl = abs + (qMatch ? '?' + qMatch[1] : '');
        return origFetch(finalUrl, init);
      }
    }
    return origFetch(input, init);
  };
})();

function buildDOM(host) {
  // Внутренняя разметка калькулятора — идентична содержимому <body> index.html,
  // но без глобального <header>/<footer> сайта.
  host.innerHTML = `
    <div class="zlc-app-wrap">
      <header class="app-header zlc-hdr" role="banner">
        <div class="logo">💡 ZimaLED · LightCalc</div>
        <div class="subtitle">Калькулятор трекового освещения</div>
        <div class="spacer"></div>
        <div class="badge" id="zlc-catalog-badge" title="Каталог загружается автоматически из /cart/x5cart.js">…</div>
      </header>

      <main class="app" role="main">
        <aside class="steps" aria-label="Шаги мастера">
          <h3>Шаги</h3>
          <div id="steps-list"></div>
          <div class="mt-lg muted" style="font-size:12px;line-height:1.5">
            Каталог — с сайта <a href="https://zima-led.ru" target="_blank" rel="noopener">zima-led.ru</a>.<br>
            Нормы: СП&nbsp;52.13330.2016, EN&nbsp;12464-1.
          </div>
        </aside>

        <section class="main" id="main">
          <div class="step-content" id="step-1"></div>
          <div class="step-content" id="step-2"></div>
          <div class="step-content" id="step-3"></div>
          <div class="step-content" id="step-4"></div>
          <div class="step-content" id="step-5"></div>
        </section>
      </main>
    </div>
  `;
}

async function boot() {
  const host = document.getElementById('zlc-app');
  if (!host) {
    console.error('[zlc] контейнер #zlc-app не найден в DOM');
    return;
  }
  // Гарантируем класс zlc-root (даже если в вёрстке случайно оторвался)
  host.classList.add('zlc-root');

  buildDOM(host);

  try {
    // Импортируем app.js. Он сам вызовет init() и повесит __zima в window.
    await import(`${BASE}assets/js/app.js?v=${encodeURIComponent(VERSION)}`);
    console.info('[zlc] mounted');
  } catch (e) {
    console.error('[zlc] init error:', e);
    // Безопасный вывод ошибки: через createTextNode (экранируется от XSS),
    // без inline-кода в атрибутах.
    host.innerHTML = '';
    const box = document.createElement('div');
    box.style.cssText = 'padding:20px;color:#c03030;background:#fff5f5;border:1px solid #f16876;border-radius:6px;font-family:sans-serif';
    const b = document.createElement('b');
    b.textContent = 'Не удалось запустить калькулятор: ';
    box.appendChild(b);
    box.appendChild(document.createTextNode(String((e && e.message) || e)));
    const br = document.createElement('br');
    box.appendChild(br);
    const small = document.createElement('small');
    small.textContent = `Проверьте, что путь ${BASE}assets/js/app.js доступен.`;
    box.appendChild(small);
    host.appendChild(box);
  }
}

// Ждём DOMContentLoaded если ещё не загрузился (в HTML-виджете скрипт может выполниться до DOM)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
