// HDRezka scraper for Nuvio
// - домен rezka.ag (+ запасные зеркала)
// - поиск по русскому и оригинальному названию из TMDB
// - расшифровка ссылок формата "#h..." (trash-base64)
// - русская озвучка по умолчанию + "Оригинал + субтитры", если есть
// Только Promise-цепочки, без async/await (требование Nuvio).

var TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
var DOMAINS = ['https://rezka.ag', 'https://hdrezka.ag', 'https://hdrezka.me'];
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
var MAX_TRANSLATORS = 3;

function log(msg) {
  try { console.log('[HDRezka] ' + msg); } catch (e) {}
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
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(obj[k])));
  }
  return parts.join('&');
}

// ---------- base64 (без atob/btoa, чтобы работало в любом RN-движке) ----------
var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64encodeAscii(str) {
  var out = '', i = 0;
  while (i < str.length) {
    var c1 = str.charCodeAt(i++);
    var c2 = i < str.length ? str.charCodeAt(i++) : NaN;
    var c3 = i < str.length ? str.charCodeAt(i++) : NaN;
    var e1 = c1 >> 2;
    var e2 = ((c1 & 3) << 4) | ((c2 | 0) >> 4);
    var e3 = (((c2 | 0) & 15) << 2) | ((c3 | 0) >> 6);
    var e4 = (c3 | 0) & 63;
    out += B64.charAt(e1) + B64.charAt(e2) +
      (isNaN(c2) ? '=' : B64.charAt(e3)) +
      (isNaN(c3) ? '=' : B64.charAt(e4));
  }
  return out;
}

function b64decodeUtf8(s) {
  s = String(s).replace(/[^A-Za-z0-9+/]/g, '');
  var bytes = [], buf = 0, bits = 0;
  for (var i = 0; i < s.length; i++) {
    buf = ((buf << 6) | B64.indexOf(s.charAt(i))) & 0xFFFFFF;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buf >> bits) & 0xFF);
    }
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

// ---------- расшифровка "#h..." ----------
var TRASH_CODES = null;

function getTrashCodes() {
  if (TRASH_CODES) return TRASH_CODES;
  var chars = ['@', '#', '!', '^', '$'];
  var codes = [], a, b, c;
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
  if (data.indexOf('#h') !== 0) return data; // уже в открытом виде
  var s = data.slice(2).split('//_//').join('');
  var codes = getTrashCodes();
  for (var i = 0; i < codes.length; i++) s = s.split(codes[i]).join('');
  return b64decodeUtf8(s);
}

// "[720p]https://a/720.mp4:hls:manifest.m3u8 or https://b/720.mp4,[1080p Ultra]..."
function parseQualities(decoded) {
  var result = [];
  var re = /\[([^\]]+)\]([^\[]*)/g, m;
  while ((m = re.exec(decoded)) !== null) {
    var label = m[1].replace(/<[^>]+>/g, '').trim();
    var links = m[2].replace(/,\s*$/, '').split(/\s+or\s+/);
    var url = null, k;
    for (k = 0; k < links.length; k++) {
      var l = links[k].trim().replace(/,$/, '');
      if (!/^https?:\/\//.test(l)) continue;
      var mp4 = l.replace(/:hls:manifest\.m3u8$/, '');
      if (/\.mp4$/.test(mp4)) { url = mp4; break; }
      if (!url) url = l;
    }
    if (!url || url === 'null') continue;
    if (/ultra/i.test(label)) continue; // премиум-качество: без аккаунта отдаётся заглушка
    var h = parseInt(label, 10);
    result.push({ label: label, height: isNaN(h) ? 0 : h, url: url });
  }
  return result;
}

// ---------- сеть ----------
function fetchText(url, opts) {
  return fetch(url, opts).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
    return r.text();
  });
}

var RESOLVED_BASE = null;

function resolveBase() {
  if (RESOLVED_BASE) return Promise.resolve(RESOLVED_BASE);
  var idx = 0;
  function tryNext() {
    if (idx >= DOMAINS.length) return Promise.reject(new Error('Ни одно зеркало HDRezka не ответило'));
    var d = DOMAINS[idx++];
    return fetch(d + '/', { headers: pageHeaders(d) }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var finalUrl = r.url || d;
      var m = finalUrl.match(/^(https?:\/\/[^\/]+)/);
      RESOLVED_BASE = m ? m[1] : d;
      log('Зеркало: ' + RESOLVED_BASE);
      return RESOLVED_BASE;
    }).catch(function (e) {
      log(d + ' недоступен: ' + e.message);
      return tryNext();
    });
  }
  return tryNext();
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
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#039;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, '');
}

