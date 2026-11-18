// YummyAnime (old.yummyani.me) scraper for Nuvio
// - поиск через API сайта: /api/search, серии: /api/anime/{id}/videos
// - видео: Kodik (все озвучки берутся у самого Kodik) и Aksor (до 1080p, DASH)
// - сезон TMDB сопоставляется с отдельной записью на сайте по году выхода сезона
// Только Promise-цепочки, без async/await (требование Nuvio).

var TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
var SITE = 'https://old.yummyani.me';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
var MAX_DUBS = 40;      // по сути все озвучки серии
var CONCURRENCY = 5;    // сколько запросов к плеерам одновременно
// порядок озвучек в списке: эти идут первыми, остальные — после них (это НЕ фильтр)
var DUB_PRIORITY = ['anilibria', 'anidub', 'studioband', 'dream cast', 'anistar', 'animevost', 'jam', 'shiza', 'crunchyroll', 'субтитры'];

var DEBUG = false; // true — показывать лог строками DEBUG в списке стримов (для поиска ошибок)
var LOGS = [];
function log(msg) {
  LOGS.push(String(msg));
  try { console.log('[YummyAnime] ' + msg); } catch (e) {}
}

function debugStreams() {
  if (!DEBUG) return [];
  return LOGS.map(function (line, i) {
    return {
      name: 'DEBUG ' + (i + 1) + ': ' + line.slice(0, 120),
      title: line,
      url: SITE + '/?debug=' + i,
      quality: line.slice(0, 60),
      provider: 'yummyanime'
    };
  });
}

function formBody(obj) {
  var parts = [];
  for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) {
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(obj[k])));
  }
  return parts.join('&');
}

function fetchJson(url, opts) {
  return fetch(url, opts).then(function (r) {
    return r.text().then(function (t) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url.slice(0, 50) + ' ' + t.replace(/\s+/g, ' ').slice(0, 60));
      try { return JSON.parse(t); } catch (e) { throw new Error('не JSON ' + url.slice(0, 50) + ' ' + t.replace(/\s+/g, ' ').slice(0, 60)); }
    });
  });
}

function fetchText(url, opts) {
  return fetch(url, opts).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
    return r.text();
  });
}

// ---------- base64 без atob ----------
var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64decode(s) {
  s = String(s).replace(/[^A-Za-z0-9+/]/g, '');
  var out = '', buf = 0, bits = 0;
  for (var i = 0; i < s.length; i++) {
    buf = ((buf << 6) | B64.indexOf(s.charAt(i))) & 0xFFFFFF;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buf >> bits) & 0xFF);
    }
  }
  return out;
}

// Kodik: каждая буква сдвинута на +18 по кругу, потом base64
function decodeKodikSrc(src) {
  if (!src || src.indexOf('//') !== -1) return src;
  var shifted = src.replace(/[a-zA-Z]/g, function (ch) {
    var limit = ch <= 'Z' ? 90 : 122;
    var c = ch.charCodeAt(0) + 18;
    return String.fromCharCode(c <= limit ? c : c - 26);
  });
  return b64decode(shifted);
}

// ---------- TMDB ----------
function getTmdbInfo(tmdbId, mediaType, season) {
  var type = mediaType === 'tv' ? 'tv' : 'movie';
  var base = 'https://api.themoviedb.org/3/' + type + '/' + tmdbId + '?api_key=' + TMDB_API_KEY;
  return Promise.all([
    fetchJson(base + '&language=ru-RU'),
    fetchJson(base + '&language=en-US').catch(function () { return {}; })
  ]).then(function (res) {
    var ru = res[0] || {}, en = res[1] || {};
    var date = type === 'tv' ? ru.first_air_date : ru.release_date;
    var titles = [
      type === 'tv' ? ru.name : ru.title,
      type === 'tv' ? en.name : en.title,
      type === 'tv' ? ru.original_name : ru.original_title
    ].filter(function (t, i, arr) { return t && arr.indexOf(t) === i; });
    var info = {
      titles: titles,
      year: date ? parseInt(date.slice(0, 4), 10) : null,
      seasonYear: null,
      seasonEpisodes: null,
      prevEpisodes: 0
    };
    if (type === 'tv' && ru.seasons) {
      ru.seasons.forEach(function (s) {
        if (s.season_number === season) {
          info.seasonYear = s.air_date ? parseInt(s.air_date.slice(0, 4), 10) : null;
          info.seasonEpisodes = s.episode_count;
        } else if (s.season_number > 0 && s.season_number < season) {
          info.prevEpisodes += s.episode_count || 0;
        }
      });
    }
    return info;
  });
}

