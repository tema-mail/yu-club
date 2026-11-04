# K22. CMS: контент сайта, уровни сеть/город/филиал, черновик, публикация, версии, медиа, предпросмотр, кэш

Статус: контракт Э4 (04.11.2026), до ревью `architecture-reviewer` (шаг S4-00). Модуль-владелец: `content` – **новый** (`apps/api/src/modules/content/*`: `errors.ts`, `audit.ts`, `media.ts`, `versions.ts`, `publications.ts`, `games.ts`, `pages.ts`, `blocks.ts`, `preview.ts`, `paths.ts` (K23), `routes.public.ts`, `routes.crm.publications.ts`, `routes.crm.catalog.ts`, `routes.media.ts`, `index.ts`). Таблицы – миграции 0403 (медиа) и 0404 (контент). Файлы – `core/files.ts` (новый, общий с экспортом K24).
Основа: 12 §3–§15, §17, §18; 19 §3, §4; 13 §12.6; 02 §7.4; 17 §8.5; 18 §8.2 п.9–10; карта сайта `docs/karta-sayta.md`; K1, K2, K7, K13 (network/resources), ADR 0002.

Пометки: «по умолчанию, ждёт заказчика (Q-xx)»; «решение» – вывод архитектора.

## 1. Граница модуля: что контент, а что факт

Факты живут у своих владельцев и в CMS не дублируются (12 §3 п.8, §12; приёмка 21, 23):

| Данные | Владелец | CMS |
|---|---|---|
| адрес, телефон, часы, статус филиала, зона | `network` (0008, 0103) | только читает через `network/index.ts` |
| комната: слаг, вместимость, статус, «на сайте» (`rooms.is_published`), ресурсы, состав | `resources` (0101, 0102) | только читает; `is_published` – единственный выключатель «комната есть на сайте» (K5 №4, карта сайта) |
| доступность слотов | `booking` | не трогает; контент не может её поменять (12 §7.3) |
| цены | `pricing` | «от» из тарифа – только если Q-79 = «показывать» |
| тексты, фото, описания, игры, публикации, блоки главной, страницы | **`content`** | черновик → публикация → версии |

Связь – по `id` чужой сущности с FK (`branch_id`, `room_id`, `city_id`); имена и адреса в контент не копируются.

## 2. Сущности контента

| Сущность (таблица) | Ключ публичного адреса | Уровень | Поля черновика (кроме общих §3) |
|---|---|---|---|
| Публикация `content_publications` | `/{type-path}/{slug}/`; `UNIQUE (type, slug)` | сеть / город / филиалы (§4) | `type`: `news` / `promotion` / `giveaway` / `tournament` (турниры – по 19, подтвердить, Q-77); `title` ≤ 120; `lead` ≤ 300; `body` (§6); `cover_media_id`; `publish_from`, `publish_to`; `event_date` (новость, турнир); акция – `conditions`, `restrictions`, `cta_label`, `cta_url` (только свой сайт или `/schedule/?…`); розыгрыш – `results_date`, `prize`, `rules_body` или `rules_media_id` (PDF) – Q-карты 13 |
| Игра `content_games` | `/games/{direction}/{slug}/`; `UNIQUE (direction, slug)` | сеть (каталог общий), доступность – по филиалам (Q-78) | `direction`: `pc` / `vr` / `playstation`; `title`; `short` ≤ 200; `full` (§6, пусто – страницы игры нет, только плитка); `cover_media_id`; `genres text[]` из справочника; `age_rating` (`0+`…`18+`); `platforms text[]` (`ps5`, `ps4` – у PlayStation обязательно, 12 §6.4; у VR – модели шлемов из справочника); `sort_order` |
| Доступность игры `content_game_branches` | – | филиал | `game_id`, `branch_id`, `available boolean`, `note` ≤ 120; без строки = недоступна (12 §6.1, приёмка 9). Не версионируется (оперативный факт), аудит есть |
| Страница комнаты `content_room_pages` | адрес комнаты (`resources`) | филиал | `room_id UNIQUE`; `description` (§6); `gallery media_id[]` ≤ 20; `features text[]`; `rent_formats_text` (описание словами, правила – у брони) |
| Страница филиала `content_branch_pages` | адрес филиала (`network`) | филиал | `branch_id UNIQUE`; `description`; `gallery`; `features`; `how_to_get` ; `postal`: `{ street, locality, region, postalCode }`, `geo`: `{ lat, lng }` – для JSON-LD и карты (K23 §6; Q-137) |
| Страница `content_pages` | фиксированный ключ → адрес (§5) | сеть, с подменой для города/филиала, если ключ разрешает | `key`: `about`, `contacts_intro`, `rules`, `privacy-policy`, `personal-data-consent`, `cookie-policy`, `advertising-consent`; `title`; `body`; у юридических – `document_version` (§7) |
| Блок главной `content_home_blocks` | `/` | сеть, город (решение: филиал – нет, главная одна на сеть) | `block_type` из фиксированного списка дизайна (`hero`, `about`, `directions`, `advantages`, `promo_strip`, `cta`); `payload jsonb` по Zod-схеме типа; `sort_order` (Q-85) |
| Медиа `content_media` | `/media/…` (§8) | сеть | файл, `alt`, связи |

