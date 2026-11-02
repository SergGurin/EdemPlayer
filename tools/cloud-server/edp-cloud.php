<?php
/*
 * EdemPlayer — собственное облако для резервных копий настроек (замена textdb.online).
 * Положите файл на любой хостинг/VPS с PHP 7+ и укажите его полный адрес в EdemPlayer:
 *   Настройки → Облако и файл → «Адрес облачного хранилища», например https://example.ru/edp-cloud.php
 * API:  GET  edp-cloud.php?key=<имя>          → содержимое записи (404, если нет)
 *       POST edp-cloud.php  key=<имя>&value=…  → сохранить; пустое value — удалить
 * Записи уже зашифрованы на устройстве: сервер видит только хэш-имя и шифротекст.
 */
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

$dir = __DIR__ . '/edp-data';
if (!is_dir($dir)) { @mkdir($dir, 0700, true); @file_put_contents($dir . '/.htaccess', "Require all denied\nDeny from all\n"); }

$key = isset($_REQUEST['key']) ? $_REQUEST['key'] : '';
if (!preg_match('/^[0-9A-Za-z_-]{6,80}$/', $key)) { http_response_code(400); echo '{"status":0,"message":"bad key"}'; exit; }
$file = $dir . '/' . $key . '.txt';

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
  header('Content-Type: text/plain; charset=utf-8');
  header('Cache-Control: no-store');
  if (!is_file($file)) { http_response_code(404); exit; }
  readfile($file);
  exit;
}
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
  header('Content-Type: application/json');
  $value = isset($_POST['value']) ? $_POST['value'] : '';
  if (strlen($value) > 500000) { http_response_code(413); echo '{"status":0,"message":"too large"}'; exit; }
  if ($value === '') { @unlink($file); echo '{"status":1}'; exit; }
  if (file_put_contents($file, $value, LOCK_EX) === false) { http_response_code(500); echo '{"status":0,"message":"write error"}'; exit; }
  echo '{"status":1}';
  exit;
}
http_response_code(405);
