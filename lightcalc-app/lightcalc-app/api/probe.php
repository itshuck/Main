<?php
/**
 * probe.php — самопроба API рейтинга.
 * Клиент (share.js → apiProbe) вызывает это первым: если ответ не {ok,api:zlc},
 * витрина «Топ-12» не показывается и ссылки остаются самодостаточными (#p=).
 */

require __DIR__ . '/lib.php';

zlc_json_out(array(
    'ok'   => true,
    'api'  => 'zlc',
    'v'    => ZLC_API_VERSION,
    't'    => time(),
));
