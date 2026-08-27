<?php
/**
 * selftest.php — однократная проверка API рейтинга после деплоя.
 * Откройте в браузере: https://zima-led.ru/lightcalc-app/api/selftest.php
 * Все пункты должны быть зелёными. После проверки файл можно удалить.
 */

require __DIR__ . '/lib.php';
zlc_import_seeds();

error_reporting(E_ALL);
ini_set('display_errors', '0');

$checks = array();

// 1. Версия PHP
$checks[] = array('PHP >= 7.1', version_compare(PHP_VERSION, '7.1.0', '>='), PHP_VERSION);

// 2. Каталог данных доступен на запись
zlc_ensure_dirs();
$writable = is_dir(ZLC_DATA_DIR) && is_writable(ZLC_DATA_DIR);
$checks[] = array('api/data/ доступен на запись', $writable, ZLC_DATA_DIR);

// 3. Соль генерируется
$salt = zlc_salt();
$checks[] = array('Соль установки создана', strlen($salt) >= 32, strlen($salt) . ' символов');

// 4. Сиды импортированы
$shares = zlc_load('shares');
$votes = zlc_load('votes');
$checks[] = array(
    'Сиды «Топ-12» импортированы',
    is_array($shares) && count($shares) > 0,
    'шерингов: ' . (is_array($shares) ? count($shares) : 0) .
    ', с оценками: ' . (is_array($votes) ? count($votes) : 0),
);

// 5. Атомарная запись работает
$testOk = false;
$res = zlc_update('__selftest', function (&$d) { $d['t'] = time(); return true; });
if ($res !== null && $res[0]) {
    $back = zlc_load('__selftest');
    $testOk = is_array($back) && isset($back['t']);
    @unlink(ZLC_DATA_DIR . '/__selftest.json');
    @unlink(ZLC_DATA_DIR . '/__selftest.lock');
}
$checks[] = array('Хранилище: запись+чтение+flock', $testOk, '');

// 6. ID детерминирован (совместимость с клиентом)
$id1 = zlc_share_id('3.testpayload');
$id2 = zlc_share_id('3.testpayload');
$checks[] = array('ID шеринга детерминирован', $id1 === $id2 && strlen($id1) === 11, $id1);

// 7. Регистрация шеринга (без влияния на прод: LRU-тестовая запись)
$fake = '3z.' . rtrim(strtr(base64_encode(random_bytes(64)), '+/', '-_'), '=');
$fid = zlc_share_id($fake);
$regOk = false;
$res = zlc_update('shares', function (&$d) use ($fake, $fid) {
    if (!is_array($d)) $d = array();
    if (!isset($d[$fid])) {
        $d[$fid] = array('p' => $fake, 'ts' => time(), 'sc' => 1, 'oc' => 0);
    } else {
        $d[$fid]['sc'] = (int)$d[$fid]['sc'] + 1;
    }
    return true;
});
if ($res !== null && $res[0]) {
    $after = zlc_load('shares');
    $regOk = is_array($after) && isset($after[$fid]);
}
$checks[] = array('Регистрация шеринга работает', $regOk, 'id ' . $fid);

// Отчёт
$allOk = true;
foreach ($checks as $c) if (!$c[1]) $allOk = false;
header('Content-Type: text/html; charset=utf-8');
?>
<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>LightCalc API — selftest</title>
<style>
  body { font-family: Arial, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 16px; color: #333; }
  h1 { font-size: 20px; }
  .row { display: flex; gap: 10px; padding: 8px 10px; border-bottom: 1px solid #eee; }
  .ok { color: #16a34a; font-weight: bold; }
  .fail { color: #dc2626; font-weight: bold; }
  .info { color: #888; font-size: 12px; }
</style></head><body>
<h1>LightCalc API — самопроверка</h1>
<?php foreach ($checks as $c): ?>
  <div class="row">
    <span class="<?= $c[1] ? 'ok' : 'fail' ?>"><?= $c[1] ? '✅' : '❌' ?></span>
    <span><?= htmlspecialchars($c[0], ENT_QUOTES, 'UTF-8') ?></span>
    <span class="info"><?= htmlspecialchars($c[2], ENT_QUOTES, 'UTF-8') ?></span>
  </div>
<?php endforeach; ?>
<p style="margin-top:20px">
  <?php if ($allOk): ?>
    ✅ Всё в порядке — витрина «Топ-12» и рейтинг звёзд работают.
    Этот файл можно удалить с хостинга.
  <?php else: ?>
    ❌ Есть проблемы. Скорее всего: (1) PHP отключён — попросите хостер включить;
    (2) права на запись — выставите 775 на api/data/; (3) сиды не скопированы.
    Витрина при этом просто не покажется, калькулятор работает как обычно.
  <?php endif; ?>
</p>
</body></html>