// ---------- поиск на сайте ----------
function norm(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, '');
}

function siteSearch(query) {
  var url = SITE + '/api/search?q=' + encodeURIComponent(query) + '&limit=20&offset=0';
  return fetchJson(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': SITE + '/' } })
    .then(function (j) { return j.response || []; })
    .catch(function (e) { log('поиск "' + query + '": ' + e.message); return []; });
}

function isMovieType(item) {
  var alias = item.type && item.type.alias;
  return alias === 'movie' || alias === 'film';
}

// Возвращает список кандидатов, отсортированный от лучшего к худшему
function rankCandidates(all, info, mediaType, season) {
  var mainTitle = norm(info.titles[0]);
  var targetYear = mediaType === 'tv' ? (info.seasonYear || info.year) : info.year;
  var scored = [];
  all.forEach(function (it) {
    var alias = it.type && it.type.alias;
    var movie = isMovieType(it);
    if (mediaType === 'movie' && !movie) return;
    if (mediaType === 'tv' && alias !== 'tv' && alias !== 'ona') return; // спешлы, OVA, фильмы — мимо
    var t = norm(it.title);
    var score = 0;
    if (t === mainTitle) score += 4;
    else if (mainTitle && t.indexOf(mainTitle) === 0) score += 2;
    if (targetYear && it.year) {
      var d = Math.abs(it.year - targetYear);
      if (d === 0) score += 4; else if (d === 1) score += 1; else score -= 3;
    }
    // для 2+ сезона на сайте обычно отдельная запись "Название 2" / "... 2 сезон"
    if (mediaType === 'tv' && season > 1 && new RegExp('(^|[^0-9])' + season + '([^0-9]|$)').test(it.title)) score += 2;
    if (mediaType === 'tv' && season === 1 && t === mainTitle) score += 1;
    if (score > 0) scored.push({ item: it, score: score });
  });
  scored.sort(function (a, b) { return b.score - a.score; });
  return scored.map(function (s) { return s.item; });
}

function findCandidates(info, mediaType, season) {
  var all = [], seen = {};
  var queries = info.titles.slice(0, 2);
  return Promise.all(queries.map(siteSearch)).then(function (lists) {
    lists.forEach(function (list) {
      list.forEach(function (it) {
        if (!seen[it.anime_id]) { seen[it.anime_id] = 1; all.push(it); }
      });
    });
    return { all: all, ranked: rankCandidates(all, info, mediaType, season) };
  });
}

// Все ТВ-части той же франшизы по порядку выхода: "Название", "Название 2", "Название: Финал"...
function baseTitle(title) {
  return norm(String(title || '').split(/[:|—–]|\s\d+(\s|$)/)[0]);
}

function franchiseChain(all, item) {
  var base = baseTitle(item.title);
  if (!base) return [item];
  var chain = all.filter(function (it) {
    var alias = it.type && it.type.alias;
    if (alias !== 'tv' && alias !== 'ona') return false;
    return norm(it.title).indexOf(base) === 0;
  });
  if (chain.indexOf(item) === -1) chain.push(item);
  chain.sort(function (a, b) {
    var ya = a.year || 9999, yb = b.year || 9999; // анонсы (год 0) — в конец
    if (ya !== yb) return ya - yb;
    return a.anime_id - b.anime_id;
  });
  return chain;
}

function maxEpisode(videos) {
  var max = 0;
  videos.forEach(function (v) {
    var n = parseInt(v.number, 10);
    if (!isNaN(n) && n > max) max = n;
  });
  return max;
}

// короткометражки (спешлы по 1-5 минут) при переносе серий пропускаем
function isShorts(videos) {
  var d = videos.map(function (v) { return v.duration || 0; }).filter(function (x) { return x > 0; }).slice(0, 10);
  if (!d.length) return false;
  var sum = 0;
  d.forEach(function (x) { sum += x; });
  return sum / d.length < 480;
}

// Ищет серию в записи; если номер больше, чем серий в записи, переходит к следующей части
function walkChain(chain, idx, ep, isNextPart) {
  if (idx < 0 || idx >= chain.length) return Promise.resolve(null);
  var item = chain[idx];
  return getVideos(item.anime_id).then(function (videos) {
    log('videos id=' + item.anime_id + ': ' + videos.length);
    if (isNextPart && isShorts(videos)) return walkChain(chain, idx + 1, ep, true);
    var picked = pickEpisodeVideos(videos, ep);
    var onlySample = picked.length && picked.every(function (v) { return v.sampleOnly; });
    if (onlySample) {
      // список обрезан и серии в нём нет: проверяем по карточке аниме, есть ли такая серия вообще
      return getEpisodeCount(item.anime_id).then(function (cnt) {
        if (cnt && ep > cnt && idx + 1 < chain.length) return walkChain(chain, idx + 1, ep - cnt, true);
        log('Найдено (по образцу Kodik): ' + item.title + ' id=' + item.anime_id + ', серия ' + ep);
        picked.ep = ep;
        return picked;
      });
    }
    if (picked.length) {
      log('Найдено: ' + item.title + ' (' + item.year + ') id=' + item.anime_id + ', серия ' + ep);
      picked.ep = ep; // номер серии внутри найденной записи
      return picked;
    }
    if (idx + 1 >= chain.length) return null;
    return getEpisodeCount(item.anime_id).then(function (cnt) {
      var max = Math.max(maxEpisode(videos), cnt);
      if (max > 0 && ep > max) return walkChain(chain, idx + 1, ep - max, true);
      return null;
    });
  }).catch(function (e) {
    log('videos: ' + e.message);
    return null;
  });
}

// ---------- серии и озвучки ----------
function getVideos(animeId) {
  return fetch(SITE + '/api/anime/' + animeId + '/videos', {
    headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': SITE + '/' }
  }).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.text();
  }).then(function (t) {
    try {
      return JSON.parse(t).response || [];
    } catch (e) {
      // У длинных сериалов (Наруто — 2 МБ) ответ может прийти обрезанным: читаем то, что пришло
      var list = parseVideosLoose(t);
      list.truncated = true;
      log('videos id=' + animeId + ': ответ обрезан (' + t.length + ' байт), прочитано ' + list.length);
      return list;
    }
  });
}