Наследование (12 §3 п.4–5; Q-146, по умолчанию, ждёт заказчика): блоки главной и страницы `about`, `rules` – у города может быть своя версия, иначе берётся сетевая; юридические страницы – только сетевые (один оператор ПДн); публикации не наследуются, а показываются по охвату (§4); игры – одна карточка на сеть, доступность – по филиалам.

## 3. Черновик, публикация, версии, откат (12 §9.2–9.5; приёмка 6, 7, 17, 18)

Общие столбцы каждой версионируемой таблицы: `status` (`draft` / `published` / `unpublished` / `archived`), `draft jsonb` (поля черновика целиком, проверены Zod-схемой типа), `draft_updated_at`, `draft_updated_by`, `live_version_id uuid` (FK → `journal.content_versions`), `row_version`, `created_by`, `created_at`, `archived_at`. Поля, по которым ищут и фильтруют (`slug`, `type`, `direction`, `publish_from`, `publish_to`, охват), хранятся и в столбцах **живой** версии – их пишет только `publish`.

`journal.content_versions` (только вставка): `id`, `entity_type`, `entity_id`, `version_no` (`UNIQUE (entity_type, entity_id, version_no)`), `snapshot jsonb` (то, что видит посетитель), `action` (`publish` / `rollback_publish`), `published_by`, `published_at`, `reason`, `source_version_id` (для отката).

| Команда (`versions.ts`, общая для всех сущностей) | Что делает | Идемпотентность / гонки |
|---|---|---|
| `saveDraft(ctx, ref, { rowVersion, draft })` | Zod-проверка типа, ошибки по полям (12 §14.2); публичный сайт не меняется (12 §9.2) | `row_version` → `409 VERSION_CONFLICT` с текущим черновиком |
| `publish(ctx, ref, { rowVersion, reason? })` | проверка полноты для публикации (§9), новая строка `content_versions` со снимком черновика, `live_version_id`, столбцы живой версии, `status='published'`; смена `slug` у опубликованного – K23 §5 (история адреса) | `Idempotency-Key`; одна транзакция; `SELECT … FOR UPDATE` сущности |
| `unpublish(ctx, ref, { reason })` | `status='unpublished'`, `live_version_id` остаётся (для истории), сайт перестаёт показывать; причина обязательна (12 §9.5) | `Idempotency-Key` |
| `archive(ctx, ref, { reason })` | из `draft`/`unpublished`; опубликованное – сначала снять. Удаления нет (12 §9.5, приёмка 18) | `Idempotency-Key` |
| `rollback(ctx, ref, { versionId, rowVersion, reason })` | черновик := снимок выбранной версии, затем `publish` с `action='rollback_publish'`, `source_version_id` – **новая** версия, история линейна, старые версии не меняются | `Idempotency-Key` |
| `listVersions(ctx, ref)` | версии с автором, датой, причиной; сравнение двух снимков по полям – в CRM | чтение |

Черновик посетителю недоступен **по построению**: публичные запросы читают только `content_versions.snapshot` через `live_version_id` и столбцы живой версии; столбец `draft` в публичных запросах не выбирается (тест S4-37 ищет текст черновика в ответах публичного API).

Срок показа публикации – фильтр запроса, а не задача: видна, если `status='published' AND publish_from <= $now AND (publish_to IS NULL OR publish_to > $now)`; акция после `publish_to` выпадает из активных (12 §8.3, приёмка 16) и по прямой ссылке показывается с плашкой «Акция завершена» и `noindex` – по умолчанию, ждёт заказчика (вопрос карты сайта 9; ключ `content.ended_promotion_mode`: `banner_noindex` / `not_found`). Отложенная публикация (12 §9.4) работает тем же фильтром: опубликовано заранее, видно с `publish_from`.