function yearFrom(text, url) {
  var m = String(text || '').match(/\b(19\d{2}|20\d{2})\b/);
  if (m) return parseInt(m[1], 10);
  m = String(url || '').match(/-(19\d{2}|20\d{2})(?:-latest)?\.html/);
  return m ? parseInt(m[1], 10) : null;
}

function searchAjax(base, query) {
  return fetchText(base + '/engine/ajax/search.php', {
    method: 'POST', headers: ajaxHeaders(base), body: formBody({ q: query })
  }).then(function (html) {
    var out = [], re = /<a\s+href="([^"]+)"[^>]*>\s*<span class="enty">([\s\S]*?)<\/span>([\s\S]*?)<\/a>/g, m;
    while ((m = re.exec(html)) !== null) {
      var rest = stripTags(m[3].replace(/<span class="rating">[\s\S]*?<\/span>/g, ''));
      var alt = rest.replace(/^\(|\)$/g, '').split(',')[0];
      out.push({ url: m[1], title: stripTags(m[2]), alt: alt, year: yearFrom(rest, m[1]) });
    }
    return out;
  }).catch(function (e) { log('ajax-поиск: ' + e.message); return []; });
}

function searchPage(base, query) {
  var url = base + '/search/?do=search&subaction=search&q=' + encodeURIComponent(query);
  return fetchText(url, { headers: pageHeaders(base) }).then(function (html) {
    var out = [], re = /<div class="b-content__inline_item-link">\s*<a href="([^"]+)">([\s\S]*?)<\/a>\s*<div>([\s\S]*?)<\/div>/g, m;
    while ((m = re.exec(html)) !== null) {
      out.push({ url: m[1], title: stripTags(m[2]), alt: '', year: yearFrom(m[3], m[1]) });
    }
    return out;
  }).catch(function (e) { log('поиск-страница: ' + e.message); return []; });
}

function typeOk(url, mediaType) {
  if (mediaType === 'tv') return !/\/films\//.test(url);
  return !/\/series\//.test(url);
}

function pickBest(cands, info, mediaType) {
  var wanted = info.titles.map(norm);
  var best = null, bestScore = -1;
  cands.forEach(function (c) {
    if (!typeOk(c.url, mediaType)) return;
    var score = 0;
    var titleHit = wanted.indexOf(norm(c.title)) !== -1 || (c.alt && wanted.indexOf(norm(c.alt)) !== -1);
    if (titleHit) score += 2;
    if (info.year && c.year) {
      var d = Math.abs(c.year - info.year);
      if (d === 0) score += 3; else if (d === 1) score += 1; else return; // год сильно расходится — отбрасываем
    }
    if (score > bestScore) { bestScore = score; best = c; }
  });
  return bestScore >= 2 ? best : null;
}

function findItem(base, info, mediaType) {
  var all = [], seen = {};
  function add(list) {
    list.forEach(function (c) { if (!seen[c.url]) { seen[c.url] = 1; all.push(c); } });
  }
  var queries = info.titles.slice(0, 3);
  var i = 0;
  function next() {
    if (i >= queries.length) {
      // последний шанс — полноценная страница поиска по русскому названию
      return searchPage(base, queries[0] || '').then(function (list) {
        add(list);
        return pickBest(all, info, mediaType);
      });
    }
    var q = queries[i++];
    return searchAjax(base, q).then(function (list) {
      add(list);
      var hit = pickBest(all, info, mediaType);
      return hit || next();
    });
  }
  return next();
}

// ---------- страница фильма/сериала ----------
function attr(tag, name) {
  var m = tag.match(new RegExp(name + '="([^"]*)"'));
  return m ? m[1] : null;
}

