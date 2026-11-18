// HDRezka (rezka.ag) scraper for Nuvio
// - сайт закрыт защитой Anubis: задача решается прямо в скрапере (SHA-256 proof-of-work)
// - поиск по русскому и оригинальному названию из TMDB, сверка года и типа (фильм/сериал)
// - запрос потоков с token_id со страницы (без него сайт отдаёт заглушку)
// - несколько озвучек: выбранная на сайте, приоритетные, остальные; «Оригинал (+субтитры)»
// - премиум-качества (1080p Ultra, 2K, 4K) пропускаются: без премиума вместо них заглушка
// - если rezka.ag не отвечает, пробуются зеркала
// Только Promise-цепочки, без async/await (требование Nuvio).

var TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
var DOMAINS = ['https://rezka.ag', 'https://hdrezka.ag', 'https://hdrezka.me'];
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

var MAX_TRANSLATORS = 8;   // сколько озвучек запрашивать (оригинал добавляется сверх этого)
var CONCURRENCY = 3;       // сколько запросов к сайту одновременно
var USE_MP4 = true;        // true — прямой MP4, false — HLS (m3u8)
var SKIP_UKRAINIAN = true; // не показывать украинские озвучки
var INCLUDE_ORIGINAL = true; // добавлять «Оригинал (+субтитры)», если есть
// порядок озвучек: эти идут сразу после озвучки, выбранной на сайте (это НЕ фильтр)
var TRANSLATOR_PRIORITY = ['дубляж', 'hdrezka studio', 'lostfilm', 'лостфильм', 'tvshows', 'кубик', 'kubik', 'amedia', 'амедиа', 'newstudio', 'jaskier', 'яскъер', 'red head sound', 'кураж', 'гоблин'];

var T0 = Date.now();
var DEBUG = true; // ОТЛАДОЧНАЯ ВЕРСИЯ — // true — показывать лог строками DEBUG в списке стримов (для поиска ошибок)
var LOGS = [];
function log(msg) {
  msg = '[' + (Date.now() - T0) + 'ms] ' + msg;
  LOGS.push(String(msg));
  try { console.log('[HDRezka] ' + msg); } catch (e) {}
}

function debugStreams() {
  if (!DEBUG) return [];
  return LOGS.map(function (line, i) {
    return {
      name: 'DEBUG ' + (i + 1) + ': ' + line.slice(0, 120),
      title: line,
      url: DOMAINS[0] + '/?debug=' + i,
      quality: line.slice(0, 60),
      provider: 'hdrezka'
    };
  });
}

function assign(a, b) {
  var o = {}, k;
  for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) o[k] = a[k];
  for (k in b) if (Object.prototype.hasOwnProperty.call(b, k)) o[k] = b[k];
  return o;
}

function pageHeaders(base) {
  return {
    'User-Agent': UA,
    'Referer': base + '/',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8'
  };
}

function ajaxHeaders(base) {
  return assign(pageHeaders(base), {
    'Origin': base,
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'X-Requested-With': 'XMLHttpRequest'
  });
}

function formBody(obj) {
  var parts = [];
  for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) {
    if (obj[k] === undefined || obj[k] === null) continue;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(obj[k])));
  }
  return parts.join('&');
}

// выполнить fn для каждого элемента, не больше limit одновременно
function mapLimit(items, limit, fn) {
  var results = new Array(items.length), idx = 0;
  function worker() {
    if (idx >= items.length) return Promise.resolve();
    var i = idx++;
    return Promise.resolve().then(function () { return fn(items[i], i); })
      .then(function (r) { results[i] = r; }, function () { results[i] = []; })
      .then(worker);
  }
  var ws = [];
  for (var w = 0; w < Math.min(limit, items.length); w++) ws.push(worker());
  return Promise.all(ws).then(function () { return results; });
}

// ===== Anubis (TecharoHQ) =====
// rezka.ag: Anubis v1.27.0, алгоритм "fast", сложность 2.
// Задача: найти nonce, при котором sha256(randomData + nonce) в hex начинается
// с `difficulty` нулей. Решение отправляется GET-запросом на
// /.within.website/x/cmd/anubis/api/pass-challenge, в ответ сайт ставит cookie
// "techaro.lol-anubis-auth-…" (JWT, живёт 30 дней).
// Проверено на rezka.ag 18.11.2026: решение принимается, cookie выдаётся.
// Задача привязана к User-Agent и IP, поэтому UA во всех запросах должен быть один и тот же.
// Только Promise-цепочки, без async/await (требование Nuvio).