Хранение версий: все, без чистки – по умолчанию, ждёт заказчика (Q-136); объём мал (текст, ссылки на медиа).

## 4. Охват сеть / город / филиалы (12 §8.5, приёмка 5)

`content_publication_scopes` (живая версия): `publication_id`, `scope_type` (`network` / `city` / `branch`), `city_id`, `branch_id`; у публикации либо одна строка `network`, либо строки одного вида. Правило показа для выбора посетителя (кука `yu_branch`, K5):

| Посетитель выбрал | Видит |
|---|---|
| ничего | `network` + публикации городов и филиалов с пометкой «только в {город}/{филиал}» (12 §8.5 «явно обозначенные региональные») |
| город | `network` + `city = выбранный` + `branch ∈ филиалы города` с пометкой филиала |
| филиал | `network` + `city = город филиала` + `branch = выбранный`; публикации других филиалов – нет (12 §8.5: «не видеть предложение как действующее, если оно там не применяется») |

Адрес публикации один на сеть (карта сайта п.2.9) – охват меняет видимость в списках, но не адрес и не индексацию. Права на публикацию проверяются по охвату: `network` → цель `{ network: true }`; `city` → `{ cityId }`; `branch` → каждый `{ branchId }` (§10).

## 5. Адреса страниц из CMS

Шаблоны адресов – K23 §1. Ключи `content_pages` → адрес: `about` → `/about/`, `rules` → `/rules/`, юридические – одноимённые пути карты сайта 3.4, `contacts_intro` – текст на `/contacts/` (сама страница собирается из филиалов `network`). Новых адресов без строки в карте сайта CMS не создаёт: ключ вне списка – `PAGE_KEY_UNKNOWN` (решение: страницы не плодятся редактором, правило «не дорвеи»).

## 6. Текст (`body`, `full`, `description`)

Формат – Markdown-подмножество (решение): абзацы, `##`/`###` (H1 у страницы один – заголовок, в тексте `#` запрещён), списки, **жирный**, *курсив*, ссылки, цитата, изображение только из медиатеки (`![alt](media:<id>)`), таблица. Хранится исходник; HTML строит сайт при показе (`apps/site/src/lib/rich-text.ts`): `markdown-it` с `html: false` (сырой HTML не разбирается вовсе; рекомендация ревью 04.11 вместо `marked`, который HTML пропускает) → `sanitize-html` с белым списком тегов и атрибутов; ссылки – `https:`, `mailto:`, `tel:` или путь своего сайта, начинающийся ровно с одного `/` (`//host` и `/\host` браузер читает как чужой домен – отвергаются); внешние – `rel="noopener nofollow"`; `media:<id>` → `/media/…` с `width`/`height`, `loading="lazy"`, `alt` – из **снимка версии** (§8 п.5), не из живой строки медиатеки. Сохранённый контент – недоверенный (сотрудник может вставить `<script>`): очистка на выходе обязательна, на входе – только проверка размера (≤ 50 000 знаков) и запрет сырого HTML (`RICH_TEXT_HTML_FORBIDDEN`).

## 7. Юридические страницы и версия документа

У `privacy-policy`, `personal-data-consent`, `cookie-policy`, `advertising-consent` поле `document_version` (`<key>-YYYY-MM-DD[-n]`) задаётся при публикации и неизменно у версии. Галочки согласия на сайте (вход K9 №2, настройки K9, cookie-баннер) передают `document_version` **живой** версии соответствующей страницы – она пишется в `journal.client_consents.document_version`. Пока страница не опубликована, ссылка ведёт на страницу «Документ готовится» (карта сайта 3.4), а согласие на рекламу не принимается (`MARKETING_DOCUMENT_MISSING`) – реклама невозможна без текста, на который дано согласие (K21 §4). Публикует только Владелец (`content.legal.publish`); тексты – от юриста заказчика (Q-86).

Константа `MARKETING_DOCUMENT_VERSION` в `notifications/index.ts` (Э1) заменяется чтением живой версии `advertising-consent` (S4-20).

## 8. Медиа: хранение на сервере (12 §10; 17 §8.5; Q-96)

