// Collaps scraper for Nuvio
// - фильм ищется сразу по IMDb ID из TMDB: <api>/embed/imdb/tt…  (без поиска по названию)
// - из встроенного плеера берутся готовые ссылки DASH (до 1080p) и HLS (до 720p)
// - все озвучки идут дорожками внутри одного потока; их названия — в названии источника,
//   в плеере они в том же порядке (подписаны rus0, rus1, eng2 …)
// - русские субтитры (.vtt) передаются в плеер
// Только Promise-цепочки, без async/await (требование Nuvio).

var TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
var DOMAINS = ['https://api.embf.net']; // если Collaps переедет — добавить новый домен сюда
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

var SHOW_DASH = true;  // DASH (.mpd): до 1080p
var SHOW_HLS = true;   // HLS (.m3u8): до 720p, самый совместимый
var CHECK_QUALITY = true; // заглянуть в плейлист, чтобы показать настоящее максимальное качество

var DEBUG = false; // true — показывать лог строками DEBUG в списке стримов (для поиска ошибок)
var LOGS = [];
function log(msg) {
  LOGS.push(String(msg));
  try { console.log('[Collaps] ' + msg); } catch (e) {}
}

function debugStreams() {
  if (!DEBUG) return [];
  return LOGS.map(function (line, i) {
    return {
      name: 'DEBUG ' + (i + 1) + ': ' + line.slice(0, 120),
      title: line,
      url: DOMAINS[0] + '/?debug=' + i,
      quality: line.slice(0, 60),
      provider: 'collaps'
    };
  });
}

function fetchText(url, headers) {
  return fetch(url, { headers: headers || {} }).then(function (r) {
    return r.text().then(function (t) { return { status: r.status, text: t }; });
  });
}

function fetchJson(url) {
  return fetch(url).then(function (r) { return r.json(); });
}

// ---------- TMDB → IMDb ID ----------
function getImdbId(tmdbId, mediaType) {
  var base = 'https://api.themoviedb.org/3/';
  if (/^tt\d+$/.test(String(tmdbId))) return Promise.resolve(String(tmdbId));
  var url = mediaType === 'tv'
    ? base + 'tv/' + tmdbId + '/external_ids?api_key=' + TMDB_API_KEY
    : base + 'movie/' + tmdbId + '?api_key=' + TMDB_API_KEY;
  return fetchJson(url).then(function (j) {
    return (j && j.imdb_id) || null;
  });
}

// ---------- разбор встроенного плеера ----------
// найти JSON-массив/объект, начинающийся после метки, с учётом вложенности и строк
function extractBalanced(text, from) {
  var open = text.charAt(from), close = open === '[' ? ']' : '}';
  var depth = 0, inStr = false, esc = false;
  for (var i = from; i < text.length; i++) {
    var ch = text.charAt(i);
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return text.slice(from, i + 1); }
  }
  return null;
}