var ANUBIS_COOKIES = {}; // имя -> значение; cookie из Set-Cookie, если их видно
// false — cookie хранит сам телефон (iOS/Android), вручную их не подставляем;
// true — подставляем вручную (включается, только если без этого проверка не прошла)
var ANUBIS_MANUAL = false;

// --- SHA-256 (чистый JS, на вход строка ASCII/UTF-8, на выход hex) ---
var SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function sha256Hex(str) {
  var bytes = [];
  for (var i = 0; i < str.length; i++) {
    var cc = str.charCodeAt(i);
    if (cc < 0x80) bytes.push(cc);
    else if (cc < 0x800) bytes.push(0xC0 | (cc >> 6), 0x80 | (cc & 63));
    else bytes.push(0xE0 | (cc >> 12), 0x80 | ((cc >> 6) & 63), 0x80 | (cc & 63));
  }
  var bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  bytes.push(0, 0, 0, 0); // старшие 32 бита длины (строки короткие)
  bytes.push((bitLen >>> 24) & 255, (bitLen >>> 16) & 255, (bitLen >>> 8) & 255, bitLen & 255);

  var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  var w = new Array(64);
  for (var off = 0; off < bytes.length; off += 64) {
    for (var t = 0; t < 16; t++) {
      var j = off + t * 4;
      w[t] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
    }
    for (t = 16; t < 64; t++) {
      var x = w[t - 15], y = w[t - 2];
      var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (t = 0; t < 64; t++) {
      var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      var ch = (e & f) ^ (~e & g);
      var t1 = (hh + S1 + ch + SHA256_K[t] + w[t]) | 0;
      var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }
  var out = '';
  for (i = 0; i < 8; i++) out += ('00000000' + (h[i] >>> 0).toString(16)).slice(-8);
  return out;
}

// --- решение задачи ---
function anubisSolve(randomData, difficulty) {
  var prefix = new Array(difficulty + 1).join('0');
  var started = Date.now();
  for (var nonce = 0; nonce < 50000000; nonce++) {
    var hash = sha256Hex(randomData + nonce);
    if (hash.indexOf(prefix) === 0) {
      return { hash: hash, nonce: nonce, elapsed: Math.max(1, Date.now() - started) };
    }
  }
  throw new Error('anubis: не нашёл nonce');
}

function anubisParse(html) {
  if (!html || html.indexOf('anubis_challenge') === -1) return null;
  var m = html.match(/<script[^>]*id="anubis_challenge"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    var j = JSON.parse(m[1]);
    var p = html.match(/<script[^>]*id="anubis_base_prefix"[^>]*>([\s\S]*?)<\/script>/);
    var basePrefix = '';
    try { basePrefix = p ? JSON.parse(p[1]) : ''; } catch (e) {}
    return {
      id: j.challenge.id,
      randomData: j.challenge.randomData,
      difficulty: (j.rules && j.rules.difficulty) || j.challenge.difficulty,
      algorithm: (j.rules && j.rules.algorithm) || j.challenge.method,
      basePrefix: basePrefix || ''
    };
  } catch (e) { return null; }
}

// --- cookie: React Native на Android сам хранит cookie, но на всякий случай
// забираем Set-Cookie, если он виден, и подставляем вручную ---
function anubisRememberCookies(resp) {
  try {
    var sc = resp.headers && resp.headers.get && resp.headers.get('set-cookie');
    if (!sc) return;
    sc.split(/,(?=\s*[^;,=\s]+=)/).forEach(function (part) {
      var kv = part.split(';')[0].trim();
      var eq = kv.indexOf('=');
      if (eq <= 0) return;
      var name = kv.slice(0, eq), value = kv.slice(eq + 1);
      var exp = part.match(/expires=([^;]+)/i);
      // Anubis стирает cookie пустым значением / Max-Age=0 / датой в прошлом — такие удаляем
      var deleted = !value || /max-age=\s*(-\d+|0)\b/i.test(part) ||
        (exp && !isNaN(Date.parse(exp[1])) && Date.parse(exp[1]) < Date.now());
      if (deleted) delete ANUBIS_COOKIES[name];
      else ANUBIS_COOKIES[name] = value;
    });
  } catch (e) {}
}

function anubisCookieHeader() {
  return Object.keys(ANUBIS_COOKIES).map(function (k) { return k + '=' + ANUBIS_COOKIES[k]; }).join('; ');
}

function anubisOpts(opts) {
  var o = {};
  opts = opts || {};
  Object.keys(opts).forEach(function (k) { o[k] = opts[k]; });
  var h = {};
  var src = opts.headers || {};
  Object.keys(src).forEach(function (k) { h[k] = src[k]; });
  var ck = ANUBIS_MANUAL ? anubisCookieHeader() : '';
  if (ck) h['Cookie'] = h['Cookie'] ? h['Cookie'] + '; ' + ck : ck;
  o.headers = h;
  return o;
}

// fetch, который сам проходит Anubis. Возвращает { status, text }.
// Важно: в opts.headers должен быть тот же User-Agent, что и во всех остальных запросах.
function anubisFetchText(url, opts, _retried) {
  return anubisFetchTextInner(url, opts, _retried).catch(function (e) {
    log('fetch ОШИБКА ' + url.replace(/^https?:\/\/[^\/]+/, '').slice(0, 50) + ': ' + e.message);
    throw e;
  });
}

function anubisFetchTextInner(url, opts, _retried) {
  var ao = anubisOpts(opts);
  return fetch(url, ao).then(function (r) {
    var sc = null;
    try { sc = r.headers && r.headers.get && r.headers.get('set-cookie'); } catch (e) { sc = 'ERR ' + e.message; }
    anubisRememberCookies(r);
    return r.text().then(function (text) {
      var ch = anubisParse(text);
      log('fetch ' + url.replace(/^https?:\/\/[^\/]+/, '').slice(0, 50) + (_retried ? ' (повтор ' + _retried + ')' : '') + ' → ' + r.status +
        ', ' + text.length + 'б' + (ch ? ', ПРОВЕРКА ANUBIS' : '') +
        ', set-cookie: ' + (sc ? String(sc).split(/,(?=\s*[^;,=\s]+=)/).map(function (p) { var kv = p.split(';')[0].trim(); return kv.split('=')[0].replace('techaro.lol-anubis-', '') + (kv.split('=')[1] ? '' : '(пусто)'); }).join('|') : 'не виден') +
        ', ручной Cookie: ' + (ao.headers.Cookie ? ao.headers.Cookie.split('; ').map(function (p) { return p.split('=')[0].replace('techaro.lol-anubis-', ''); }).join('|') : 'нет'));
      if (!ch) return { status: r.status, text: text };
      _retried = _retried || 0;
      if (_retried >= 2 || (_retried === 1 && ANUBIS_MANUAL)) {
        throw new Error('anubis: проверка не пройдена (cookie не сохранилась?)');
      }
      if (_retried === 1) {
        // хранилище телефона cookie не подхватило — пробуем подставлять их вручную
        ANUBIS_MANUAL = true;
        try { log('anubis: включаю ручные cookie'); } catch (e) {}
      }
      if (ch.algorithm !== 'fast' && ch.algorithm !== 'slow') {
        throw new Error('anubis: неизвестный алгоритм ' + ch.algorithm);
      }
      var sol = anubisSolve(ch.randomData, ch.difficulty);
      log('anubis: сложность ' + ch.difficulty + ', nonce ' + sol.nonce + ', ' + sol.elapsed + 'мс');
      var origin = url.match(/^https?:\/\/[^\/]+/)[0];
      var redir = url.slice(origin.length) || '/';
      var passUrl = origin + ch.basePrefix + '/.within.website/x/cmd/anubis/api/pass-challenge' +
        '?id=' + encodeURIComponent(ch.id) +
        '&response=' + sol.hash +
        '&nonce=' + sol.nonce +
        '&redir=' + encodeURIComponent(redir) +
        '&elapsedTime=' + sol.elapsed;
      var passHeaders = {};
      var src = (opts && opts.headers) || {};
      if (src['User-Agent']) passHeaders['User-Agent'] = src['User-Agent'];
      passHeaders['Referer'] = url;
      passHeaders['Accept'] = 'text/html,*/*';
      // Обязательно: вместе с задачей сервер ставит cookie
      // "techaro.lol-anubis-cookie-verification-…", без неё pass-challenge отвечает 500.
      // anubisOpts() подставит её из ANUBIS_COOKIES (её же хранит cookie-jar React Native).
      // redirect: 'manual' — чтобы увидеть Set-Cookie из 302, где это поддерживается;
      // если fetch всё равно идёт по редиректу, cookie сохранит нативный cookie-jar.
      return fetch(passUrl, anubisOpts({ headers: passHeaders, redirect: 'manual' })).then(function (pr) {
        var psc = null;
        try { psc = pr.headers && pr.headers.get && pr.headers.get('set-cookie'); } catch (e) { psc = 'ERR'; }
        log('pass-challenge → ' + pr.status + ' url=' + String(pr.url || '').replace(/^https?:\/\/[^\/]+/, '').slice(0, 40) + ', set-cookie: ' + (psc ? 'виден' : 'не виден'));
        anubisRememberCookies(pr);
        return pr.text();
      }).then(function () {
        return anubisFetchText(url, opts, _retried + 1); // повторяем исходный запрос уже с cookie
      });
    });
  });
}
// ===== конец блока Anubis =====

// ---------- сеть (все запросы к сайту идут через Anubis-обёртку) ----------
function siteText(url, opts) {
  return anubisFetchText(url, opts).then(function (r) {
    if (r.status >= 400) throw new Error('HTTP ' + r.status + ' для ' + url);
    return r.text;
  });
}

function siteJson(url, opts) {
  return siteText(url, opts).then(function (t) {
    try { return JSON.parse(t); } catch (e) { throw new Error('ответ не JSON: ' + t.slice(0, 80)); }
  });
}

var RESOLVED_BASE = null;

function resolveBase() {
  if (RESOLVED_BASE) return Promise.resolve(RESOLVED_BASE);
  var idx = 0;
  function tryNext() {
    if (idx >= DOMAINS.length) return Promise.reject(new Error('ни одно зеркало HDRezka не ответило'));
    var d = DOMAINS[idx++];
    return anubisFetchText(d + '/', { headers: pageHeaders(d) }).then(function (r) {
      if (r.status >= 400) throw new Error('HTTP ' + r.status);
      if (r.text.indexOf('b-content__inline_item') === -1 && r.text.indexOf('hdrezka') === -1) {
        throw new Error('не похоже на HDRezka');
      }
      RESOLVED_BASE = d;
      log('Зеркало: ' + d);
      return d;
    }).catch(function (e) {
      log(d + ' недоступен: ' + e.message);
      return tryNext();
    });
  }
  return tryNext();
}

// ---------- base64 (без atob/btoa, чтобы работало в любом RN-движке) ----------
var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64encodeAscii(str) {
  var out = '', i = 0;
  while (i < str.length) {
    var c1 = str.charCodeAt(i++);
    var c2 = i < str.length ? str.charCodeAt(i++) : NaN;
    var c3 = i < str.length ? str.charCodeAt(i++) : NaN;
    out += B64.charAt(c1 >> 2) + B64.charAt(((c1 & 3) << 4) | ((c2 | 0) >> 4)) +
      (isNaN(c2) ? '=' : B64.charAt((((c2 | 0) & 15) << 2) | ((c3 | 0) >> 6))) +
      (isNaN(c3) ? '=' : B64.charAt((c3 | 0) & 63));
  }
  return out;
}

function b64decodeUtf8(s) {
  s = String(s).replace(/[^A-Za-z0-9+/]/g, '');
  var bytes = [], buf = 0, bits = 0;
  for (var i = 0; i < s.length; i++) {
    buf = ((buf << 6) | B64.indexOf(s.charAt(i))) & 0xFFFFFF;
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((buf >> bits) & 0xFF); }
  }
  var out = '', j = 0;
  while (j < bytes.length) {
    var b = bytes[j++];
    if (b < 0x80) out += String.fromCharCode(b);
    else if (b >= 0xC0 && b < 0xE0) out += String.fromCharCode(((b & 0x1F) << 6) | (bytes[j++] & 0x3F));
    else if (b >= 0xE0 && b < 0xF0) out += String.fromCharCode(((b & 0x0F) << 12) | ((bytes[j++] & 0x3F) << 6) | (bytes[j++] & 0x3F));
    else { j += 3; }
  }
  return out;
}

// ---------- расшифровка "#h..." (сейчас сайт отдаёт ссылки открыто, но может вернуться) ----------
var TRASH_CODES = null;

function getTrashCodes() {
  if (TRASH_CODES) return TRASH_CODES;
  var chars = ['@', '#', '!', '^', '$'], codes = [], a, b, c;
  for (a = 0; a < chars.length; a++)
    for (b = 0; b < chars.length; b++) {
      codes.push(b64encodeAscii(chars[a] + chars[b]));
      for (c = 0; c < chars.length; c++) codes.push(b64encodeAscii(chars[a] + chars[b] + chars[c]));
    }
  TRASH_CODES = codes;
  return codes;
}

function decodeStreamString(data) {
  if (!data || typeof data !== 'string') return '';
  if (data.indexOf('#h') !== 0) return data;
  var s = data.slice(2).split('//_//').join('');
  var codes = getTrashCodes();
  for (var i = 0; i < codes.length; i++) s = s.split(codes[i]).join('');
  return b64decodeUtf8(s);
}

// "[720p]https://a/x.mp4:hls:manifest.m3u8 or https://b/x.mp4,[<span class="pjs-prem-quality">1080p Ultra…</span>]…"
function parseQualities(decoded) {
  var result = [];
  var re = /\[((?:[^\[\]]|<[^>]*>)+)\]([^\[]*)/g, m;
  while ((m = re.exec(decoded)) !== null) {
    var rawLabel = m[1];
    if (/pjs-prem-quality/.test(rawLabel)) continue; // премиум: без аккаунта — заглушка
    var label = rawLabel.replace(/<[^>]+>/g, '').trim();
    if (/ultra|2k|4k/i.test(label)) continue;
    var links = m[2].replace(/,\s*$/, '').split(/\s+or\s+/);
    var mp4 = null, hls = null;
    for (var k = 0; k < links.length; k++) {
      var l = links[k].trim().replace(/,$/, '');
      if (!/^https?:\/\//.test(l)) continue;
      if (/:hls:manifest\.m3u8$/.test(l)) {
        if (!hls) hls = l;
        if (!mp4) mp4 = l.replace(/:hls:manifest\.m3u8$/, '');
      } else if (/\.mp4$/.test(l)) {
        if (!mp4) mp4 = l;
      } else if (!hls && /\.m3u8/.test(l)) {
        hls = l;
      }
    }
    var url = USE_MP4 ? (mp4 || hls) : (hls || mp4);
    if (!url || url === 'null') continue;
    var h = parseInt(label, 10);
    result.push({ label: label, height: isNaN(h) ? 0 : h, url: url });
  }
  return result;
}

// "[Русский]https://…/ru.vtt,[English]https://…/en.vtt"
function parseSubtitles(str) {
  var out = [];
  if (!str || typeof str !== 'string') return out;
  var re = /\[([^\]]+)\](https?:\/\/[^,\[\s]+)/g, m;
  while ((m = re.exec(str)) !== null) out.push({ url: m[2], lang: m[1], label: m[1] });
  return out;
}

// ---------- TMDB ----------
function getTmdbInfo(tmdbId, mediaType) {
  var type = mediaType === 'tv' ? 'tv' : 'movie';
  var base = 'https://api.themoviedb.org/3/' + type + '/' + tmdbId + '?api_key=' + TMDB_API_KEY;
  return Promise.all([
    fetch(base + '&language=ru-RU').then(function (r) { return r.json(); }),
    fetch(base + '&language=en-US').then(function (r) { return r.json(); }).catch(function () { return {}; })
  ]).then(function (res) {
    var ru = res[0] || {}, en = res[1] || {};
    var date = type === 'tv' ? ru.first_air_date : ru.release_date;
    var titles = [
      type === 'tv' ? ru.name : ru.title,
      type === 'tv' ? ru.original_name : ru.original_title,
      type === 'tv' ? en.name : en.title
    ].filter(function (t, i, arr) { return t && arr.indexOf(t) === i; });
    return { titles: titles, year: date ? parseInt(date.slice(0, 4), 10) : null };
  });
}

// ---------- поиск ----------
function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/&/g, 'and').replace(/[^a-zа-я0-9]+/g, '');
}

function yearFrom(text, url) {
  var m = String(text || '').match(/\b(19\d{2}|20\d{2})\b/);
  if (m) return parseInt(m[1], 10);
  m = String(url || '').match(/-(19\d{2}|20\d{2})(?:-latest)?\.html/);
  return m ? parseInt(m[1], 10) : null;
}

// тип по ссылке и подписи: 'tv' | 'movie' | null (мультфильмы, аниме — бывают и тем и другим)
function kindOf(url, info) {
  if (/\/series\//.test(url)) return 'tv';
  if (/\/films\//.test(url)) return 'movie';
  if (/сериал|\d{4}\s*-\s*(\d{4}|\.\.\.)/i.test(info || '')) return 'tv';
  return null;
}

// живой поиск: <li><a href="…"><span class="enty">Название</span> (Original, сериал, 2008-2013)<span class="rating">…</span></a></li>
function searchAjax(base, query) {
  return siteText(base + '/engine/ajax/search.php', {
    method: 'POST', headers: ajaxHeaders(base), body: formBody({ q: query })
  }).then(function (html) {
    var out = [], re = /<a\s+href="([^"]+)"[^>]*>\s*<span class="enty">([\s\S]*?)<\/span>([\s\S]*?)<\/a>/g, m;
    while ((m = re.exec(html)) !== null) {
      var rest = stripTags(m[3].replace(/<span class="rating">[\s\S]*?<\/span>/g, ''));
      var inner = rest.replace(/^\(|\)$/g, '');
      var parts = inner.split(',').map(function (p) { return p.trim(); });
      var alt = parts.length > 1 && !/^\d{4}/.test(parts[0]) ? parts[0] : '';
      out.push({ url: m[1], title: stripTags(m[2]), alt: alt, year: yearFrom(inner, m[1]), kind: kindOf(m[1], inner) });
    }
    return out;
  }).catch(function (e) { log('живой поиск "' + query + '": ' + e.message); return []; });
}

// страница поиска: <div class="b-content__inline_item-link"><a href="…">Название</a><div>2008-2013, США, Триллеры</div></div>
function searchPage(base, query) {
  var url = base + '/search/?do=search&subaction=search&q=' + encodeURIComponent(query);
  return siteText(url, { headers: pageHeaders(base) }).then(function (html) {
    var out = [], re = /<div class="b-content__inline_item-link">\s*<a href="([^"]+)">([\s\S]*?)<\/a>\s*<div>([\s\S]*?)<\/div>/g, m;
    while ((m = re.exec(html)) !== null) {
      var meta = stripTags(m[3]);
      out.push({ url: m[1], title: stripTags(m[2]), alt: '', year: yearFrom(meta, m[1]), kind: kindOf(m[1], meta) });
    }
    return out;
  }).catch(function (e) { log('страница поиска "' + query + '": ' + e.message); return []; });
}

