# K2. Событие аудита

Модуль: `apps/api/src/core/audit.ts`. Таблица: `audit_events` (model-dannyh 0003). Шаг: S0-06. Потребители: все модули; CRM «Хронология» (16 §16), фильтры аудита (04 §11.5).
Основа: 04 §11.2–11.6; 16 §16; 17 §7.5.

## Типы и функции

```ts
export type AuditSource = 'crm' | 'site' | 'account' | 'system' | 'cli';
export type AuditResult = 'success' | 'denied' | 'error';

export interface AuditInput {
  action: AuditAction;                 // код из реестра ниже
  object: { type: AuditObjectType; id: string | null };
  branchId?: string | null;            // если у объекта есть филиал – обязателен (04 §8.1)
  cityId?: string | null;
  before?: unknown;                    // JSON-совместимое; маскируется до записи
  after?: unknown;
  reason?: string | null;              // обязательная причина/комментарий, если правило её требует
  result?: AuditResult;                // по умолчанию 'success'
}

export interface AuditRequestMeta {    // из контекста запроса Fastify
  actor: Actor;                        // K1
  access?: AccessContext;              // для staff: роль и снимок зоны на момент действия
  source: AuditSource;
  requestId: string;
  ip?: string;
}

/** В ТОЙ ЖЕ транзакции, что и изменение (успех фиксируется вместе с фактом). */
export function writeAudit(tx: Tx, meta: AuditRequestMeta, input: AuditInput): Promise<void>;

/** Отдельная транзакция (основная откатилась): отказ в доступе или ошибка. Без before/after. */
export function writeDenied(db: Db, meta: AuditRequestMeta, input: Omit<AuditInput, 'before' | 'after'> & { result: 'denied' | 'error' }): Promise<void>;

/** Маскирование до записи, на любой глубине, имена ключей без учёта регистра:
 *  - SECRET_KEYS → '***' (значение не сохраняется вовсе);
 *  - PD_KEYS (ПДн, 152-ФЗ) → маска по типу: телефон '+7******4567', email 'i***@domain', ФИО – первая буква + '***',
 *    дата рождения – '****-**-**'. В аудите остаётся ИМЯ поля и факт изменения, не значение.
 *  Правило по явному списку ключей, не по угадыванию содержимого. Экспортируется для тестов. */
export function redact(value: unknown): unknown;
export const PD_KEYS: Readonly<Record<string, 'phone' | 'email' | 'name' | 'date'>> = {
  phone: 'phone', phoneE164: 'phone', guestPhone: 'phone',
  email: 'email',
  firstName: 'name', lastName: 'name', guestName: 'name',
  birthDate: 'date',
};
// Новое поле с ПДн в карточке = строка в PD_KEYS того же коммита (ревью проверяет).
export const SECRET_KEYS: readonly string[] = [
  'password', 'passwordHash', 'otp', 'otpCode', 'codeHash', 'token', 'tokenHash', 'secret',
  'totpSecret', 'p256dh', 'auth', 'apiKey', 'authorization', 'cookie',
];
// 'code' в список НЕ входит: это обычное поле (branch.code, city.code). Тело запроса входа (K9, поле `code`)
// в аудит не передаётся никогда – только факт входа/отказа.

/** Хронология объекта в пределах прав (16 §16): фильтр по scopeFilter(ctx, 'audit.view'). */
export function objectTimeline(db: Db, ctx: AccessContext, object: { type: AuditObjectType; id: string }, page: Cursor): Promise<Page<AuditEventView>>;
```

Запись: `actor_type/actor_id` из `meta.actor`; `actor_role` и `actor_scope` – из `meta.access` (снимок `{network}` или `{cityIds, branchIds}`); для `client`/`visitor`/`system` роль `NULL`. `visitor` пишется как `actor_type = 'anonymous'`.

`before`/`after` – только изменённые поля (`diff`), не весь объект (решение: меньше ПДн в журнале).

## Реестр действий (04 §11.3)