function unesc(s) {
  try { return JSON.parse('"' + s + '"'); } catch (e) { return String(s).replace(/\\\//g, '/'); }
}

function parseVideosLoose(t) {
  var parts = String(t).split('{"video_id":'), out = [];
  for (var i = 1; i < parts.length; i++) {
    var c = parts[i];
    var iframe = (c.match(/"iframe_url":"((?:[^"\\]|\\.)*)"/) || [])[1];
    if (!iframe) continue; // последний, недокачанный кусок
    out.push({
      iframe_url: unesc(iframe),
      number: (c.match(/"number":"([^"]*)"/) || [])[1],
      duration: parseInt((c.match(/"duration":(\d+)/) || [])[1] || '0', 10),
      data: {
        player: unesc((c.match(/"player":"((?:[^"\\]|\\.)*)"/) || [])[1] || ''),
        dubbing: unesc((c.match(/"dubbing":"((?:[^"\\]|\\.)*)"/) || [])[1] || '')
      }
    });
  }
  return out;
}

// Сколько серий в записи по данным сайта (маленький запрос, на случай обрезанного списка видео)
function getEpisodeCount(animeId) {
  return fetchJson(SITE + '/api/anime/' + animeId, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': SITE + '/' }
  }).then(function (j) {
    var e = (j.response && j.response.episodes) || {};
    return Math.max(e.aired || 0, e.count || 0);
  }).catch(function () { return 0; });
}

function isKodik(v) {
  return /kodik/i.test(v.iframe_url || '') || /kodik/i.test((v.data && v.data.player) || '');
}

function dubRank(name) {
  var n = String(name || '').toLowerCase();
  for (var i = 0; i < DUB_PRIORITY.length; i++) if (n.indexOf(DUB_PRIORITY[i]) !== -1) return i;
  return DUB_PRIORITY.length;
}