function scoreCandidates(cands, info, mediaType) {
  var wanted = info.titles.map(norm);
  var scored = [];
  cands.forEach(function (c) {
    if (c.kind && c.kind !== mediaType) return;
    var score = 0;
    var t = norm(c.title), a = norm(c.alt);
    if (wanted.indexOf(t) !== -1 || (a && wanted.indexOf(a) !== -1)) score += 4;
    else if (wanted.some(function (w) { return w && (t.indexOf(w) === 0 || (a && a.indexOf(w) === 0)); })) score += 1;
    if (info.year && c.year) {
      var d = Math.abs(c.year - info.year);
      if (d === 0) score += 3; else if (d === 1) score += 1; else return; // год сильно расходится — отбрасываем
    }
    if (c.kind === mediaType) score += 1;
    if (score >= 4) scored.push({ c: c, score: score });
  });
  scored.sort(function (x, y) { return y.score - x.score; });
  return scored.map(function (s) { return s.c; });
}

function findCandidates(base, info, mediaType) {
  var all = [], seen = {};
  function add(list) {
    list.forEach(function (c) { if (!seen[c.url]) { seen[c.url] = 1; all.push(c); } });
  }
  var queries = info.titles.slice(0, 3), i = 0;
  function next() {
    if (i >= queries.length) {
      // последний шанс — полноценная страница поиска по русскому названию
      return searchPage(base, queries[0] || '').then(function (list) {
        add(list);
        return scoreCandidates(all, info, mediaType);
      });
    }
    var q = queries[i++];
    return searchAjax(base, q).then(function (list) {
      add(list);
      var ranked = scoreCandidates(all, info, mediaType);
      return ranked.length ? ranked : next();
    });
  }
  return next();
}