| Группа | `action` | `object.type` |
|---|---|---|
| Доступ | `auth.staff.login`, `auth.staff.login_failed`, `auth.staff.logout`, `auth.staff.sessions_ended`, `auth.client.login`, `auth.client.login_failed`, `auth.client.logout` | `staff` / `client` |
| Доступ | `staff.blocked`, `staff.unblocked`, `staff.contacts_changed`, `staff.role_changed`, `staff.scope_changed`, `staff.created` | `staff` |
| Структура | `city.created`, `city.updated`, `city.archived`, `branch.created`, `branch.updated`, `branch.archived`, `branch.status_changed`, `branch.hours_changed`, `calendar.exception_created`, `calendar.exception_cancelled` | `city` / `branch` / `calendar_exception` |
| Структура | `staff.assignment.created`, `staff.assignment.changed`, `staff.assignment.revoked` | `staff_assignment` |
| Ресурсы | `space.*`, `room.*`, `resource.*` (`created`/`updated`/`archived`), `resource.composition_changed` | `space` / `room` / `resource` |
| Брони | `booking.created`, `booking.cancelled`, `booking.rescheduled`, `booking.updated` (комментарий) | `booking` |
| Брони | `visit.marked`, `visit.completed`, `visit.reverted`, `no_show.marked`, `no_show.reverted` | `booking` (решение: хронология брони одна) |
| Брони | `hold.expired` (системное, 04 §11.3 «завершение предварительного удержания») | `hold` |
| Блокировки | `block.created`, `block.lifted`, `block.updated` | `resource_block` |
| Клиенты | `client.created`, `client.updated`, `client.status_changed`, `client.merged`, `client.consent_changed`, `client.notification_prefs_changed` | `client` |
| Настройки | `setting.changed`, `setting.reset_to_inherited`, `dictionary.changed`, `tariff.created`, `tariff.updated`, `tariff.archived` | `setting` / `dictionary` / `tariff` |
| Уведомления | `notification.sent`, `notification.failed`, `notification.skipped` (системные, результат отправки) | `notification` |
| Уведомления | `notification.push_subscribed`, `notification.push_unsubscribed` (клиент в ЛК; endpoint – только маска хоста, ключи не пишутся) | `client` |
| Экспорт | `export.created` | `export` |
| Деньги (Э2, S2-02) | `payment.recorded`, `payment.refunded` | `payment` |
| Деньги (Э2, S2-02) | `finance.operation.created`, `finance.operation.reversed`, `finance.operation.corrected`, `finance.category.created`, `finance.category.updated`, `finance.category.archived`, `finance.period.closed` | `finance_operation` / `finance_category` / `branch` |
| Деньги (Э2, S2-02) | `cash_shift.opened`, `cash_shift.closed`, `cash_shift.resolved` | `cash_shift` |
| Журнал K3 (Э2, S2-02) | `ledger.posted`, `ledger.reversed` (пишет модуль-потребитель, K3 правило 6) | `ledger_posting` |
| Баллы (Э2, S2-03) | `loyalty.adjusted`, `loyalty.booked_below_limit`, `loyalty.issue.created`, `loyalty.issue.resolved`, `loyalty.reserve.created`, `loyalty.reserve.released`, `loyalty.goods.created`, `loyalty.goods.updated`, `loyalty.goods.archived`, `loyalty.goods.issued`, `loyalty.goods.returned` (начисления, штрафы, списания – через `ledger.*`) | `client` / `booking` / `loyalty_goods` |
| Сертификаты (Э2, S2-04) | `certificate.sold`, `certificate.redeemed`, `certificate.redemption_returned`, `certificate.expired`, `certificate.cancelled`, `certificate.corrected`, `certificate.review_changed`, `certificate.recipient_changed`, `certificate.pin_reissued`, `certificate.pin_locked` (код и его хэш не пишутся) | `certificate` |
| Э3 | `repair.*`, `shift.*` | – |
| Уведомления Э4 (S4-05; K21 §14) | `notification.campaign_created`, `notification.campaign_updated`, `notification.campaign_confirmed` (`after`: категория, текст шаблона без подстановки, описание аудитории, `total`), `notification.campaign_cancelled` (причина), `notification.retried`, `notification.template_created`, `notification.template_updated`, `notification.template_archived` | `notification_campaign` / `notification` / `notification_template` |
| Уведомления Э4 (S4-05; K21 §11 №206) | `notification.unsubscribed` – отписка по ссылке без входа: актор `client` (из токена), `source = 'site'`, `after.via = 'unsubscribe_link'` (решение S4-00: отдельного значения `AuditSource` не вводим – CHECK и тип источника Э0 не меняются) | `client` |
| Контент Э4 (S4-03; K22 §16) | `content.draft_saved` (только список изменённых полей), `content.published` (`after`: номер версии), `content.unpublished` (причина), `content.archived`, `content.rolled_back` (из какой версии), `content.availability_changed` | `publication` / `game` / `room_page` / `branch_page` / `content_page` / `home_block` |
| Медиа Э4 (S4-03; K22 §8, §16) | `media.uploaded`, `media.updated`, `media.archived`, `media.purged` (основание, затронутые сущности), `media.deleted` (физическое удаление неиспользованного, K11 №227 – добавлено S4-00: команда без аудита не проходит правило 1) | `media` |
| Отчёты Э4 (S4-04; K24 §5, §7) | `export.requested` (отчёт, фильтры, формат, `detail`, маска да/нет), `export.downloaded`, `export.failed`, `export.cancelled` (K11 №247 – добавлено S4-00), `client.searched` (поиск CRM по телефону; номер – в поле `phone`, маскируется `redact` по `PD_KEYS`) | `export` / `client` |

Типы объектов Э4 (`AUDIT_OBJECT_TYPES`, S4-02): `notification_campaign`, `notification_template`, `publication`, `game`, `room_page`, `branch_page`, `content_page`, `home_block`, `media`. Коды Э4 регистрируют модули-владельцы: `notifications/audit.ts`, `content/audit.ts`, `reports/audit.ts` (в том числе `client.searched` – его пишет `reports/search.ts`).

Новый код действия добавляется только правкой этого реестра.

## Правила

1. Аудит – часть команды: успешная команда без `writeAudit` не проходит ревью. Тест модуля проверяет запись аудита.
2. Секреты не пишутся ни в `before/after`, ни в `reason` (04 §11.2): тест S0-06 кладёт `{password:'x', otpCode:'1234', nested:{token:'t'}}` и ждёт `***`, а `{code:'NSK-1'}` – без изменений.
3. Роль `yu_app` не может `UPDATE`/`DELETE` (тест: обе операции падают с `42501`).
4. Срок хранения – не задаём, удаления нет (04 §11.6). Срок хранения `ip` и `user_agent` (аудит, сессии) – вопрос юристу заказчика вместе с N-01; до ответа храним, в выдаче CRM IP показываем только Владельцу (решение). Передать в `voprosy-zakazchiku.md` – правит оркестратор.
5. Выдача аудита пользователю – через `scopeFilter(ctx, 'audit.view')`; Администратору – `audit.view.own` (`actor_id = свой`).

## Ошибки

Запись аудита упала → падает вся команда (`INTERNAL`, 500): факт без аудита недопустим (решение). Исключение – `writeDenied`: её сбой только логируется, ответ отказа уходит как есть.