function isAksor(v) {
  return /aksor\.tv\/video\//i.test(v.iframe_url || '');
}

function pickEpisodeVideos(videos, episodeNum) {
  var ep = String(episodeNum);
  var aksor = videos.filter(function (v) { return isAksor(v) && String(v.number) === ep; });
  var kodik = pickKodikVideos(videos, ep);
  if (!kodik.length) {
    // серии нет среди прочитанного — подойдёт любая ссылка Kodik этой записи,
    // список озвучек и нужную серию дальше возьмём у самого Kodik
    var any = null;
    for (var i = 0; i < videos.length; i++) if (isKodik(videos[i])) { any = videos[i]; break; }
    if (any && videos.truncated) kodik = [{ iframe_url: any.iframe_url, data: any.data, number: any.number, sampleOnly: true }];
  }
  return aksor.concat(kodik);
}

function pickKodikVideos(videos, ep) {
  var list = videos.filter(function (v) { return isKodik(v) && String(v.number) === ep; });
  var byDub = {};
  list.forEach(function (v) {
    var d = (v.data && v.data.dubbing) || 'Kodik';
    if (!byDub[d]) byDub[d] = v;
  });
  var dubs = Object.keys(byDub);
  dubs.sort(function (a, b) {
    var ra = dubRank(a), rb = dubRank(b);
    if (ra !== rb) return ra - rb;
    return (byDub[b].views || 0) - (byDub[a].views || 0);
  });
  return dubs.slice(0, MAX_DUBS).map(function (d) { return byDub[d]; });
}

// ---------- Kodik ----------
function kodikStreams(video) {
  var iframe = video.iframe_url;
  if (iframe.indexOf('//') === 0) iframe = 'https:' + iframe;
  var host = (iframe.match(/^(https?:\/\/[^\/]+)/) || [])[1];
  var dubName = String((video.data && video.data.dubbing) || 'Kodik').replace(/^Озвучка\s+/i, '');
  return fetchText(iframe, {
    headers: { 'User-Agent': UA, 'Referer': SITE + '/', 'Accept': 'text/html,*/*' }
  }).then(function (html) {
    var params = (html.match(/var\s+urlParams\s*=\s*'([^']+)'/) || [])[1];
    var vType = (html.match(/vInfo\.type\s*=\s*'([^']+)'/) || [])[1];
    var vHash = (html.match(/vInfo\.hash\s*=\s*'([^']+)'/) || [])[1];
    var vId = (html.match(/vInfo\.id\s*=\s*'([^']+)'/) || [])[1];
    if (!params || !vType || !vHash || !vId) throw new Error('не удалось разобрать плеер Kodik, len=' + html.length + ' ' + html.replace(/\s+/g, ' ').slice(0, 80));
    var p = JSON.parse(params);
    var ref = p.ref || '';
    try { ref = decodeURIComponent(ref); } catch (e) {} // в urlParams ref уже закодирован; без декодирования Kodik отвечает 500
    var body = {
      d: p.d, d_sign: p.d_sign, pd: p.pd, pd_sign: p.pd_sign, ref: ref, ref_sign: p.ref_sign,
      bad_user: 'false', cdn_is_working: 'true',
      type: vType, hash: vHash, id: vId, info: '{}'
    };
    return fetchJson(host + '/ftor', {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Referer': iframe,
        'Origin': host,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*; q=0.01'
      },
      body: formBody(body)
    });
  }).then(function (j) {
    // Одна ссылка на озвучку — в лучшем качестве (плейлист Kodik сам по себе одного качества)
    var links = j.links || {};
    var best = null, bestH = -1;
    Object.keys(links).forEach(function (q) {
      var arr = links[q] || [];
      var h = parseInt(q, 10);
      if (!arr.length || isNaN(h) || h <= bestH) return;
      var url = decodeKodikSrc(arr[0].src);
      if (!url) return;
      if (url.indexOf('//') === 0) url = 'https:' + url;
      best = url; bestH = h;
    });
    if (!best) { log(dubName + ': links пустые ' + JSON.stringify(j).slice(0, 80)); return []; }
    log(dubName + ': OK ' + bestH + 'p');
    return [{
      name: 'YummyAnime · ' + dubName,
      title: dubName + ' · ' + bestH + 'p',
      url: best,
      quality: bestH + 'p',
      height: bestH,
      provider: 'yummyanime',
      headers: { 'User-Agent': UA, 'Referer': host + '/' }
    }];
  }).catch(function (e) {
    log(dubName + ': ' + e.message);
    return [];
  });
}