// ---------- страница фильма/сериала ----------
function attr(tag, name) {
  var m = tag.match(new RegExp('\\s' + name + '="([^"]*)"'));
  return m ? m[1] : null;
}

function parseItemPage(html) {
  var init = html.match(/initCDN(Movies|Series)Events\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+|false|true)/);
  var idMatch = html.match(/data-post_id="(\d+)"/) || html.match(/name="post_id"[^>]*value="(\d+)"/);
  var page = {
    id: init ? init[2] : (idMatch ? idMatch[1] : null),
    isSeries: init ? init[1] === 'Series' : /initCDNSeriesEvents|simple-episodes-tabs/.test(html),
    defaultTranslator: init ? init[3] : null,
    defaultCamrip: init && init[1] === 'Movies' ? init[4] : '0',
    defaultAds: init && init[1] === 'Movies' ? init[5] : '0',
    defaultDirector: init && init[1] === 'Movies' ? (init[6] === 'true' || init[6] === '1' ? '1' : '0') : '0',
    favs: (html.match(/id="ctrl_favs"[^>]*value="([^"]+)"/) || [])[1] || null,
    token: (html.match(/id="ctrl_token_id"[^>]*value="([^"]+)"/) || [])[1] || null,
    translators: []
  };
  var re = /<(li|a)\b([^>]*class="[^"]*b-translator__item[^"]*"[^>]*)>([\s\S]*?)<\/\1>/g, m;
  while ((m = re.exec(html)) !== null) {
    var tag = m[2];
    var id = attr(tag, 'data-translator_id');
    if (!id) continue;
    // список озвучек бывает в разметке дважды — берём каждую один раз
    if (page.translators.some(function (t) { return t.id === id && t.director === (attr(tag, 'data-director') || '0'); })) continue;
    var flag = (m[3].match(/<img[^>]*title="([^"]+)"/) || [])[1];
    var name = (attr(tag, 'title') || stripTags(m[3])).trim();
    if (flag && name.indexOf(flag) === -1) name += ' (' + flag + ')';
    page.translators.push({
      id: id, name: name, flag: flag || '',
      camrip: attr(tag, 'data-camrip') || '0',
      ads: attr(tag, 'data-ads') || '0',
      director: attr(tag, 'data-director') || '0',
      active: /\bactive\b/.test(attr(tag, 'class') || '')
    });
  }
  if (!page.translators.length && page.defaultTranslator) {
    page.translators.push({
      id: page.defaultTranslator, name: 'Озвучка по умолчанию', flag: '',
      camrip: page.defaultCamrip, ads: page.defaultAds, director: page.defaultDirector, active: true
    });
  }
  return page;
}