**Приём** (`media.ts`, маршрут K11 №224 – `multipart/form-data`, `@fastify/multipart`, лимит части 10 МБ – Q-96):
1. Тип – по сигнатуре байтов, не по расширению и не по `Content-Type`: JPEG, PNG, WebP; PDF – только для правил розыгрыша (`purpose='document'`). SVG, GIF, HEIC и прочее – `MEDIA_TYPE_NOT_ALLOWED` (SVG – исполняемый XSS).
2. Изображение перекодируется (`sharp`): снимаются EXIF и GPS (координаты съёмки – ПДн и место жительства сотрудника, вывод плана), ориентация применяется; варианты WebP по ширине 480, 960, 1600 (не больше исходника) и JPEG 1600 для OG-картинок. Жёсткие ограничения (ревью 04.11): `metadata().format` – только `jpeg`, `png`, `webp` (иначе `MEDIA_TYPE_NOT_ALLOWED`, даже если сигнатура подделана под разрешённую), `limitInputPixels` = 40 Мп (защита от «бомбы распаковки»), `failOn: 'warning'` (битый файл – отказ, не «как получится»), `pages: 1` (без анимации и многостраничных), одновременно не больше 1–2 перекодирований (очередь в процессе API, `sharp.concurrency(1)`) – 10 МБ картинок параллельно иначе съедают память стенда.
   PDF (`purpose='document'`) не перекодируется и отдаётся либо `Content-Disposition: attachment`, либо с `Content-Security-Policy: sandbox` (блок Caddy для `/media/*.pdf`) – PDF со скриптами не исполняется в контексте сайта.
3. Имя файла – по содержимому: `media/<aa>/<bb>/<sha256>-<w>.webp`; исходное имя хранится очищенным только для показа в CRM. Повторная загрузка того же файла – та же строка `content_media` (дедупликация по `sha256`).
4. Запись – атомарно (общий адаптер диска `core/files.ts` – создаёт S3-06 для вложений Э3, S4-06 добавляет квоту и корень `MEDIA_DIR`: временный файл в том же каталоге → `fsync` → `rename`), каталог `MEDIA_DIR` (`/opt/yu-club/media`, том контейнера `api`, права `0750`, владелец – пользователь контейнера). Строка БД – после записи файлов; сбой между ними оставляет «сироту» на диске, её убирает ночная задача `content:media-gc` (файлы без строки старше суток).
5. `alt` обязателен перед публикацией сущности, где картинка не декоративная (обложка, галерея, картинка в тексте) – `MEDIA_ALT_REQUIRED` при `publish`, не при загрузке. `publish` **замораживает** `alt` (и размеры) каждого использованного медиа в `content_versions.snapshot`: правка `alt` в медиатеке не меняет живой сайт до следующей публикации сущности (иначе опубликованная версия меняется в обход черновика и истории). Править `alt` и черновики своего филиала может Администратор – по умолчанию, Q-152.

**Отдача.** Caddy отдаёт `/media/*` с диска напрямую (`file_server`, только чтение, `Cache-Control: public, max-age=31536000, immutable` – имя меняется при изменении содержимого), без листинга каталога, `X-Content-Type-Options: nosniff`; API на `/media/` не ходит.

**Связи и архив.** `content_media_usages` (`media_id`, `entity_type`, `entity_id`, `field`) пересчитываются при каждом `saveDraft` и `publish` (по черновику и по живой версии). Архивировать файл, который используется живой версией, нельзя (`MEDIA_IN_USE` со списком); архивированный не предлагается в выборе, файлы остаются (старые версии ссылаются на них). Обычное физическое удаление – только по запросу Владельца, если файла нет ни в одной версии (`content.media.purge`).

**Принудительная очистка по требованию субъекта** (ГК ст. 152.1; Q-135; шаг S4-45): `purgeMedia(ctx, id, { reason, basis })` – Владелец, основание обязательно. Удаляются файлы всех вариантов, даже если медиа использовано в версиях; журнал `content_versions` не правится – в живых сущностях публикуется новая версия без фото, а при показе любого снимка (в том числе при откате) ссылка на очищенное медиа заменяется заглушкой «изображение удалено» (`content_media.status = 'purged'`). Аудит `media.purged` (кто, когда, основание, список затронутых сущностей). Бэкап старше очистки содержит файл: регламент восстановления повторяет очистку по журналу `media.purged`. Срок хранения фото – вопрос Q-150.