// Kodik сам отдаёт все свои озвучки сериала, если открыть плеер с translations=true.
// sample — любая ссылка Kodik этой записи. Возвращает видео-объекты для нужной серии.
function kodikAllDubs(sample, ep, isMovie) {
  var iframe = sample.iframe_url;
  if (iframe.indexOf('//') === 0) iframe = 'https:' + iframe;
  var host = (iframe.match(/^(https?:\/\/[^\/]+)/) || [])[1];
  var url = iframe.split('?')[0] + '?translations=true&only_episode=false&only_season=false' + (isMovie ? '' : '&episode=' + ep);
  return fetchText(url, { headers: { 'User-Agent': UA, 'Referer': SITE + '/', 'Accept': 'text/html,*/*' } }).then(function (html) {
    var out = [], seen = {};
    var re = /<option([^>]*data-media-hash="[^"]+"[^>]*)>([^<]*)</g, m;
    while ((m = re.exec(html)) !== null) {
      var a = m[1];
      var get = function (n) { return (a.match(new RegExp('data-' + n + '="([^"]*)"')) || [])[1] || ''; };
      var mType = get('media-type'), mId = get('media-id'), mHash = get('media-hash');
      if (!mType || !mId || !mHash || seen[mType + mId]) continue;
      seen[mType + mId] = 1;
      if (!isMovie) {
        var cnt = get('episode-count'), lo = 1, hi = 100000, r;
        if ((r = cnt.match(/(\d+)\s*[~\-]\s*(\d+)/))) { lo = +r[1]; hi = +r[2]; }
        else if ((r = cnt.match(/(\d+)/))) { hi = +r[1]; }
        if (ep < lo || ep > hi) continue; // у этой озвучки нет такой серии
      }
      var title = get('title') || m[2].replace(/\(.*$/, '').trim();
      if (get('translation-type') === 'subtitles' && !/субтитр/i.test(title)) title = 'Субтитры ' + title;
      out.push({
        iframe_url: host + '/' + mType + '/' + mId + '/' + mHash + '/720p?translations=false&only_episode=true&only_season=true' + (isMovie ? '' : '&episode=' + ep),
        data: { player: 'Плеер Kodik', dubbing: title }
      });
    }
    out.sort(function (x, y) { return dubRank(x.data.dubbing) - dubRank(y.data.dubbing); });
    log('Kodik: озвучек ' + out.length + ' для серии ' + ep);
    return out.slice(0, MAX_DUBS);
  }).catch(function (e) {
    log('Kodik список озвучек: ' + e.message);
    return [];
  });
}

// ---------- Aksor (до 1080p, формат DASH .mpd) ----------
function aksorStreams(video) {
  var id = (String(video.iframe_url).match(/aksor\.tv\/video\/([a-z0-9]+)/i) || [])[1];
  var dubName = String((video.data && video.data.dubbing) || 'Aksor').replace(/^Озвучка\s+/i, '');
  if (!id) return Promise.resolve([]);
  return fetchJson('https://player.aksor.tv/api/video/' + id, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://player.aksor.tv/video/' + id }
  }).then(function (j) {
    log('Aksor ' + dubName + ': ответ ' + JSON.stringify(j.qualities || j).slice(0, 80));
    var q = j.qualities || {};
    var order = [['q4k', 2160], ['q2k', 1440], ['q1080', 1080], ['q720', 720], ['q480', 480], ['q360', 360]];
    for (var i = 0; i < order.length; i++) {
      var url = q[order[i][0]];
      if (url) {
        return [{
          name: 'YummyAnime · ' + dubName + ' (Aksor)',
          title: dubName + ' · ' + order[i][1] + 'p · Aksor',
          url: url,
          quality: order[i][1] + 'p',
          height: order[i][1],
          provider: 'yummyanime',
          headers: { 'User-Agent': UA, 'Referer': 'https://player.aksor.tv/' }
        }];
      }
    }
    return [];
  }).catch(function (e) {
    log('Aksor ' + dubName + ': ' + e.message);
    return [];
  });
}