function isOriginal(t) { return t.id === '238' || /оригинал/i.test(t.name); }
function isUkrainian(t) { return /украин/i.test(t.name) || /украин/i.test(t.flag); }

function chooseTranslators(page) {
  var list = page.translators.filter(function (t) { return !(SKIP_UKRAINIAN && isUkrainian(t)); });
  var chosen = [];
  function push(t) {
    if (t && !isOriginal(t) && chosen.indexOf(t) === -1 && chosen.length < MAX_TRANSLATORS) chosen.push(t);
  }
  list.forEach(function (t) { if (t.id === page.defaultTranslator || t.active) push(t); });
  TRANSLATOR_PRIORITY.forEach(function (p) {
    list.forEach(function (t) { if (t.name.toLowerCase().indexOf(p) !== -1) push(t); });
  });
  list.forEach(push);
  if (INCLUDE_ORIGINAL) {
    var orig = list.filter(isOriginal)[0];
    if (orig) chosen.push(orig);
  }
  return chosen;
}

function randomFavs() {
  var hex = '0123456789abcdef', s = '';
  for (var i = 0; i < 32; i++) s += hex.charAt(Math.floor(Math.random() * 16));
  return s.slice(0, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16) + '-' + s.slice(16, 20) + '-' + s.slice(20);
}

