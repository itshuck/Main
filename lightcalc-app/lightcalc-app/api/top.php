<?php
/**
 * top.php — топ-N проектов для витрины «🏆 Популярные проекты».
 *
 * GET ?limit=12 → {ok, items:[{id, p, stars, votes, shares, opens, wr, fresh}]}
 *
 * Ранжирование — байесовское среднее (IMDB-подход):
 *   WR = v/(v+m)·avg + m/(v+m)·C,  m = ZLC_TOP_PRIOR_M, C = ZLC_TOP_PRIOR_C.
 *   Одна пятёрка от друга не выстрелит проект в топ: при v=1 голос
 *   оценка сдвигается к априорной 3.5.
 * Полноценные места — проекты с votes >= ZLC_TOP_MIN_VOTES; если таких
 * меньше limit — добиваем по популярности (shares+opens), помечаем fresh=1.
 */

require __DIR__ . '/lib.php';
zlc_import_seeds();

$limit = isset($_GET['limit']) ? (int)$_GET['limit'] : 12;
if ($limit < 1) $limit = 12;
if ($limit > 24) $limit = 24;

$shares = zlc_load('shares');
$votes  = zlc_load('votes');
if (!is_array($shares)) $shares = array();
if (!is_array($votes))  $votes = array();

$candidates = array();
foreach ($shares as $id => $sh) {
    if (!is_array($sh) || !isset($sh['p'])) continue;
    $v = 0; $sum = 0;
    if (isset($votes[$id]) && is_array($votes[$id])) {
        $v = isset($votes[$id]['c']) ? (int)$votes[$id]['c'] : 0;
        $sum = isset($votes[$id]['s']) ? (int)$votes[$id]['s'] : 0;
    }
    $avg = $v > 0 ? $sum / $v : 0.0;
    $m = ZLC_TOP_PRIOR_M;
    $wr = ($v / ($v + $m)) * $avg + ($m / ($v + $m)) * ZLC_TOP_PRIOR_C;
    $candidates[] = array(
        'id'     => (string)$id,
        'p'      => (string)$sh['p'],
        'stars'  => round($avg, 2),
        'votes'  => $v,
        'shares' => isset($sh['sc']) ? (int)$sh['sc'] : 0,
        'opens'  => isset($sh['oc']) ? (int)$sh['oc'] : 0,
        'wr'     => round($wr, 4),
        'pop'    => (isset($sh['sc']) ? (int)$sh['sc'] : 0) + (isset($sh['oc']) ? (int)$sh['oc'] : 0),
    );
}

$ranked = array();
$fresh  = array();
foreach ($candidates as $c) {
    if ($c['votes'] >= ZLC_TOP_MIN_VOTES) $ranked[] = $c;
    else $fresh[] = $c;
}

usort($ranked, function ($a, $b) {
    if ($a['wr'] !== $b['wr']) return $b['wr'] <=> $a['wr'];
    return $b['pop'] <=> $a['pop'];
});
usort($fresh, function ($a, $b) {
    if ($a['pop'] !== $b['pop']) return $b['pop'] <=> $a['pop'];
    return $b['wr'] <=> $a['wr'];
});

$items = array();
foreach (array_merge($ranked, $fresh) as $i => $c) {
    if (count($items) >= $limit) break;
    $c['fresh'] = $c['votes'] < ZLC_TOP_MIN_VOTES ? 1 : 0;
    unset($c['pop']);
    $items[] = $c;
}

zlc_json_out(array('ok' => true, 'count' => count($items), 'items' => $items));