function parseItemPage(html) {
  var init = html.match(/initCDN(Movies|Series)Events\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+|false|true)/);
  var idMatch = html.match(/data-post_id="(\d+)"/) || html.match(/name="post_id"[^>]*value="(\d+)"/);
  var favs = (html.match(/id="ctrl_favs"[^>]*value="([^"]+)"/) || [])[1];
  var page = {
    id: init ? init[2] : (idMatch ? idMatch[1] : null),
    isSeries: init ? init[1] === 'Series' : /initCDNSeriesEvents/.test(html),
    defaultTranslator: init ? init[3] : null,
    defaultCamrip: init && init[1] === 'Movies' ? init[4] : '0',
    defaultAds: init && init[1] === 'Movies' ? init[5] : '0',
    defaultDirector: init && init[1] === 'Movies' ? (init[6] === 'true' || init[6] === '1' ? '1' : '0') : '0',
    favs: favs || null,
    translators: []
  };
  var re = /<(li|a)\b([^>]*class="[^"]*b-translator__item[^"]*"[^>]*)>([\s\S]*?)<\/\1>/g, m;
  while ((m = re.exec(html)) !== null) {
    var tag = m[2];
    var id = attr(tag, 'data-translator_id');
    if (!id) continue;
    var flag = (m[3].match(/<img[^>]*title="([^"]+)"/) || [])[1];
    var name = attr(tag, 'title') || stripTags(m[3]);
    if (flag && name.indexOf(flag) === -1) name += ' (' + flag + ')';
    page.translators.push({
      id: id, name: name,
      camrip: attr(tag, 'data-camrip') || '0',
      ads: attr(tag, 'data-ads') || '0',
      director: attr(tag, 'data-director') || '0',
      active: /\bactive\b/.test(attr(tag, 'class') || '')
    });
  }
  if (!page.translators.length && page.defaultTranslator) {
    page.translators.push({
      id: page.defaultTranslator, name: 'Озвучка по умолчанию',
      camrip: page.defaultCamrip, ads: page.defaultAds, director: page.defaultDirector, active: true
    });
  }
  return page;
}

function chooseTranslators(page) {
  var list = page.translators, chosen = [];
  function push(t) { if (t && chosen.indexOf(t) === -1 && chosen.length < MAX_TRANSLATORS) chosen.push(t); }
  var def = null, i;
  for (i = 0; i < list.length; i++) if (list[i].id === page.defaultTranslator || list[i].active) { def = list[i]; break; }
  push(def || list[0]);
  for (i = 0; i < list.length; i++) if (/дубляж/i.test(list[i].name) && !/украин/i.test(list[i].name)) { push(list[i]); break; }
  for (i = 0; i < list.length; i++) if (list[i].id === '238' || /оригинал/i.test(list[i].name)) { push(list[i]); break; }
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
  return fetchText(base + '/ajax/get_cdn_series/?t=' + Date.now(), {
    method: 'POST', headers: ajaxHeaders(base), body: formBody(body)
  }).then(function (txt) {
    var json;
    try { json = JSON.parse(txt); } catch (e) { throw new Error('ответ не JSON'); }
    if (!json.success || !json.url) {
      log(tr.name + ': ' + (json.message || 'нет ссылок'));
      return [];
    }
    return parseQualities(decodeStreamString(json.url)).map(function (q) {
      return {
        name: 'HDRezka',
        title: tr.name + ' · ' + q.label,
        url: q.url,
        quality: q.height ? q.height + 'p' : q.label,
        height: q.height,
        type: 'direct',
        provider: 'hdrezka',
        headers: { 'User-Agent': UA, 'Referer': base + '/' }
      };
    });
  }).catch(function (e) {
    log(tr.name + ': ' + e.message);
    return [];
  });
}

// ---------- точка входа ----------
function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  mediaType = mediaType === 'tv' ? 'tv' : 'movie';
  var base, info;
  return resolveBase().then(function (b) {
    base = b;
    return getTmdbInfo(tmdbId, mediaType);
  }).then(function (i) {
    info = i;
    log('TMDB: ' + info.titles.join(' / ') + ' (' + info.year + ')');
    if (!info.titles.length) throw new Error('TMDB не вернул название');
    return findItem(base, info, mediaType);
  }).then(function (item) {
    if (!item) throw new Error('не найдено на сайте');
    log('Найдено: ' + item.title + ' ' + item.url);
    return fetchText(item.url, { headers: pageHeaders(base) });
  }).then(function (html) {
    var page = parseItemPage(html);
    if (!page.id) throw new Error('не удалось прочитать id на странице');
    var trs = chooseTranslators(page);
    log('Озвучки: ' + trs.map(function (t) { return t.name + '#' + t.id; }).join(', '));
    return Promise.all(trs.map(function (t) {
      return getTranslatorStreams(base, page, t, seasonNum || 1, episodeNum || 1);
    }));
  }).then(function (groups) {
    var streams = [], seenUrl = {};
    groups.forEach(function (g) {
      g.forEach(function (s) {
        var key = s.url.replace(/^https?:\/\/[^\/]+\/[^\/]+\/?/, ''); // без хоста и токена
        if (seenUrl[key]) return;
        seenUrl[key] = 1;
        streams.push(s);
      });
    });
    streams.sort(function (a, b) { return b.height - a.height; });
    streams.forEach(function (s) { delete s.height; });
    log('Стримов: ' + streams.length);
    return streams;
  }).catch(function (e) {
    log('Ошибка: ' + e.message);
    return [];
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreams };
} else {
  global.getStreams = getStreams;
}