function getTranslatorStreams(base, page, tr, season, episode) {
  var body = page.isSeries
    ? { id: page.id, translator_id: tr.id, season: season, episode: episode, favs: page.favs || randomFavs(), action: 'get_stream' }
    : { id: page.id, translator_id: tr.id, is_camrip: tr.camrip, is_ads: tr.ads, is_director: tr.director, favs: page.favs || randomFavs(), action: 'get_movie' };
  if (page.token) body.token_id = page.token; // без него сайт отдаёт заглушку вместо видео
  return siteJson(base + '/ajax/get_cdn_series/?t=' + Date.now(), {
    method: 'POST', headers: ajaxHeaders(base), body: formBody(body)
  }).then(function (json) {
    if (!json.success || !json.url) {
      log(tr.name + ': ' + (json.message || 'нет ссылок'));
      return [];
    }
    if (String(json.premium_content) === '1') {
      log(tr.name + ': сайт отдал заглушку (premium_content=1)' + (page.token ? '' : ', на странице не было token_id'));
      return [];
    }
    var subs = parseSubtitles(json.subtitle);
    var label = tr.name + (subs.length && !isOriginal(tr) ? ' (+субтитры)' : '');
    return parseQualities(decodeStreamString(json.url)).map(function (q) {
      var s = {
        name: 'HDRezka ' + (q.height ? q.height + 'p' : q.label),
        title: label + (page.isSeries ? ' · S' + season + 'E' + episode : '') + ' · ' + q.label,
        url: q.url,
        quality: q.height ? q.height + 'p' : q.label,
        height: q.height,
        type: 'direct',
        provider: 'hdrezka',
        headers: { 'User-Agent': UA, 'Referer': base + '/' }
      };
      if (subs.length) s.subtitles = subs;
      return s;
    });
  }).catch(function (e) {
    log(tr.name + ': ' + e.message);
    return [];
  });
}

