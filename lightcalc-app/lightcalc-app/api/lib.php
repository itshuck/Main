<?php
/**
 * lib.php — общие хелперы API рейтинга ZimaLED LightCalc.
 *
 * Требования: PHP 7.1+ (shared-хостинг). Без БД: JSON-хранилище в api/data/
 * с блокировкой flock и атомарной записью (tmp + rename).
 *
 * Приватность (152-ФЗ): сырые IP и UA НЕ хранятся. Для дедупликации
 * голосов хранится только sha256(токен | sha256(IP | соль)). Соль
 * генерируется один раз при первом запросе и лежит в data/salt.txt.
 */

define('ZLC_API_VERSION', 1);

define('ZLC_DATA_DIR', __DIR__ . '/data');
define('ZLC_SEED_DIR', __DIR__ . '/seed');

define('ZLC_MAX_PAYLOAD', 400000);    // байт (как лимит #p= в клиенте)
define('ZLC_MAX_SHARES', 5000);       // LRU- cap хранилища шерингов
define('ZLC_MAX_VOTERS_PER_ITEM', 10000);
define('ZLC_VOTES_PER_IP_DAY', 40);   // анти-спам голосований
define('ZLC_SHARES_PER_IP_HOUR', 30); // анти-спам регистраций шерингов

// Рейтинг: байесовское среднее (как у IMDB): WR = v/(v+m)·avg + m/(v+m)·C
define('ZLC_TOP_PRIOR_M', 3);         // априорное число голосов
define('ZLC_TOP_PRIOR_C', 3.5);       // априорная оценка
define('ZLC_TOP_MIN_VOTES', 3);       // полноценное место в топе

// ============================================================
// Ответы
// ============================================================