**Объём и бэкап.** Квота `MEDIA_QUOTA_GB` (по умолчанию 5) – при превышении загрузка отклоняется `MEDIA_QUOTA_EXCEEDED`, оповещение техлиду (17 §13). `deploy/backup.sh` дополняется архивом `MEDIA_DIR` (rsync-снимок рядом с дампом), `restore-check.sh` проверяет, что каждый `content_media.storage_key` есть на диске после восстановления (S4-07); медиатека вместе с дампом и вложениями Э3 уходит в копию вне сервера (S3-99 – 17 §11.2 не допускает копий только на том же сервере).

**Путь загрузки через CRM.** Caddy домена CRM режет тело запроса до 2 МБ (`request_body max_size 2MB`), прокси CRM `pages/api/crm/v1/[...path].ts` читает тело целиком (`arrayBuffer()`). Для №224 (и вложений Э3 №350) – отдельный маршрут Caddy с 11 МБ и потоковая передача тела в прокси (`duplex: 'half'`), остальные маршруты – прежние 2 МБ (S4-09).

## 9. Проверка полноты перед публикацией (12 §14.2, приёмка 20)

| Тип | Обязательно для `publish` |
|---|---|
| публикация | `title`, `lead`, `body`, `slug` (K23 §3), охват, `publish_from`; акция – `publish_to` и `conditions`; розыгрыш – `results_date`, `prize`, правила; обложка с `alt` |
| игра | `title`, `direction`, `short`, `cover` с `alt`, у PlayStation – `platforms`; `full` – необязательно (без него нет карточки игры, K23 §1) |
| страница комнаты / филиала | `description`; у галереи – `alt` у каждого фото |
| юридическая страница | `body`, `document_version` |
| блок главной | `payload` по схеме типа |

Ошибки – списком по полям (`CONTENT_INCOMPLETE`, `details.fields: [{ field, code }]`), не общим сообщением (12 §14.2).

## 10. Права (K1, шаг S4-01)

Право публикации отделено от права черновика (12 §15).

| Действие (`Action`) | О | Д | А | Цель | Основание |
|---|:-:|:-:|:-:|---|---|
| `content.view` | ✓ | ✓ | ✓ | branch / network | 12 §15 «Директор – просмотр сетевого» |
| `content.draft.edit` | ✓ | ✓ | ✓ | по охвату (§4) | 12 §15 «Администратор – черновики при наличии права» – по умолчанию да, только охват своего филиала (Q-134) |
| `content.publish` (город, филиал) | ✓ | ✓ | | по охвату | 12 §15 «Директор – локальные материалы» (Q-134) |
| `content.network.manage` (сетевые публикации, каталог игр, блоки главной, страницы `about`/`rules`) | ✓ | | | network | 12 §15 «Владелец – общесетевой контент, каталог» |
| `content.catalog.availability` (доступность игры в филиале) | ✓ | ✓ | | branch | решение: оперативный факт филиала |
| `content.legal.publish` | ✓ | | | network | §7 |
| `content.media.upload` | ✓ | ✓ | ✓ | network | 12 §10 |
| `content.media.archive` | ✓ | ✓ | | network | решение |
| `content.media.purge` | ✓ | | | network | §8 |
| `content.preview` | ✓ | ✓ | ✓ | как `content.view` | 12 §9.3 |

Охват с несколькими филиалами – право на **каждый** (`assertCan` по всем `branchId`); Администратор не публикует ничего и не правит сетевое.

## 11. Предпросмотр (12 §9.3; карта сайта 3.5 «предпросмотр – в CRM, не на публичном домене»)