// загрузить страницы кандидатов по очереди, пока не найдётся подходящая (с нужным типом)
function openItem(base, cands, mediaType) {
  var i = 0;
  function next() {
    if (i >= cands.length || i >= 4) return Promise.reject(new Error('не найдено на сайте'));
    var c = cands[i++];
    log('Кандидат: ' + c.title + (c.alt ? ' / ' + c.alt : '') + ' (' + c.year + ') ' + c.url);
    return siteText(c.url, { headers: pageHeaders(base) }).then(function (html) {
      if (isPremiumWall(html)) {
        // сайт перенаправил на /premium/ — дальше все страницы будут такими же
        throw new Error('сайт вместо страницы показал «HDrezka Premium» (так бывает при входе в аккаунт без премиума)');
      }
      var page = parseItemPage(html);
      if (!page.id) { log('нет id на странице'); return next(); }
      if (page.isSeries !== (mediaType === 'tv')) { log('не тот тип (' + (page.isSeries ? 'сериал' : 'фильм') + ')'); return next(); }
      page.url = c.url;
      return page;
    }, function (e) { log(e.message); return next(); });
  }
  return next();
}

function isPremiumWall(html) {
  return /<title>\s*HDrezka Premium/i.test(html) && html.indexOf('initCDN') === -1;
}

