# Скраперы для Nuvio

Два отдельных плагина с русской озвучкой. Каждый добавляется в Nuvio своей ссылкой и включается/выключается независимо.

| Плагин | Сайт | Что ищет | Ссылка для Nuvio |
|---|---|---|---|
| **HDRezka** | rezka.ag | Фильмы и сериалы, до 1080p | `https://raw.githubusercontent.com/aglrm/nuvio-providers/refs/heads/main/hdrezka/` |
| **YummyAnime** | old.yummyani.me | Аниме: сериалы и фильмы | `https://raw.githubusercontent.com/aglrm/nuvio-providers/refs/heads/main/yummyanime/` |

## Установка

1. Откройте Nuvio → **Settings → Local Scrapers**.
2. Добавьте нужную ссылку из таблицы (окончание `/hdrezka/` или `/yummyanime/` обязательно).
3. Чтобы поставить оба плагина, добавьте обе ссылки.

## Структура

```
hdrezka/manifest.json      — плагин HDRezka
hdrezka/hdrezka.js
yummyanime/manifest.json   — плагин YummyAnime
yummyanime/yummyanime.js
```

Каждая папка — отдельный репозиторий для Nuvio со своим `manifest.json`. Скраперы написаны на Promise-цепочках без async/await, как того требует Nuvio.

## HDRezka

- Сам проходит защиту Anubis на rezka.ag (проверка «Проверяем, что вы не бот!»).
- Берёт название из TMDB, ищет на сайте, сверяет год и тип.
- Отдаёт до 8 озвучек и «Оригинал (+субтитры)», 360p–1080p. Премиум-качества и украинские озвучки пропускает.
- Настройки (`MAX_TRANSLATORS`, `TRANSLATOR_PRIORITY`, `SKIP_UKRAINIAN`, `USE_MP4`, `DOMAINS`, `DEBUG`) — в начале `hdrezka/hdrezka.js`.

## YummyAnime

- Ищет аниме через API сайта, видео берёт из плееров Kodik и Aksor.
- Сезон из TMDB сопоставляет с записью на сайте по году выхода; продолжения, которые в TMDB входят в тот же сезон, находит сам.

## Если стримов нет

Включите `DEBUG = true` в начале файла скрапера: лог появится строками в списке источников. Ссылки на видео выдаются на ваш IP и действуют ограниченное время — если стрим перестал запускаться, обновите список источников.

## Отказ от ответственности

Репозиторий не хранит видео. Весь контент находится на сторонних сайтах.