function zlc_json_out($data, $code = 200) {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function zlc_fail($msg, $code = 400) {
    zlc_json_out(array('ok' => false, 'error' => $msg), $code);
}

// Только POST-JSON
function zlc_read_json_body() {
    $len = isset($_SERVER['CONTENT_LENGTH']) ? (int)$_SERVER['CONTENT_LENGTH'] : 0;
    if ($len > ZLC_MAX_PAYLOAD + 2048) zlc_fail('payload слишком большой', 413);
    $raw = file_get_contents('php://input');
    if ($raw === false || strlen($raw) > ZLC_MAX_PAYLOAD + 2048) zlc_fail('payload слишком большой', 413);
    if (strlen($raw) === 0) zlc_fail('пустое тело запроса');
    $d = json_decode($raw, true);
    if (!is_array($d)) zlc_fail('некорректный JSON');
    return $d;
}

// ============================================================
// Хранилище (JSON + flock, атомарная запись)
// ============================================================

function zlc_ensure_dirs() {
    if (!is_dir(ZLC_DATA_DIR)) @mkdir(ZLC_DATA_DIR, 0775, true);
}

function zlc_load($name) {
    $f = ZLC_DATA_DIR . '/' . $name . '.json';
    if (!is_file($f)) return null;
    $raw = @file_get_contents($f);
    if ($raw === false || $raw === '') return null;
    $d = json_decode($raw, true);
    return is_array($d) ? $d : null;
}

function zlc_save($name, $data) {
    zlc_ensure_dirs();
    $f = ZLC_DATA_DIR . '/' . $name . '.json';
    $tmp = $f . '.tmp.' . getmypid();
    $json = json_encode($data, JSON_UNESCAPED_UNICODE);
    if ($json === false) return false;
    $ok = @file_put_contents($tmp, $json, LOCK_EX) !== false;
    if ($ok) $ok = @rename($tmp, $f);
    if (!$ok && is_file($tmp)) @unlink($tmp);
    return $ok;
}

/**
 * Атомарное чтение-изменение-запись под эксклюзивной блокировкой.
 * $fn получает массив данных по ссылке и возвращает bool:
 *   true  — данные изменены, сохранить;
 *   false — без изменений, не сохранять.
 * zlc_update возвращает array(bool $saved, array $data) или null при ошибке.
 */
function zlc_update($name, $fn) {
    zlc_ensure_dirs();
    $lockF = ZLC_DATA_DIR . '/' . $name . '.lock';
    $lh = @fopen($lockF, 'c');
    if (!$lh) return null;
    $saved = false;
    $data = array();
    if (flock($lh, LOCK_EX)) {
        $loaded = zlc_load($name);
        $data = $loaded !== null ? $loaded : array();
        if (call_user_func_array($fn, array(&$data))) {
            $saved = zlc_save($name, $data);
        }
        flock($lh, LOCK_UN);
    }
    fclose($lh);
    return array($saved, $data);
}

// Соль установки (генерируется один раз)
function zlc_salt() {
    $f = ZLC_DATA_DIR . '/salt.txt';
    if (is_file($f)) {
        $s = trim((string)@file_get_contents($f));
        if (strlen($s) >= 32) return $s;
    }
    zlc_ensure_dirs();
    $s = bin2hex(random_bytes(16));
    @file_put_contents($f, $s, LOCK_EX);
    return $s;
}

// ============================================================
// Идентификация (только хэши, без сырых данных)
// ============================================================

function zlc_client_ip() {
    // REMOTE_ADDR — соединение клиента с сервером; XFF не доверяем (спуфинг).
    return isset($_SERVER['REMOTE_ADDR']) ? (string)$_SERVER['REMOTE_ADDR'] : '0.0.0.0';
}

function zlc_ip_hash() {
    return hash('sha256', zlc_client_ip() . '|' . zlc_salt());
}

/** Хэш голосующего: sha256(токен | ipHash). Сами значения не хранятся. */
function zlc_voter_hash($token) {
    $t = preg_replace('/[^A-Za-z0-9\-_]/', '', substr((string)$token, 0, 64));
    if (strlen($t) < 8) return '';
    return hash('sha256', $t . '|' . zlc_ip_hash());
}

/** ID шеринга: 11 символов base64url(sha256(payload)). Совпадает с клиентом/сидами. */
function zlc_share_id($payload) {
    $raw = hash('sha256', (string)$payload, true);
    $b64 = rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
    return substr($b64, 0, 11);
}

// ============================================================
// Сиды (первый запуск): переносим предзаполненный топ из api/seed/
// ============================================================

function zlc_import_seeds() {
    zlc_ensure_dirs();
    if (is_file(ZLC_DATA_DIR . '/shares.json')) return; // уже инициализировано
    foreach (array('shares', 'votes') as $name) {
        $seed = ZLC_SEED_DIR . '/' . $name . '.seed.json';
        $dst  = ZLC_DATA_DIR . '/' . $name . '.json';
        if (is_file($seed) && !is_file($dst)) {
            @copy($seed, $dst);
        }
    }
}

// ============================================================
// Rate-limit (ведро по ip_hash; хранит только хэши и счётчики)
// ============================================================

/**
 * Проверяет и инкрементирует лимит. Возвращает true, если действие разрешено.
 * $bucket — 'vote' | 'share'; ключ — ip_hash. Счётчик сохраняется всегда.
 */
function zlc_rate_limit($bucket, $key, $limit, $windowSec) {
    $now = time();
    $allowed = true;
    $res = zlc_update('rate', function (&$d) use ($bucket, $key, $limit, $windowSec, $now, &$allowed) {
        if (!isset($d[$bucket]) || !is_array($d[$bucket])) $d[$bucket] = array();
        // чистка устаревших, чтобы файл не рос бесконечно
        if (count($d[$bucket]) > 5000) {
            foreach ($d[$bucket] as $k => $v) {
                if (!is_array($v) || !isset($v[1]) || $v[1] < $now - $windowSec) unset($d[$bucket][$k]);
            }
        }
        $c = isset($d[$bucket][$key]) && is_array($d[$bucket][$key]) ? $d[$bucket][$key] : null;
        if (!$c || !isset($c[1]) || $c[1] < $now - $windowSec) $c = array(0, $now);
        if ((int)$c[0] >= $limit) {
            $allowed = false;
        } else {
            $c[0] = (int)$c[0] + 1;
        }
        $c[1] = $now;
        $d[$bucket][$key] = $c;
        return true; // всегда сохраняем состояние счётчика
    });
    if ($res === null) return true; // не смогли заблокировать — пропускаем (best effort)
    return $allowed;
}