// ---------- точка входа ----------
function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  LOGS = [];
  T0 = Date.now();
  log('старт ' + mediaType + ' ' + tmdbId + ' S' + seasonNum + 'E' + episodeNum);
  mediaType = mediaType === 'tv' ? 'tv' : 'movie';
  var season = seasonNum || 1, episode = episodeNum || 1;
  var base, info;
  return resolveBase().then(function (b) {
    base = b;
    return getTmdbInfo(tmdbId, mediaType);
  }).then(function (i) {
    info = i;
    log('TMDB: ' + info.titles.join(' / ') + ' (' + info.year + ')' + (mediaType === 'tv' ? ' S' + season + 'E' + episode : ''));
    if (!info.titles.length) throw new Error('TMDB не вернул название');
    return findCandidates(base, info, mediaType);
  }).then(function (cands) {
    return openItem(base, cands, mediaType);
  }).then(function (page) {
    var trs = chooseTranslators(page);
    log('Озвучки: ' + trs.map(function (t) { return t.name + '#' + t.id; }).join(', ') + (page.token ? '' : ' (без token_id)'));
    return mapLimit(trs, CONCURRENCY, function (t) {
      return getTranslatorStreams(base, page, t, season, episode);
    });
  }).then(function (groups) {
    var streams = [], seenUrl = {};
    groups.forEach(function (g) {
      (g || []).sort(function (a, b) { return b.height - a.height; });
      (g || []).forEach(function (s) {
        var key = s.url.replace(/^https?:\/\/[^\/]+\/[^\/]+\//, ''); // без хоста и токена
        if (seenUrl[key]) return;
        seenUrl[key] = 1;
        streams.push(s);
      });
    });
    streams.forEach(function (s) { delete s.height; });
    log('Стримов: ' + streams.length);
    return streams.concat(debugStreams());
  }).catch(function (e) {
    log('Ошибка: ' + e.message);
    return debugStreams();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreams };
} else {
  global.getStreams = getStreams;
}