Решение: страницу рисует то же приложение сайта (одни шаблоны – нет расхождения «предпросмотр ≠ сайт»), но публичный домен её не отдаёт.
1. CRM вызывает `POST /content/{type}/{id}/preview-token` (K11 №233) – API выдаёт токен: base64url(`entityType`, `entityId`, `draftRowVersion`, `staffId`, `branchId?` для показа «как в филиале», `exp = $now + 10 мин`) + HMAC-SHA256 на `PREVIEW_SECRET`.
2. Сервер CRM (`apps/crm`, маршрут `/content/preview/[token]`) запрашивает у сайта по внутренней сети `SITE_INTERNAL_URL/preview/{token}` с заголовком `X-Preview-Secret`, сайт проверяет оба, берёт черновик через API (`GET /api/internal/v1/content/preview/{token}`, доступен только по внутренней сети) и рисует страницу с `noindex`, `no-store` и плашкой «Черновик – не опубликовано».
3. CRM показывает ответ в `<iframe srcdoc sandbox>` шириной 390 и 1440 px (12 §9.3 «мобильное и десктопное»): атрибут `sandbox` **без** `allow-same-origin` и **без** `allow-scripts` – черновик, прошедший мимо очистки, не получает ни куки CRM, ни доступа к её API; страница предпросмотра несёт `<base href>` на адрес сайта, чтобы стили и `/media/…` грузились с сайта, а не из CRM. Интерактивные острова сайта в предпросмотре не работают – это приемлемо (показ текста и вёрстки).
4. Caddy на публичном домене отвечает `404` на `/preview/*` и `/api/internal/*` (S4-07). Токен по ссылке вне CRM бесполезен: без `X-Preview-Secret` сайт отвечает `404`.

## 12. Публичный API и кэш сайта (12 §12; Q-81)

**Маршруты** (`routes.public.ts`, база `/api/public/v1`, без сессии, только живые версии):

| № | Метод и путь | Успех |
|---|---|---|
| K5 №207 | `GET /content/home?city=` | `200 { blocks: HomeBlock[], promos: PublicationCard[] (≤ 6), news: PublicationCard[] (≤ 3), games: GameCard[] (≤ 20, для карусели) }` |
| K5 №208 | `GET /content/publications?type=&city=&branch=&cursor=&limit=` | `200 { items: PublicationCard[], nextCursor }`; порядок `(publish_from DESC, id)`; `limit` ≤ 50 |
| K5 №209 | `GET /content/publications/{type}/{slug}?branch=` | `200 PublicationPage & { state: 'active' \| 'ended', seo }`; нет или не опубликовано – `404` |
| K5 №210 | `GET /content/games?direction=&branch=` | `200 { items: GameCard[] }`; при `branch` – только доступные там (12 §14.1: не подменять играми другого филиала); без `branch` – сетевой каталог с пометкой «общий каталог сети» |
| K5 №211 | `GET /content/games/{direction}/{slug}` | `200 GamePage & { availableIn: BranchRef[], seo }`; без `full` – `404` (карточки нет) |
| K5 №212 | `GET /content/pages/{key}?city=` | `200 { title, body, documentVersion?, updatedAt, seo }`; не опубликована – `404` (сайт рисует «Документ готовится» для юридических) |
| K5 №213 | `GET /content/rooms/{roomId}` | `200 { description, gallery, features, rentFormatsText, seo } \| 404` – дополнение к K5 №4 |
| K5 №214 | `GET /content/branches/{branchId}` | `200 { description, gallery, features, howToGet, postal, geo, seo } \| 404` |
| K5 №215 | `GET /content/legal-versions` | `200 { privacyPolicy, personalDataConsent, cookiePolicy, advertisingConsent }` – живые `document_version` или `null` (для галочек входа и настроек) |

DTO ответов не содержат `draft`, автора, внутренних комментариев и `created_by` (12 §3 п.10).

**Кэш (решение, Q-81 «контент – до 1 минуты»):** ответы `Cache-Control: public, max-age=60` и `ETag` = хеш `live_version_id` вошедших сущностей. Эти заголовки рассчитаны на сервер сайта (SSR ходит в API напрямую по `API_URL`): прокси сайта для браузера `pages/api/public/v1/[...path].ts` ставит `Cache-Control: no-store` и `ETag` не передаёт (`FORWARD_RESPONSE` – только `content-type`, `retry-after`, `idempotent-replay`; проверено по коду 04.11) – браузерного кэша ответов контента нет, и это так и задумано. Сайт держит в памяти процесса LRU-кэш ответов API контента (≤ 500 записей, TTL `CONTENT_CACHE_TTL_SECONDS`, по умолчанию 60) – публикация видна на сайте не позже чем через 60 с без сброса кэша. Доступность, удержания, ЛК – мимо кэша (Q-81 «доступность – сразу»). Сбой API при живом кэше – отдаётся устаревший ответ не старше 10 минут с записью в лог (`stale-if-error`), иначе страница `503` (как middleware сейчас): посетитель не видит пустой каталог вместо ошибки (12 §14.1 «ошибка загрузки с повтором»).

## 13. API CRM (дополняет K11)

