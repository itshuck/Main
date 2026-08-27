<?php
/**
 * share.php — регистрация шеринга и выдача payload по короткому ID.
 *
 * POST {payload: "3z.xxx"} → {ok, id} — регистрирует/находит шеринг,
 *   инкрементирует счётчик шерингов (каждое нажатие «Ссылка на проект»).
 * GET  ?id=xxx            → {ok, id, payload, stats} — отдаёт payload и
 *   инкрементирует счётчик открытий (переход по короткой ссылке #s=ID,
 *   открытие из витрины).
 *
 * Payload хранится КАК ЕСТЬ (закодированная строка формата v3, 0.5–2.5 КБ) —
 * серверу не нужно его понимать, декодирует клиент тем же кодеком share.js.
 */

require __DIR__ . '/lib.php';
zlc_import_seeds();

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    $body = zlc_read_json_body();
    $payload = isset($body['payload']) ? $body['payload'] : '';
    if (!is_string($payload) || strlen($payload) < 4) zlc_fail('нет payload');
    if (strlen($payload) > ZLC_MAX_PAYLOAD) zlc_fail('payload слишком большой', 413);
    // Формат v3: '3z.' (deflate) или '3.' (plain) + base64url
    if (!preg_match('/^3(z)?\.[A-Za-z0-9_-]+$/', $payload)) zlc_fail('некорректный формат payload');

    if (!zlc_rate_limit('share', zlc_ip_hash(), ZLC_SHARES_PER_IP_HOUR, 3600)) {
        zlc_fail('слишком много регистраций, попробуйте позже', 429);
    }

    $id = zlc_share_id($payload);
    $now = time();

    $res = zlc_update('shares', function (&$d) use ($payload, $id, $now) {
        if (!is_array($d)) $d = array();
        if (isset($d[$id]) && is_array($d[$id])) {
            $d[$id]['sc'] = (int)$d[$id]['sc'] + 1;   // ещё один шеринг
            return true;
        }
        // Новый шеринг. LRU: не храним больше ZLC_MAX_SHARES записей.
        if (count($d) >= ZLC_MAX_SHARES) {
            uasort($d, function ($a, $b) { return (int)$a['ts'] - (int)$b['ts']; });
            $d = array_slice($d, -(ZLC_MAX_SHARES - 1), null, true);
        }
        $d[$id] = array(
            'p'  => $payload,
            'ts' => $now,   // создан
            'sc' => 1,      // share count
            'oc' => 0,      // open count
        );
        return true;
    });
    if ($res === null || !$res[0]) zlc_fail('не удалось сохранить шеринг', 500);

    zlc_json_out(array('ok' => true, 'id' => $id));
}

// GET: выдача payload по ID (+ открытие)
$id = isset($_GET['id']) ? (string)$_GET['id'] : '';
if (!preg_match('/^[A-Za-z0-9_-]{6,16}$/', $id)) zlc_fail('некорректный id');

$found = null;
$res = zlc_update('shares', function (&$d) use ($id, &$found) {
    if (is_array($d) && isset($d[$id]) && is_array($d[$id])) {
        $d[$id]['oc'] = (int)$d[$id]['oc'] + 1;
        $found = $d[$id];
        return true;
    }
    return false; // ничего не меняем
});
if ($found === null) zlc_fail('шеринг не найден', 404);
if ($res === null) zlc_fail('ошибка хранилища', 500);

zlc_json_out(array(
    'ok'      => true,
    'id'      => $id,
    'payload' => (string)$found['p'],
    'stats'   => array('shares' => (int)$found['sc'], 'opens' => (int)$found['oc']),
));
