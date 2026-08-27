<?php
/**
 * vote.php — голос звёздами 1–5 за проект (шеринг).
 *
 * POST {id, stars, token}
 *   id    — ID шеринга (из #s=ссылки или витрины);
 *   stars — 1..5;
 *   token — анонимный токен голосующего из localStorage (НЕ персональные
 *           данные; генерируется случайно в браузере).
 *
 * Дедупликация: один голосующий (токен + IP-хэш) = один голос на проект;
 * повторное голосование ИЗМЕНЯЕТ оценку, а не добавляет новую.
 * Анти-спам: лимит голосований на IP-хэш в сутки (ZLC_VOTES_PER_IP_DAY).
 *
 * Ответ: {ok, avg, count, mine}.
 */

require __DIR__ . '/lib.php';
zlc_import_seeds();

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') zlc_fail('только POST', 405);

$body = zlc_read_json_body();
$id    = isset($body['id']) ? (string)$body['id'] : '';
$stars = isset($body['stars']) ? (int)$body['stars'] : 0;
$token = isset($body['token']) ? (string)$body['token'] : '';

if (!preg_match('/^[A-Za-z0-9_-]{6,16}$/', $id)) zlc_fail('некорректный id');
if ($stars < 1 || $stars > 5) zlc_fail('оценка должна быть 1–5');
$voter = zlc_voter_hash($token);
if ($voter === '') zlc_fail('некорректный токен');

// Шеринг должен существовать
$shares = zlc_load('shares');
if (!is_array($shares) || !isset($shares[$id])) zlc_fail('проект не найден', 404);

if (!zlc_rate_limit('vote', zlc_ip_hash(), ZLC_VOTES_PER_IP_DAY, 86400)) {
    zlc_fail('слишком много оценок за сутки', 429);
}

$now = time();
$res = zlc_update('votes', function (&$d) use ($id, $stars, $voter, $now) {
    if (!is_array($d)) $d = array();
    if (!isset($d[$id]) || !is_array($d[$id])) {
        $d[$id] = array('s' => 0, 'c' => 0, 'v' => array());
    }
    $item = &$d[$id];
    if (count($item['v']) >= ZLC_MAX_VOTERS_PER_ITEM && !isset($item['v'][$voter])) {
        return false; // переполнение — новых голосующих не принимаем
    }
    if (isset($item['v'][$voter]) && is_array($item['v'][$voter])) {
        // Смена своей оценки: вычитаем старую, добавляем новую
        $item['s'] = (int)$item['s'] - (int)$item['v'][$voter]['st'] + $stars;
        $item['v'][$voter] = array('st' => $stars, 'ts' => $now);
    } else {
        $item['s'] = (int)$item['s'] + $stars;
        $item['c'] = (int)$item['c'] + 1;
        $item['v'][$voter] = array('st' => $stars, 'ts' => $now);
    }
    unset($item);
    return true;
});
if ($res === null || !$res[0]) zlc_fail('не удалось сохранить оценку', 500);

$item = isset($res[1][$id]) ? $res[1][$id] : null;
if (!is_array($item)) zlc_fail('ошибка чтения оценки', 500);
$count = max(1, (int)$item['c']);
$avg = round(((int)$item['s']) / $count, 2);

zlc_json_out(array('ok' => true, 'avg' => $avg, 'count' => (int)$item['c'], 'mine' => $stars));