| № | Метод и путь | Право |
|---|---|---|
| K11 №213 | `GET /content/publications?type=&status=&cityId=&branchId=&q=&sort=&cursor=` (12 §14.2) | `content.view` |
| K11 №214 | `POST /content/publications` (`{ type, draft }`) | `content.draft.edit` |
| K11 №215 | `GET /content/publications/{id}` (черновик, живая версия, права текущего сотрудника на действия) | `content.view` |
| K11 №216 | `PUT /content/publications/{id}/draft` | `content.draft.edit` |
| K11 №217 | `POST /content/publications/{id}/publish` · `/unpublish` · `/archive` · `/rollback` | `content.publish` / `content.network.manage` по охвату |
| K11 №218 | `GET /content/publications/{id}/versions` | `content.view` |
| K11 №219 | `GET/POST /content/games`, `GET/PUT /content/games/{id}/draft`, `POST …/publish|unpublish|archive|rollback` | `content.view` / `content.network.manage` |
| K11 №220 | `PUT /content/games/{id}/branches/{branchId}` (`{ available, note }`) | `content.catalog.availability` |
| K11 №221 | `GET/PUT /content/rooms/{roomId}/draft`, `POST …/publish|unpublish|rollback` | `content.draft.edit` / `content.publish` (цель – филиал комнаты) |
| K11 №222 | `GET/PUT /content/branches/{branchId}/draft`, `POST …/publish|unpublish|rollback` | то же, цель – филиал |
| K11 №223 | `GET/PUT /content/pages/{key}/draft?cityId=`, `POST …/publish|unpublish|rollback` | `content.network.manage` или `content.legal.publish` (юридические) |
| K11 №224 | `POST /content/media` (multipart), `GET /content/media?q=&type=&archived=&cursor=` | `content.media.upload` / `content.view` |
| K11 №225 | `PATCH /content/media/{id}` (`{ alt, title }`), `POST /content/media/{id}/archive` | `content.media.upload` / `content.media.archive` |
| K11 №226 | `GET /content/media/{id}/usages` | `content.view` |
| K11 №227 | `DELETE /content/media/{id}` (физическое удаление, §8) | `content.media.purge` |
| K11 №228 | `GET/PUT /content/home-blocks?cityId=`, `POST /content/home-blocks/{id}/publish|unpublish|rollback`, `PUT /content/home-blocks/order` | `content.network.manage` (город – `content.publish` по `cityId`) |
| K11 №229–232 | резерв (комментарии к черновикам, шаблоны блоков 12 §16 эт.3 п.6 – не в Э4) | – |
| K11 №233 | `POST /content/{entityType}/{id}/preview-token` (`{ branchId? }`) | `content.preview` |

Изменяющие – `Idempotency-Key`; черновики – `row_version`. Список возвращает действия, доступные сотруднику (`allowedActions`), но защита – на сервере (K11 №1).

## 14. Ошибки

| Код | HTTP | Когда |
|---|---|---|
| `CONTENT_INCOMPLETE` | 422 | §9, `details.fields` |
| `CONTENT_INVALID` | 400 | черновик не проходит схему типа, `details.issues` |
| `CONTENT_STATUS_CONFLICT` | 409 | действие не из этого статуса (архив опубликованного, публикация архивного) |
| `PAGE_KEY_UNKNOWN` | 404 | §5 |
| `RICH_TEXT_HTML_FORBIDDEN` / `RICH_TEXT_TOO_LONG` | 422 | §6 |
| `MEDIA_TYPE_NOT_ALLOWED` / `MEDIA_TOO_LARGE` / `MEDIA_DIMENSIONS_TOO_LARGE` / `MEDIA_QUOTA_EXCEEDED` | 415 / 413 / 422 / 507 | §8; понятный текст «Можно загрузить JPG, PNG или WebP до 10 МБ» (12 §10) |
| `MEDIA_ALT_REQUIRED` | 422 | публикация с картинкой без `alt` |
| `MEDIA_IN_USE` | 409 | архив или удаление используемого, `details.usages` |
| `MARKETING_DOCUMENT_MISSING` | 409 | согласие на рекламу без опубликованного `advertising-consent` (§7) |
| `PREVIEW_TOKEN_INVALID` | 404 | §11 (как несуществующая страница) |
| `SLUG_*` | – | K23 §3 |
| `VERSION_CONFLICT` | 409 | черновик устарел |

## 15. Настройки и окружение