function jsonAfter(text, label) {
  var i = text.indexOf(label);
  if (i === -1) return null;
  var j = i + label.length;
  while (j < text.length && text.charAt(j) !== '[' && text.charAt(j) !== '{') j++;
  var raw = extractBalanced(text, j);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function strAfter(text, key) {
  var m = text.match(new RegExp('\\b' + key + ':\\s*"([^"]+)"'));
  return m ? m[1] : null;
}

// фильм: source: { dash: "…", hls: "…", audio: {…}, cc: […] }
function parseMovie(html) {
  var i = html.indexOf('source:');
  if (i === -1) return null;
  var block = html.slice(i, i + 6000);
  var hls = strAfter(block, 'hls'), dash = strAfter(block, 'dash');
  if (!hls && !dash) return null;
  return {
    hls: hls, dash: dash,
    audio: jsonAfter(block, 'audio:'),
    cc: jsonAfter(block, 'cc:') || [],
    title: (html.match(/<title>([^<]*)<\/title>/) || [])[1] || ''
  };
}

// сериал: seasons: [{"season":1,"episodes":[{"episode":"1","hls":"…","dash":"…","audio":{…},"cc":[…]}]}]
function parseEpisode(html, season, episode) {
  var seasons = jsonAfter(html, 'seasons:');
  if (!seasons || !seasons.length) return { error: 'на странице нет списка сезонов' };
  var have = seasons.map(function (s) { return s.season; }).join(',');
  var s = seasons.filter(function (x) { return Number(x.season) === Number(season); })[0];
  if (!s) return { error: 'нет сезона ' + season + ' (есть: ' + have + ')' };
  if (s.blocked) return { error: 'сезон ' + season + ' заблокирован в вашей стране' };
  var e = (s.episodes || []).filter(function (x) { return Number(x.episode) === Number(episode); })[0];
  if (!e) return { error: 'нет серии ' + episode + ' в сезоне ' + season };
  return { hls: e.hls, dash: e.dash, audio: e.audio, cc: e.cc || [], title: e.title || '' };
}

function dubNames(audio) {
  if (!audio || !audio.names || !audio.names.length) return [];
  // порядок как в names: в потоке дорожки идут так же (rus0, rus1, …); order — только порядок показа в плеере Collaps
  return audio.names.filter(function (n) { return n; });
}

function subLanguage(name) {
  var n = String(name || '').toLowerCase();
  if (/рус|rus/.test(n)) return 'Русский';
  if (/укр|ukr/.test(n)) return 'Українська';
  if (/eng|англ/.test(n)) return 'English';
  return name || 'Unknown';
}

// максимальная высота кадра из HLS master / DASH mpd
function maxHeight(url, headers) {
  if (!CHECK_QUALITY) return Promise.resolve(0);
  return fetchText(url, headers).then(function (r) {
    var best = 0, re = /RESOLUTION=\d+x(\d+)|\bheight="(\d+)"/g, m;
    while ((m = re.exec(r.text)) !== null) {
      var h = parseInt(m[1] || m[2], 10);
      if (h > best) best = h;
    }
    return best;
  }).catch(function () { return 0; });
}

function plural(n, one, few, many) {
  var m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function qualityLabel(h) {
  if (!h) return '';
  if (h >= 1000) return '1080p';
  if (h >= 700) return '720p';
  if (h >= 470) return '480p';
  return '360p';
}

// ---------- точка входа ----------
function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  LOGS = [];
  mediaType = mediaType === 'tv' ? 'tv' : 'movie';
  var season = seasonNum || 1, episode = episodeNum || 1;
  var base = DOMAINS[0];
  var playerHeaders = { 'User-Agent': UA, 'Referer': base + '/', 'Origin': base };

  return getImdbId(tmdbId, mediaType).then(function (imdb) {
    if (!imdb) throw new Error('у TMDB нет IMDb ID');
    log('IMDb: ' + imdb + (mediaType === 'tv' ? ' S' + season + 'E' + episode : ''));
    var idx = 0;
    function tryNext() {
      if (idx >= DOMAINS.length) throw new Error('нет на Collaps');
      var d = DOMAINS[idx++];
      return fetchText(d + '/embed/imdb/' + imdb, { 'User-Agent': UA, 'Accept': 'text/html,*/*' }).then(function (r) {
        log(d + ' → ' + r.status + ', ' + r.text.length + 'б');
        if (r.status === 404) throw new Error('нет на Collaps');
        if (r.status >= 400 || r.text.indexOf('makePlayer') === -1) return tryNext();
        base = d;
        playerHeaders = { 'User-Agent': UA, 'Referer': d + '/', 'Origin': d };
        return r.text;
      }, function (e) { log(d + ': ' + e.message); return tryNext(); });
    }
    return tryNext();
  }).then(function (html) {
    var isSeries = html.indexOf('seasons:') !== -1;
    if (mediaType === 'tv' && !isSeries) throw new Error('по этому IMDb ID у Collaps фильм, а не сериал');
    if (mediaType === 'movie' && isSeries) throw new Error('по этому IMDb ID у Collaps сериал, а не фильм');
    var item = isSeries ? parseEpisode(html, season, episode) : parseMovie(html);
    if (!item) throw new Error('не удалось разобрать плеер');
    if (item.error) throw new Error(item.error);
    var dubs = dubNames(item.audio);
    log('Озвучки: ' + (dubs.join(', ') || 'нет данных'));
    var subs = (item.cc || []).filter(function (c) { return c && c.url; }).map(function (c) {
      return { url: c.url, language: subLanguage(c.name), name: c.name || subLanguage(c.name) };
    });
    var variants = [];
    if (SHOW_DASH && item.dash) variants.push({ kind: 'DASH', url: item.dash });
    if (SHOW_HLS && item.hls) variants.push({ kind: 'HLS', url: item.hls });
    return Promise.all(variants.map(function (v) {
      return maxHeight(v.url, playerHeaders).then(function (h) { v.height = h; return v; });
    })).then(function (vs) {
      // DASH показываем, только если он даёт качество выше HLS (HLS совместимее, особенно на iPhone)
      var hlsV = vs.filter(function (v) { return v.kind === 'HLS'; })[0];
      if (hlsV && hlsV.height) {
        vs = vs.filter(function (v) { return v.kind !== 'DASH' || !v.height || v.height > hlsV.height; });
      }
      var dubLine = dubs.length ? dubs.join(' · ') : 'Collaps';
      return vs.map(function (v) {
        var q = qualityLabel(v.height) || (v.kind === 'DASH' ? '1080p' : '720p');
        var s = {
          // Nuvio показывает name крупно, а под ним quality и language
          name: dubLine,
          title: dubLine + ' · ' + q + ' ' + v.kind,
          url: v.url,
          quality: q + ' ' + v.kind,
          language: dubs.length > 1 ? dubs.length + ' ' + plural(dubs.length, 'озвучка', 'озвучки', 'озвучек') + ', выбор в плеере' : undefined,
          provider: 'collaps',
          headers: playerHeaders
        };
        if (subs.length) s.subtitles = subs;
        return s;
      });
    });
  }).then(function (streams) {
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