// Выполняет fn для каждого элемента, не больше limit одновременно; порядок результатов сохраняется
function mapLimit(items, limit, fn) {
  return new Promise(function (resolve) {
    var results = new Array(items.length), next = 0, done = 0;
    if (!items.length) return resolve(results);
    function run() {
      if (next >= items.length) return;
      var i = next++;
      Promise.resolve().then(function () { return fn(items[i]); }).catch(function () { return []; }).then(function (r) {
        results[i] = r || [];
        done++;
        if (done === items.length) resolve(results); else run();
      });
    }
    for (var k = 0; k < Math.min(limit, items.length); k++) run();
  });
}

// ---------- точка входа ----------
function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  mediaType = mediaType === 'tv' ? 'tv' : 'movie';
  var season = mediaType === 'tv' ? (parseInt(seasonNum, 10) || 1) : 1;
  var episode = mediaType === 'tv' ? (parseInt(episodeNum, 10) || 1) : 1;
  var info;
  LOGS = [];
  log('v1.3.0 tmdb=' + tmdbId + ' ' + mediaType + ' S' + season + 'E' + episode);
  return getTmdbInfo(tmdbId, mediaType, season).then(function (i) {
    info = i;
    log('TMDB: ' + info.titles.join(' / ') + ' (' + info.year + '), сезон ' + season + ' (' + info.seasonYear + ')');
    if (!info.titles.length) throw new Error('TMDB не вернул название');
    return findCandidates(info, mediaType, season);
  }).then(function (res) {
    var cands = res.ranked;
    if (!cands.length) throw new Error('не найдено на сайте');
    // Варианты: лучший кандидат; сквозной номер (если на сайте сезоны слиты); следующие кандидаты.
    var tries = [];
    var mainNorm = norm(info.titles[0]);
    cands.slice(0, 3).forEach(function (c) {
      var absEp = info.prevEpisodes + episode;
      if (mediaType === 'tv' && season > 1 && info.prevEpisodes) {
        // Длинные сериалы (Наруто, Ван-Пис...) на сайте — одна запись со сквозной нумерацией,
        // а в TMDB разбиты на сезоны. Если запись началась раньше этого сезона или это
        // основная запись сериала — сначала пробуем сквозной номер.
        var sameEntry = (c.year && info.seasonYear && c.year < info.seasonYear) || norm(c.title) === mainNorm;
        if (sameEntry) {
          tries.push({ item: c, ep: absEp });
          tries.push({ item: c, ep: episode });
        } else {
          tries.push({ item: c, ep: episode });
          tries.push({ item: c, ep: absEp });
        }
      } else {
        tries.push({ item: c, ep: episode });
      }
    });
    var idx = 0;
    function next() {
      if (idx >= tries.length) return Promise.resolve(null);
      var t = tries[idx++];
      var chain = mediaType === 'tv' ? franchiseChain(res.all, t.item) : [t.item];
      return walkChain(chain, chain.indexOf(t.item), t.ep).then(function (picked) {
        return picked || next();
      });
    }
    return next();
  }).then(function (picked) {
    if (!picked) throw new Error('серия не найдена');
    var aksor = picked.filter(isAksor);
    var kodik = picked.filter(function (v) { return !isAksor(v); });
    var epNum = mediaType === 'tv' ? picked.ep : 1;
    var expand = kodik.length ? kodikAllDubs(kodik[0], epNum, mediaType === 'movie') : Promise.resolve([]);
    return expand.then(function (all) {
      var list = all.length ? all : kodik.filter(function (v) { return !v.sampleOnly; });
      return aksor.concat(list);
    });
  }).then(function (picked) {
    if (!picked.length) throw new Error('нет озвучек для этой серии');
    log('Озвучки: ' + picked.map(function (v) { return v.data && v.data.dubbing; }).join(', '));
    return mapLimit(picked, CONCURRENCY, function (v) { return isAksor(v) ? aksorStreams(v) : kodikStreams(v); });
  }).then(function (groups) {
    var streams = [];
    groups.forEach(function (g) {
      g.sort(function (a, b) { return b.height - a.height; });
      streams = streams.concat(g);
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