K7 (меняет Владелец): `content.ended_promotion_mode` – `banner_noindex` / `not_found`, умолчание `banner_noindex` (вопрос карты сайта 9). Окружение: `MEDIA_DIR`, `MEDIA_QUOTA_GB`, `MEDIA_PUBLIC_BASE` (`/media`), `PREVIEW_SECRET`, `SITE_INTERNAL_URL`, `CONTENT_CACHE_TTL_SECONDS`.

## 16. События и аудит

- K4: `content.published` @1 `{ entityType, entityId, versionId, slug?, scope }`, `content.unpublished` @1 – подписчики: `notifications` (не в Э4), будущий сброс кэша; в Э4 потребитель один – отчёт 11 (K24) читает их из `content_versions`, поэтому решение: **событий не публикуем**, пока нет подписчика (как D2-09).
- K2 (типы объектов `publication`, `game`, `room_page`, `branch_page`, `content_page`, `home_block`, `media`): `content.draft_saved` (без `before/after` текста – только список изменённых полей, иначе аудит раздувается), `content.published` (`after`: номер версии), `content.unpublished` (причина), `content.archived`, `content.rolled_back` (из какой версии), `content.availability_changed`, `media.uploaded`, `media.updated`, `media.archived`, `media.purged`.

## 17. Данные (для `model-dannyh.md`, S4-00)

**0403 `content_media`**: `content_media` (`id`, `sha256 UNIQUE`, `mime`, `bytes`, `width`, `height`, `variants jsonb` – ширины и ключи файлов, `storage_key`, `alt`, `title`, `original_name`, `purpose` `image`/`document`, `status` `active`/`archived`/`purged`, `uploaded_by`, `created_at`, `archived_at`, `row_version`); `content_media_usages` (`media_id → content_media`, `entity_type`, `entity_id`, `field`, `live boolean`, PK по четырём полям + `live`).

**0404 `content`**: `content_publications`, `content_publication_scopes` (`→ cities`, `→ branches`), `content_games`, `content_game_branches` (`→ branches`), `content_room_pages` (`→ rooms`), `content_branch_pages` (`→ branches`), `content_pages` (`UNIQUE (key, city_id)` с `NULLS NOT DISTINCT`), `content_home_blocks` (`→ cities`), `journal.content_versions`; `live_version_id → journal.content_versions`; FK `cover_media_id`, `rules_media_id → content_media`. Индексы живых публикаций: `(type, publish_from DESC) WHERE status = 'published'`.

## 18. Проверка

| Правило | Тест | Шаг |
|---|---|---|
| 12 приёмка 6, 7; §9.3: черновик не виден | сохранить черновик с уникальной строкой → ни один публичный маршрут K5 №207–215 её не содержит; токен предпросмотра без секрета → 404 | S4-32, S4-37, S4-42 |
| 12 §9.5, приёмка 18: версии и аудит | publish → правка → publish → rollback к v1 = v3 со снимком v1; `content_versions` только вставка (`42501`) | S4-32 |
| 12 приёмка 5, §8.5: охват | матрица §4: 3 выбора посетителя × 3 вида охвата | S4-33, S4-37 |
| 12 приёмка 16: акция истекла | `publish_to` в прошлом → нет в списке, по ссылке `state='ended'`; часовой пояс – `publish_to` – момент (UTC), в CRM вводится по зоне филиала охвата | S4-33 |
| 12 приёмка 9, §14.1: доступность игры | филиал без строки доступности → игры нет в `?branch=`; без `branch` – пометка общего каталога | S4-34 |
| 12 §10: медиа | PNG с EXIF GPS → в вариантах EXIF нет; SVG, переименованный в `.png`, → `MEDIA_TYPE_NOT_ALLOWED`; 11 МБ → 413; повтор того же файла → та же запись; архив используемого → `MEDIA_IN_USE` | S4-30 |
| 12 §15: права | Администратор публикует → 403; Директор – сетевую публикацию → 403, публикацию своего филиала – да; охват из двух филиалов, один чужой → 404 | S4-38, S4-39 |
| §6: XSS | `body` с `<script>`, `javascript:` в ссылке, `onerror` в картинке → в HTML сайта их нет | S4-41 |
| Q-81: кэш | публикация → на сайте ≤ 60 с; API недоступен → устаревший ответ ≤ 10 мин, затем 503 | S4-37, S4-110 |
