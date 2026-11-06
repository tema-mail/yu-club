# K18. Смены сотрудников, табель, ставки, управленческая зарплата

Статус: контракт Э3 (04.11.2026), черновик до ревью архитектуры (шаг S3-00). Модуль-владелец: `shifts` (`apps/api/src/modules/shifts/*`: `rates.ts`, `plan.ts`, `coverage.ts`, `attendance.ts`, `accrual.ts`, `penalties.ts`, `payroll.ts`, `payout-expense.ts`, `report.ts`, `routes.crm.ts`, `routes.payroll.ts`). Таблицы: `staff_rates`, `staff_shifts`, `staff_shift_changes`, `payroll_periods` (`0303_staff_shifts.sql`), `payroll_statements`, `payroll_penalties`, `payroll_accruals` (`0306_payroll.sql`); столбцы `staff.employment_*`, `staff.planning_status` (0303).
Основа: 05 §3–§15; 04 §5, §11; 16 §11, §14; 18 §7.2 п.1–9, §7.4; 20 §4.9, §4.11, TC-15, TC-16, TC-19; R-14, R-15; K1, K2, K3 (`staff_payroll`), K7, K8, K17 (расход выплаты).

Пометки: «по умолчанию, ждёт заказчика (Q-xx)» – умолчание плана, меняется настройкой, `MATRIX` или данными; «решение» – вывод архитектора, не пункт ТЗ.
«K17 §14» – новый раздел K17 «Связи операций кассы с объектами»: текст – K20 §11, вносит шаг S3-00.

## 1. Границы

- Расчёт – **управленческий** (05 §2): система не ведёт кадровый учёт, налоги, НДФЛ, трудовые договоры, табель СКУД и не утверждает, что сумма «к выплате» соответствует ТК РФ. На экране «Зарплата» – постоянная подпись «Управленческий расчёт, не бухгалтерия» (решение по 05 §2, §9.2).
- **Штрафы** – только как управленческая запись с причиной (05 §9.1). Вывод плана, не пункт ТЗ: в ТК РФ денежные штрафы работникам не предусмотрены (ст. 192), удержания ограничены (ст. 137); 05 §9.2 сам требует отдельной юридической проверки. До ответа юриста функция есть, но подпись «юридическая допустимость не проверена» обязательна – по умолчанию, ждёт заказчика (Q-121).
- **Сотрудник** = запись `staff` любой роли с назначением на филиал (K1 `staff_assignments`). Отдельной роли «сотрудник без CRM» нет (решение: 05 §3.1 – вход и роль из 04).
- Вне Э3: экспорт отчёта (`payroll.export`, 05 §10.7) – Э4 вместе с остальными экспортами; частичные выплаты, авансы, прочие удержания (05 §9.3, §14 «последующие»); автоматический расход при выплате (R-15).

## 2. Карточка сотрудника – дополнения Э3 (05 §3)

| Поле | Тип | Основание |
|---|---|---|
| `employment_start`, `employment_end` | `date` (по зоне Владельца не нужна – только дата) | 05 §3.1 |
| `planning_status` | `'available' \| 'on_leave'` | 05 §3.2 «Временно не работает» |
| `manager_comment` | `text` | 05 §3.1 |

- `GET /staff/{id}` отдаёт `employmentStart`, `employmentEnd`, `planningStatus`, `managerComment`; список `/staff` – нет. Комментарий читает только тот, кто вправе править этого сотрудника (иначе `null`): Директор не видит комментарий о себе.
- `staff.status` (`active / blocked / archived`) из Э0 не меняется: «Заблокирован» = `blocked`, «Уволен/архив» = `archived`. «Временно не работает» – **не статус входа**, а `planning_status = 'on_leave'` (решение: 05 §3.2 запрещает только планирование, вход не упоминает).
- `on_leave`: новые смены → `STAFF_ON_LEAVE`; уже запланированные будущие смены не отменяются, а попадают в список «требуют решения» – по умолчанию, ждёт заказчика (Q-119).
- `archived` / `blocked`: новые смены → `STAFF_NOT_ACTIVE`; прошлые смены, начисления и штрафы остаются (05 §3.2).
- Назначение на филиал – существующие `staff_assignments` с датами (Э0, 05 §3.3). Другой город – только своим явным назначением; само по себе ничего не открывает (TC-15).

## 3. Ставки (05 §4)

```ts
export interface StaffRateDto {
  id: string; staffId: string;
  validFrom: LocalDate;            // дата вступления в силу; validTo – вычисляется следующей ставкой
  hourlyKop: number;               // стоимость часа, ≥ 0, целые копейки
  attendanceFeeKop: number;        // ставка за выход, ≥ 0
  reason: string; createdBy: string; createdAt: string;
}
export function setRate(tx: Tx, ctx: AccessContext, input: { staffId; validFrom: LocalDate; hourlyKop; attendanceFeeKop; reason }, meta): Promise<{ rate: StaffRateDto; affectedShiftIds: string[] }>;
export function rateAt(db: Db | Tx, staffId: string, date: LocalDate): Promise<StaffRateDto | null>;   // null ≠ 0
```

- Действует запись с наибольшей `valid_from ≤ дата`, при равных датах – более поздняя (`created_at`, `id`); период действия – до следующей `valid_from`. Ставка общая для всех филиалов сотрудника (05 §4.3 «базовая модель»); филиальных ставок нет – по умолчанию, ждёт заказчика (05 §16 в.5, вопрос Q-62).
- Ставки не правятся и не удаляются (решение: история 05 §4.3 – только вставка, таблица в схеме `journal`). Ошибочная ставка исправляется новой записью с той же `valid_from` и ссылкой `corrects` на ошибочную – она перекрывает прежнюю по правилу выше, причина обязательна.
- **Ставка не задана** → `rateAt = null`: смена получает пометку `rate_missing`, в отчёте – «Не настроена ставка оплаты» (05 §4.4), начисление не проводится и **не считается нулём**. Владелец задаёт ставку или ставит у смены `unpaid_confirmed = true` с причиной (05 §4.4 «явно подтвердить, что смена не оплачивается»).
- Новая ставка с `validFrom` в прошлом: смены `worked` с датой ≥ `validFrom` в **открытых** периодах пересчитывает обработчик события `staff.rate_set` (§11; сторно прежнего начисления + новое, §6); смены закрытых периодов не трогаются (05 §4.3, приёмка 15). Ответ и аудит содержат список затронутых смен (`affectedShiftIds`); до обработки отчёт показывает у них пометку «пересчитывается» (решение: развязка модулей ставок и начислений, как K15 по событиям).

## 4. Смена: планирование (05 §5–§6)

```ts
export type ShiftStatus = 'planned' | 'worked' | 'no_show' | 'cancelled' | 'needs_review';   // 05 §7

export interface ShiftDto {
  id: string; staffId: string; branchId: string; timezone: string;
  localDate: LocalDate;                       // дата филиала (K8), смена не переходит через полночь (01 §4.1)
  plannedStart: string; plannedEnd: string;   // ISO UTC, [start, end)
  plannedMinutes: number;
  status: ShiftStatus;
  factStart: string | null; factEnd: string | null;
  paidMinutes: number | null;                 // факт: из времени или вручную с комментарием (05 §7.1)
  paidMinutesSource: 'fact_time' | 'manual' | null;
  flags: { rateMissing: boolean; unpaidConfirmed: boolean; outsideHours: boolean; reviewReason: string | null };
  plannedAccrualKop: number | null;           // прогноз по ставке на дату; null – ставки нет
  factAccrualKop: number | null;              // только для worked с проведённым начислением
  createdBy: string; rowVersion: number;
}

export function createShift(tx, ctx, input: { staffId; branchId; start; end; comment? }, meta): Promise<ShiftDto>;
export function updateShift(tx, ctx, shiftId, input: { rowVersion; start?; end?; branchId?; reason? }, meta): Promise<ShiftDto>;
export function cancelShift(tx, ctx, shiftId, input: { rowVersion; reason }, meta): Promise<ShiftDto>;
```

**Проверки при создании и изменении (05 §5.3, порядок – как в ответе ошибки):**

| № | Проверка | Ошибка |
|---|---|---|
| 1 | сотрудник `active` и не `on_leave` | `STAFF_NOT_ACTIVE` / `STAFF_ON_LEAVE` |
| 2 | есть действующее назначение на этот филиал на `localDate` | `STAFF_NOT_ASSIGNED` |
| 3 | `start < end`, обе границы в одних сутках филиала | `INVALID_DURATION` |
| 4 | длительность ≥ `shift.min_minutes`, если ключ задан (по умолчанию `null` – без минимума, 05 §5.5) | `SHIFT_TOO_SHORT` |
| 5 | интервал внутри открытых интервалов филиала на дату (график + исключения, network `openIntervals`); иначе – только с правом `shift.outside_hours` и пометкой `outsideHours` | `OUTSIDE_SCHEDULE` |
| 6 | нет пересечения с другой сменой этого сотрудника **в любом филиале** | `SHIFT_OVERLAP` (`details.conflictShiftId`, `details.branchId` – только если филиал в зоне смотрящего) |
| 7 | своя смена: начало не раньше чем через `shift.self_edit_deadline_hours` (24 ч) – и для создания задним числом, и для правки | `SHIFT_EDIT_DEADLINE` |
| 8 | дата не в закрытом расчётном периоде (§7) | `PAYROLL_PERIOD_CLOSED` |

- **Гарантия пересечений – база** (как K6): `EXCLUDE USING gist (staff_id WITH =, period WITH &&) WHERE (status IN ('planned','worked','needs_review'))`, интервал `[)` – стык 16:00/16:00 не конфликт (05 §5.4, приёмка 5–6). `23P01` → `SHIFT_OVERLAP`. Предварительный `SELECT` – только ради сообщения.
- **Короткие смены** (2 ч и меньше) поддерживаются без условий (05 §5.5, приёмка 7).
- **Удаление**: будущую свою смену сотрудник «удаляет» = `cancelShift` (статус `cancelled`, строка остаётся); прошедшую – только Владелец/Директор исправлением с причиной (05 §5.6). `DELETE` у `yu_app` отозван.
- **Чужая правка** (автор ≠ сотрудник смены): строка `staff_shift_changes` (было/стало, автор, время, причина обязательна) и событие `shift.changed` (§11). Сотрудник видит непрочитанные изменения в «Моё расписание» до отметки «ознакомлен» (`acknowledged_at`) – это и есть уведомление в Э3 (решение: канала push для сотрудников нет, 09 – только клиенты; push сотруднику – Э4 по событию).
- Согласования руководителем нет (05 §5.2 «до утверждения не вводить»); статус «ожидает» не вводится.

### Покрытие и пустые смены (05 §6.2–6.3)

```ts
export interface CoverageDto {
  branchId: string; date: LocalDate; timezone: string;
  open: Interval[];                         // открытые интервалы филиала (график + исключения)
  covered: Interval[]; gaps: Interval[];    // gaps = open − ∪(смены planned|worked|needs_review)
  state: 'full' | 'partial' | 'empty' | 'closed';
}
export function coverage(db, ctx, input: { branchIds: string[]; from: LocalDate; to: LocalDate }): Promise<CoverageDto[]>;   // ≤ 31 день
```

- «Пусто» = ни одного сотрудника на интервал; норматив численности не считается (05 §6.3). Два Администратора одновременно в одном филиале допустимы – по умолчанию, ждёт заказчика (Q-63).
- Наличие активного сотрудника в филиале не закрывает интервал – только смены (05 §6.2).

## 5. Факт выхода (05 §7)

```ts
export function checkIn(tx, ctx, shiftId, meta): Promise<ShiftDto>;    // сам сотрудник
export function checkOut(tx, ctx, shiftId, meta): Promise<ShiftDto>;   // сам сотрудник → worked
export function setAttendance(tx, ctx, shiftId, input:
  | { rowVersion; status: 'worked'; factStart; factEnd; reason }
  | { rowVersion; status: 'worked'; paidMinutes; reason }            // ручная длительность, комментарий обязателен (05 §7.1)
  | { rowVersion; status: 'no_show'; reason }
  | { rowVersion; unpaidConfirmed: true; reason }, meta): Promise<ShiftDto>;
```

- Кто отмечает – по умолчанию, ждёт заказчика (Q-60): **сотрудник сам** отмечает приход и уход в «Моё расписание»; Владелец и Директор (своя зона) исправляют с причиной. Приход – не раньше `shift.checkin_early_minutes` (30) до начала смены и не позже её конца; отметка за другого сотрудника `checkIn` не принимает (`FORBIDDEN`) – по умолчанию, ждёт заказчика (Q-110).
- `paidMinutes` при отметке = минуты между фактическими приходом и уходом, плановым интервалом не обрезаются (решение: 05 §7.1 – оплачивается факт; превышение плана видно в отчёте как отклонение). Округление – до минуты, без округления часов – по умолчанию, ждёт заказчика (Q-61).
- Плановая смена не становится фактом сама (05 §7, приёмка 11). Задача `shifts.review` (worker, раз в 15 мин): смена `planned`, у которой `plannedEnd + shift.review_grace_minutes (60)` прошёл, а ухода нет, → `needs_review` с причиной `no_checkout` / `no_checkin`. Невыход и отменённая смена плановую длительность не получают (05 §7.1).
- Каждое изменение факта увеличивает `fact_version` смены и публикует `shift.attendance_changed` (§11) – по нему проводится начисление (§6). Смена в закрытом периоде → `PAYROLL_PERIOD_CLOSED`; исправление – корректировкой в открытом периоде (§7).

## 6. Начисление – журнал K3 (05 §4.2, §8)

**Счёт:** у каждого сотрудника один счёт K3 `kind='staff_payroll'`, `unit='RUB_KOP'`, `owner_type='staff'`, `branch_id = NULL` (сотрудник работает в нескольких филиалах), `min_balance = NULL`. Баланс = управленческий долг клуба сотруднику. Филиал каждой записи – в `ledger_entries.branch_id` (05 §10.3: разбивка по филиалам без двойного учёта).

| Тип записи K3 | Знак | Когда | Ссылка |
|---|---|---|---|
| `payroll.accrual` | + | смена `worked`, ставка есть, не `unpaidConfirmed`: `round(paidMinutes × hourlyKop / 60)` (до копейки, половина – вверх) + `attendanceFeeKop` один раз на смену | `shift`, `refs.factVersion`, `refs.rateId`, `refs.hourlyPartKop`, `refs.feePartKop` |
| `payroll.penalty` | − | штраф (§8) | `payroll_penalty` |
| `payroll.bonus` | + | премия – **только при** `payroll.bonus_enabled = true` (по умолчанию `false`, ждёт заказчика, Q-107: в 05 премий нет) | `payroll_bonus` |
| `payroll.correction` | ± | корректировка закрытого периода в открытом периоде (§7) | `shift` / `payroll_statement` |
| `payroll.payout` | − | отметка «Выплачен» (§9) | `payroll_statement` |

- **Ставка за выход** – один раз на подтверждённую смену; при `no_show` – нет (05 §4.2, приёмка 13). Порог: смена короче `payroll.attendance_fee_min_minutes` (120) ставки за выход не получает – по умолчанию, ждёт заказчика (Q-61; 16 §11 «нельзя предполагать»). Почасовая часть – по фактическим минутам (приёмка 14).
- **Порядок блокировок (ревью 04.11):** всё, что пишет в счёт `staff_payroll` или меняет смену (отметки §5, начисление, штраф §8, корректировка, выплата §9), сначала берёт `SELECT … FOR SHARE` строки периода `payroll_periods`, в который попадает дата записи, и только потом `lockAccounts`; `closePeriod` берёт ту же строку `FOR UPDATE` – закрытие и запись не проходят «мимо» друг друга.
- Обработчик `shift.attendance_changed` (идемпотентность K4 + ключ K3 `payroll-accrual:<shiftId>:<factVersion>`): под `FOR SHARE` периода и `lockAccounts` счёта сотрудника перечитывает смену; период смены закрыт – обработчик не падает, а проводит разницу как `payroll.correction` в текущем открытом периоде со ссылкой на смену (§7); если есть живое начисление прежней версии – сторно (`reversal_of`) и новое одной проводкой; `no_show`, `cancelled`, `rate_missing`, `unpaidConfirmed` – только сторно прежнего. Доставка не по порядку: применяется состояние смены из базы, а не payload (как K15 §4).
- Прогноз (05 §8.2) **не пишется в журнал**: считается на лету по `planned` сменам и ставке на дату смены, в ответах помечен `forecast` (05 §8.2 «визуально и текстово отделён»).
- Воспроизводимость (16 §14): `Σ accrual по смене = формула(paidMinutes, ставка на дату)` – ночная сверка S3-95.

## 7. Расчётный период и закрытие (05 §8.4)

```ts
export interface PayrollPeriodDto { id: string; from: LocalDate; to: LocalDate; status: 'open' | 'closed'; closedAt: string | null; closedBy: string | null }
export function createPeriod(tx, ctx, input: { from: LocalDate; to: LocalDate }, meta): Promise<PayrollPeriodDto>;
export function closePeriod(tx, ctx, periodId, input: { reason?: string }, meta): Promise<PayrollPeriodDto>;
export function postCorrection(tx, ctx, input: { staffId; amountKop: number /* ± */; ref: { type: 'shift' | 'payroll_statement'; id }; reason }, meta): Promise<{ postingId }>;
```

- Периоды идут встык, без разрывов (`PAYROLL_PERIOD_GAP`; запись «в открытом периоде» – начало следующего существующего открытого или дата, которую покроет следующий период). Периоды – на сеть (сотрудник в нескольких филиалах), произвольные даты (05 §8.4 «владелец выбирает период»), не пересекаются: `EXCLUDE (daterange(from, to, '[]') WITH &&)`. По умолчанию CRM предлагает календарный месяц – `payroll.period_kind = 'month'`, ждёт заказчика (Q-62).
- Дата записи – локальная дата смены по зоне филиала (K8); у штрафа и премии – их дата.
- **Закрытие** (`closePeriod` – под `payroll_periods FOR UPDATE`): фиксирует итоги каждой ведомости (снимок в `payroll_statements.totals`) и запрещает любую запись K3 и изменение смены с датой в периоде – `PAYROLL_PERIOD_CLOSED`. Закрыть нельзя → `PAYROLL_PERIOD_HAS_UNRESOLVED` со списком (05 §8.3 «не включается молча»), если в периоде есть: любая смена `planned` (и идущая, и будущая – её отменяют, переносят или отмечают); смены `needs_review` или `rate_missing` без решения; смены `worked` без строки `payroll_accruals` на текущую `fact_version` (событие ещё в outbox); необработанное событие `staff.rate_set` с `affectedShiftIds` в периоде; необработанное `shift.attendance_changed` смены периода.
- **Закрытый период – только сторно и корректировки** (решение по 05 §8.4, 16 §14): открыть закрытый период нельзя; исправление – `payroll.correction` в текущем открытом периоде со ссылкой на исходную смену или ведомость и причиной (Владелец, `payroll.correct`). Сторно записи закрытого периода (`reversal_of`) проводится датой текущего открытого периода. Снимок закрытой ведомости не меняется (приёмка 15).

## 8. Штрафы и премии (05 §9)

```ts
export interface PenaltyDto { id; staffId; branchId: string | null; date: LocalDate; amountKop: number /* > 0 */; reason: string; comment: string | null;
  status: 'active' | 'cancelled'; periodId: string | null; authorId; postingId; cancelReason: string | null; replacedBy: string | null }
export function createPenalty(tx, ctx, input: { staffId; branchId?; date; amountKop; reason; comment? }, meta): Promise<PenaltyDto>;
export function cancelPenalty(tx, ctx, penaltyId, input: { reason }, meta): Promise<PenaltyDto>;                 // сторно K3
export function amendPenalty(tx, ctx, penaltyId, input: { amountKop?; reason?; comment?; why: string }, meta): Promise<PenaltyDto>;  // сторно + новый
```

- Сумма > 0, знак ставит система (05 §9.2); причина обязательна (`COMMENT_REQUIRED`). Создание – запись K3 `payroll.penalty` (минус).
- Отмена – сторно с причиной, исходная запись и её причина остаются (приёмка 17); правка суммы или причины – сторно + новый штраф со ссылкой `replacedBy`, история в аудите (05 §9.2).
- Кто ставит: Владелец и Директор своей зоны (сотрудник назначен на филиал зоны) с причиной – по умолчанию, ждёт заказчика (Q-62, R-14). У штрафа Директора филиал обязателен (`BRANCH_REQUIRED`); штраф без филиала – только Владелец.
- **Флаг** `payroll.penalties_enabled = false` до ответа Q-121: команды штрафа отвечают `FEATURE_DISABLED`. Замена по умолчанию – депремирование: снятие или уменьшение премии по положению о премировании (ТК ст. 135, 191), а не денежный штраф – ждёт заказчика (Q-153).
- Премия – та же модель (`payroll_penalties.kind = 'bonus'`, знак +), команды отвечают `FEATURE_DISABLED`, пока `payroll.bonus_enabled = false` (Q-107).
- Прочие удержания (авансы, займы, недостачи) – не вводятся (05 §9.3).

## 9. Ведомость и выплата (05 §8.1, §10.4, §11)

```ts
export type StatementStatus = 'draft' | 'calculated' | 'checked' | 'ready' | 'paid' | 'disputed';   // 05 §11; «частично выплачен» – нет
export interface PayrollStatementDto {
  id; periodId; staffId; status: StatementStatus;
  totals: { plannedShifts; workedShifts; noShows; plannedMinutes; paidMinutes;
            forecastKop; accruedKop; hourlyPartKop; feePartKop; penaltiesKop; bonusesKop; correctionsKop; toPayKop };
  byBranch: Array<{ branchId; workedShifts; paidMinutes; accruedKop }>;   // без двойного учёта: смена ровно в одном филиале
  plannedPayoutDate: LocalDate | null; actualPayoutDate: LocalDate | null;   // 05 §10.4 – два поля
  payoutComment: string | null; needsReview: Array<{ shiftId; reason }>;
  rowVersion: number;
}
export function calculateStatements(tx, ctx, periodId, meta): Promise<PayrollStatementDto[]>;   // draft → calculated, пересчёт из K3 и смен
export function setStatementStatus(tx, ctx, statementId, input: { rowVersion; status: 'checked' | 'ready' | 'disputed' | 'calculated'; comment? }, meta): Promise<PayrollStatementDto>;
export function markPaid(tx, ctx, statementId, input: { rowVersion; actualPayoutDate; comment? }, meta): Promise<PayrollStatementDto>;   // ready → paid, K3 payroll.payout
```

- `toPayKop = accrued − penalties + bonuses ± corrections` по записям K3 периода (05 §8.1). Начислено воспроизводится из смен и ставок (18 §7.4).
- `ready` и `paid` – только у ведомости **закрытого** периода (`PAYROLL_PERIOD_OPEN` иначе): выплачивать по незакрытому периоду – значит платить по итогам, которые ещё меняются.
- `toPayKop = 0` → `paid` без проводки `payroll.payout`; `toPayKop < 0` → `paid` без выплаты, минус переносится записью `payroll.correction` в следующий открытый период со ссылкой на ведомость – по умолчанию, ждёт заказчика (Q-154; ТК ст. 137 ограничивает удержания; настройка `payroll.negative_carry`).
- Переходы: `draft → calculated → checked → ready → paid`; из `calculated|checked|ready` – в `disputed` и обратно в `calculated`. `paid` – только из `ready`, только Владелец; выплата проводит `payroll.payout` на `toPayKop` (`payroll-payout:<statementId>`, повтор – тот же результат). После `paid` ведомость не меняется; ошибка – корректировкой следующего периода.
- Ведомость с `needsReview ≠ []` не переходит в `ready` (`PAYROLL_STATEMENT_NEEDS_REVIEW`).

### Расход кассы при выплате (TC-19, R-15)

```ts
export function createPayoutExpense(tx, ctx, statementId, input: { place: MoneyPlace; method: MoneyMethod; split: 'by_branch' | { branchId: string }; occurredAt; comment? }, meta):
  Promise<{ operations: FinanceOperationDto[] }>;
```

- Автоматического расхода нет: кнопка «Создать расход» с подтверждением после `paid` – по умолчанию, ждёт заказчика (Q-64 / R-15). Зарплата – расход только при фактической выплате (06 §2 п.6, K17 §4).
- Расход – K17 `recordExpense`: категория «Персонал», подкатегория «Зарплата» (посев 0202, неизменный код `salary`, 0312), `ref { type: 'staff', id: staffId }`, связь `finance_operation_links (ref_type 'payroll_statement', role 'payout_expense')` в той же транзакции (K17 §14).
- `split='by_branch'` (по умолчанию, ждёт заказчика, Q-109): по одной операции на филиал из `byBranch` пропорционально `accruedKop`, остаток копеек – филиалу с наибольшей долей; сумма операций = `toPayKop`. Иначе – одной операцией из выбранного филиала. Блокировки: **один** вызов `lockAccounts` по местам денег всех филиалов разбивки, отсортированным по id (не по одному на филиал – две выплаты с пересекающимися филиалами иначе ловят взаимную блокировку).
- **Без двойного расхода**: живая связь `payout_expense` у ведомости уже есть → `PAYOUT_EXPENSE_EXISTS` с id операций. Сторно такого расхода в кассе (K17) гасит связь, и расход можно создать заново. Ручной расход «Зарплата», внесённый в кассе раньше, можно **привязать** вместо создания (`linkPayoutExpense`, сумма должна совпасть) – тогда второго расхода нет.

## 10. Отчёт по зарплате (05 §10, без экспорта)

`GET /payroll/report?periodId=|from=&to=&cityId=&branchIds=&staffId=&role=&shiftStatus=&statementStatus=` → строки 05 §10.3, итоги 05 §10.5 (включая число пустых интервалов покрытия за период), детализация по сменам 05 §10.6. Фильтры – внутри `scopeFilter(ctx, 'payroll.view')`: Директор видит сотрудников, у которых есть смены в его зоне, и только суммы по сменам своей зоны (решение: разбивка 05 §10.3 даёт это без двойного учёта); штрафы без филиала – только Владельцу. Детализация = итог: каждая сумма строки раскрывается списком смен и записей K3 (16 §14, тест).

**ПДн зарплаты в аудите и истории (ревью 04.11):** записи аудита `payroll.*` и `staff.rate_set` (и `before/after` в них) отдаются только при `payroll.view` в зоне записи; ставки сетевых записей (без филиала) – только Владельцу; в `timeline` объектов (смена, ремонт и т.п.) суммы и ставки без права маскируются («сумма скрыта»), сам факт события виден.

## 11. События (дополняют K4)

| `type` @ver | Когда | `aggregateVersion` | Payload | Потребители |
|---|---|---|---|---|
| `shift.changed` @1 | создание, правка, отмена смены не её сотрудником | `row_version` | `{ shiftId, staffId, branchId, branchTimezone, changedBy, kind: 'created'\|'updated'\|'cancelled', before: { start, end, branchId } \| null, after: { start, end, branchId } \| null, reason }` | Э4: уведомление сотруднику (6.6); в Э3 – только запись `staff_shift_changes` |
| `shift.attendance_changed` @1 | любое изменение факта (§5) | `fact_version` | `{ shiftId, staffId, branchId, localDate, factVersion }` | shifts: начисление (§6) |
| `staff.rate_set` @1 | `setRate` | `<rateId>` | `{ rateId, staffId, validFrom, affectedShiftIds }` | shifts: пересчёт начислений открытых периодов (§3) |

Типы агрегатов – `shift`, `staff_rate` (S3-08, `core/outbox.ts`).

## 12. Права (K1, шаг S3-01)

| Действие | О | Д | А | Цель | Основание |
|---|:-:|:-:|:-:|---|---|
| `shift.view.own` | ✓ | ✓ | ✓ | свои смены | 05 §5.2 |
| `shift.plan.own` (создать, изменить, отменить свою будущую смену) | ✓ | ✓ | ✓ | branch назначения | 05 §5.1–5.2, 20 §4.9 |
| `shift.attendance.self` | ✓ | ✓ | ✓ | своя смена | Q-60 по умолчанию |
| `shift.view` (график филиала, покрытие, чужие смены без сумм) | ✓ | ✓ | ✓ | branch | 05 §6.1; Администратору – без сумм (решение: видит, кто работает) |
| `shift.manage` (чужие смены) | ✓ | ✓ | | branch | 05 §5.6; Директор – «при наличии права» = по умолчанию да в своей зоне (N-06, Q-55) |
| `shift.outside_hours` | ✓ | ✓ | | branch | 05 §5.3 «отдельное разрешение» |
| `shift.attendance.correct` | ✓ | ✓ | | branch | Q-60 по умолчанию |
| `staff.planning_status` | ✓ | ✓ | | branch назначения | 05 §3.2 |
| `payroll.view` (суммы, ведомости, отчёт) | ✓ | ✓ | | branch | 05 §10.1 «уполномоченный директор» |
| `payroll.rate.manage` | ✓ | | | network | Q-62 / R-14 |
| `payroll.penalty.manage` (создать, отменить, исправить) | ✓ | ✓ | | branch назначения сотрудника | Q-62 / R-14 |
| `payroll.bonus.manage` | ✓ | | | network | Q-107 |
| `payroll.statement.review` (`calculated`, `checked`, `disputed`) | ✓ | ✓ | | branch | решение по 05 §11 |
| `payroll.period.manage` (создать, закрыть), `payroll.statement.ready`, `payroll.payout.mark`, `payroll.correct` | ✓ | | | network | 05 §5.1 «владелец»: закрытие, выплата |
| `payroll.payout.expense` | ✓ | | | branch | Q-64 / R-15 |

Администратор своих сумм не видит (`payroll.view.own` не вводится): в 05 этого нет, «неуказанное – запрещено» – по умолчанию, ждёт заказчика (Q-108). Экспорт `payroll.export` – Э4. Директор зоны видит суммы своей зоны одинаково здесь и в отчётах Э4 (`reports.payroll.view`, цель `branch`, K24 §8) – решение техлида 04.11, подтверждение – Q-151. Делегированный `payroll.view` (Э3.4) открывает все суммы зоны права, включая коллег получателя (Q-156).

## 13. Данные (`0303_staff_shifts.sql`, `0306_payroll.sql`)

0306 также пересоздаёт CHECK `ledger_entry_type_known` (`0004_ledger.sql`) с полным списком типов + `payroll.bonus`, а `core/ledger.ts` получает `payroll.bonus` в `EntryType` и `payroll_penalty`, `payroll_bonus`, `payroll_statement`, `staff` в `RefType` (на 04.11 их нет – проверено по коду); иначе премия и ссылки §6, §9 не проходят ни компилятор, ни CHECK.

```sql
-- 0303 (shifts; столбцы staff – модуль staff, правка согласована в S3-00)
ALTER TABLE app.staff ADD COLUMN employment_start date, ADD COLUMN employment_end date,
  ADD COLUMN planning_status text NOT NULL DEFAULT 'available' CHECK (planning_status IN ('available','on_leave')),
  ADD COLUMN manager_comment text;
CREATE TABLE journal.staff_rates (id uuid PK, staff_id uuid NOT NULL → staff, valid_from date NOT NULL,
  hourly_kop bigint NOT NULL CHECK (hourly_kop >= 0), attendance_fee_kop bigint NOT NULL CHECK (attendance_fee_kop >= 0),
  corrects uuid → staff_rates, reason text NOT NULL, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX staff_rates_lookup_idx ON journal.staff_rates (staff_id, valid_from DESC, created_at DESC);
CREATE TABLE app.payroll_periods (id uuid PK, date_from date NOT NULL, date_to date NOT NULL CHECK (date_to >= date_from),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')), closed_at timestamptz, closed_by uuid,
  EXCLUDE USING gist (daterange(date_from, date_to, '[]') WITH &&), CHECK ((status = 'closed') = (closed_at IS NOT NULL)));
CREATE TABLE app.staff_shifts (id uuid PK, staff_id uuid NOT NULL → staff, branch_id uuid NOT NULL → branches,
  local_date date NOT NULL, period tstzrange NOT NULL /* [) конечные */, status text NOT NULL DEFAULT 'planned'
  CHECK (status IN ('planned','worked','no_show','cancelled','needs_review')), fact_start timestamptz, fact_end timestamptz,
  paid_minutes int CHECK (paid_minutes >= 0), paid_minutes_source text CHECK (paid_minutes_source IN ('fact_time','manual')),
  fact_version int NOT NULL DEFAULT 0, outside_hours boolean NOT NULL DEFAULT false, unpaid_confirmed boolean NOT NULL DEFAULT false,
  review_reason text, comment text, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), row_version int NOT NULL DEFAULT 1,
  CONSTRAINT staff_shifts_no_overlap EXCLUDE USING gist (staff_id WITH =, period WITH &&) WHERE (status IN ('planned','worked','needs_review')),
  CHECK (status <> 'worked' OR paid_minutes IS NOT NULL));
CREATE TABLE journal.staff_shift_changes (id bigint IDENTITY PK, shift_id uuid NOT NULL → staff_shifts, changed_by uuid NOT NULL,
  changed_at timestamptz NOT NULL, kind text NOT NULL, before jsonb, after jsonb, reason text);
CREATE TABLE app.staff_shift_change_acks (change_id bigint PK → staff_shift_changes, acknowledged_at timestamptz NOT NULL);
-- 0306 (shifts)
CREATE TABLE app.payroll_statements (id uuid PK, period_id uuid NOT NULL → payroll_periods, staff_id uuid NOT NULL → staff,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','calculated','checked','ready','paid','disputed')),
  totals jsonb NOT NULL DEFAULT '{}', planned_payout_date date, actual_payout_date date, payout_comment text,
  payout_posting_id uuid, row_version int NOT NULL DEFAULT 1, UNIQUE (period_id, staff_id),
  CHECK ((status = 'paid') = (actual_payout_date IS NOT NULL AND payout_posting_id IS NOT NULL)));
CREATE TABLE app.payroll_penalties (id uuid PK, kind text NOT NULL CHECK (kind IN ('penalty','bonus')), staff_id uuid NOT NULL → staff,
  branch_id uuid → branches, local_date date NOT NULL, amount_kop bigint NOT NULL CHECK (amount_kop > 0), reason text NOT NULL,
  comment text, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')), posting_id uuid NOT NULL,
  cancel_posting_id uuid, cancel_reason text, replaced_by uuid → payroll_penalties, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE journal.payroll_accruals (id bigint IDENTITY PK, shift_id uuid NOT NULL → staff_shifts, fact_version int NOT NULL,
  ledger_entry_id bigint NOT NULL → ledger_entries, rate_id uuid → staff_rates, hourly_part_kop bigint NOT NULL, fee_part_kop bigint NOT NULL,
  UNIQUE (shift_id, fact_version));
```

`REVOKE DELETE` на все таблицы; `journal.*` – только вставка (0001). Удалений нет: отмена = статус + сторно.

Уточнения при реализации (решения D3-S1…D3-S7, `docs/reshenia.md`): в 0306 CHECK ведомости – `(status = 'paid') = (actual_payout_date IS NOT NULL)`, `payout_posting_id` у `paid` может быть пуст (§9: `toPayKop ≤ 0`); `payroll_accruals.ledger_entry_id` пуст при нулевой сумме.

## 14. API CRM (дополняет K11; номера Э3 – 3xx)

| # | Метод и путь | Право | Успех |
|---|---|---|---|
| 301 | `GET /shifts?branchIds=&staffId=&from=&to=&status=` | `shift.view` / `shift.view.own` | `200 { items: ShiftDto[] }` (≤ 31 день); без `payroll.view` – `plannedAccrualKop`, `factAccrualKop` = `null`. В чтениях (этот список и `GET /shifts/{id}`) есть `staffName` – имя и фамилия: Администратор видит, кто работает (§12), без контактов и ставок |
| 302 | `POST /shifts` | `shift.plan.own` (сам) / `shift.manage` | `201 ShiftDto` |
| 303 | `PATCH /shifts/{id}` | то же | `200 ShiftDto` |
| 304 | `POST /shifts/{id}/cancel` | то же | `200` |
| 305 | `POST /shifts/{id}/check-in`, `/check-out` | `shift.attendance.self` | `200` |
| 306 | `POST /shifts/{id}/attendance` | `shift.attendance.correct` | `200` |
| 307 | `GET /shifts/coverage?branchIds=&from=&to=` | `shift.view` | `200 CoverageDto[]` |
| 308 | `GET /me/shift-changes?unread=true`, `POST /me/shift-changes/{id}/ack` | `shift.view.own` | `200` |
| 309 | `GET /staff/{id}/rates`, `POST /staff/{id}/rates` | `payroll.view` / `payroll.rate.manage` | `200` / `201 { rate, affectedShiftIds }` |
| 310 | `PATCH /staff/{id}/planning` | `staff.planning_status` | `200 { planningStatus, rowVersion, futureShiftsNeedingDecision: ShiftDto[] }` |
| 311 | `GET /payroll/periods`, `POST /payroll/periods`, `POST /payroll/periods/{id}/close` | `payroll.view` / `payroll.period.manage` | `200` / `201` |
| 312 | `POST /payroll/periods/{id}/calculate` | `payroll.statement.review` | `200 PayrollStatementDto[]` |
| 313 | `GET /payroll/statements/{id}`, `POST /payroll/statements/{id}/status` | `payroll.view` / по статусу | `200` |
| 314 | `POST /payroll/statements/{id}/paid` | `payroll.payout.mark` | `200` |
| 315 | `POST /payroll/statements/{id}/payout-expense`, `POST .../payout-expense/link` | `payroll.payout.expense` | `201 { operations }`; link: операция не подкатегории `salary` – `422 OPERATION_LINK_INVALID` (`reason: 'category'`) |
| 316 | `GET /payroll/penalties?staffId=&periodId=`, `POST /payroll/penalties`, `POST /payroll/penalties/{id}/cancel`, `POST /payroll/penalties/{id}/amend` | `payroll.view` / `payroll.penalty.manage` | `200` / `201` |
| 317 | `POST /payroll/corrections` | `payroll.correct` | `201` |
| 318 | `GET /payroll/report?...` | `payroll.view` | `200` (§10) |
| 319 | `PATCH /staff/{id}/employment` `{ rowVersion, employmentStart?, employmentEnd?, managerComment? }` | как правка карточки (K1 `assertCanManageStaff`, `update_profile`) | `200 { rowVersion }` (ответ хранится в идемпотентности, ПДн в него не кладём; значения – из `GET /staff/{id}`); аудит `staff.employment_changed`, значения маскируются (K2 `PD_KEYS`) |

Изменяющие – `Idempotency-Key` обязателен; карточки – `rowVersion`. Объект вне зоны – `404`.

## 15. Ошибки

| Код | HTTP | Когда |
|---|---|---|
| `STAFF_NOT_ACTIVE`, `STAFF_ON_LEAVE` | 409 | сотрудник заблокирован/архив; временно не работает |
| `STAFF_NOT_ASSIGNED` | 422 | нет действующего назначения на филиал на дату (12.5 «сотрудник не назначен») |
| `SHIFT_OVERLAP` | 409 | пересечение со своей сменой в любом филиале (TC-15) |
| `SHIFT_TOO_SHORT` | 422 | меньше `shift.min_minutes` (если задан) |
| `OUTSIDE_SCHEDULE` | 409 | вне графика филиала без права `shift.outside_hours` (общий код K5) |
| `SHIFT_EDIT_DEADLINE` | 409 | своя смена ближе срока `shift.self_edit_deadline_hours` |
| `SHIFT_NOT_EDITABLE` | 409 | прошедшая смена сотрудником; `worked` без `shift.attendance.correct` |
| `CHECKIN_WINDOW` | 409 | приход раньше окна или после конца смены |
| `PAYROLL_PERIOD_CLOSED` | 409 | изменение в закрытом периоде |
| `PAYROLL_PERIOD_OVERLAP` | 409 | новый период пересекает существующий |
| `PAYROLL_PERIOD_GAP` | 409 | новый период оставляет разрыв (`details.expectedFrom`) или корректировку перед первым (`details.date`) |
| `PAYROLL_PERIOD_HAS_UNRESOLVED` | 409 | закрытие при `needs_review` / `rate_missing`, смене `worked` без начисления на текущую `fact_version`, необработанном `staff.rate_set` (`details.shiftIds`, `details.rateIds`) |
| `PAYROLL_PERIOD_OPEN` | 409 | `ready` / `paid` у ведомости незакрытого периода |
| `BRANCH_REQUIRED` | 422 | штраф Директора без филиала |
| `PAYROLL_STATEMENT_NEEDS_REVIEW` | 409 | `ready` при нерешённых сменах |
| `PAYOUT_EXPENSE_EXISTS` | 409 | второй расход на ту же выплату (TC-19) |
| `PAYOUT_AMOUNT_MISMATCH` | 422 | привязка расхода с другой суммой |
| `OPERATION_ALREADY_LINKED` | 409 | привязываемый расход уже связан с другим объектом (K17 §14) |
| `FEATURE_DISABLED` | 409 | премия или штраф при выключенном флаге (`payroll.bonus_enabled`, `payroll.penalties_enabled`) |
| `COMMENT_REQUIRED` | 422 | причина у штрафа, ручных минут, чужой правки, корректировки (общий код K11) |

## 16. Настройки (K7, шаг S3-01; уровень – сеть, меняет Владелец, D2-02)

| Ключ | Тип | По умолчанию | Основание |
|---|---|---|---|
| `shift.min_minutes` | `int \| null` 15..720 | `null` | 05 §5.5 |
| `shift.self_edit_deadline_hours` | int 0..168 | 24 | Q-65 |
| `shift.checkin_early_minutes` | int 0..240 | 30 | Q-110 |
| `shift.review_grace_minutes` | int 0..720 | 60 | решение |
| `payroll.attendance_fee_min_minutes` | int 0..720 | 120 | Q-61 |
| `payroll.bonus_enabled` | boolean | false | Q-107 |
| `payroll.penalties_enabled` | boolean | false | Q-121, Q-153 |
| `payroll.negative_carry` | `'carry' \| 'write_off'` | `'carry'` | Q-154 |
| `payroll.period_kind` | `'month' \| 'half_month' \| 'week'` | `'month'` | Q-62 (только подсказка CRM) |

## 17. Проверка (приёмка 05 §15, TC-15, TC-16, TC-19, 18 §7.4)

- TC-15: Администратор назначен на филиалы А и Б одного города: А 10:00–16:00 + Б 16:00–21:00 – обе; Б 15:00–21:00 – `SHIFT_OVERLAP`; 50 параллельных создания пересекающихся смен одного сотрудника в двух филиалах → одна (база); филиал В другого города без назначения – `STAFF_NOT_ASSIGNED` и `404` на его график.
- Короткая смена 2 ч: факт 2 ч → почасовая часть за 120 мин + ставка за выход (05 §4.2); 1 ч 59 мин → без ставки за выход при пороге 120.
- Плановая смена без отметки не даёт начисления; через `review_grace` → `needs_review`.
- Ставка не задана → «Не настроена ставка», начисления нет, период не закрывается; «не оплачивается» с причиной – закрывается.
- Новая ставка задним числом пересчитывает только открытые периоды; снимок закрытой ведомости тот же (приёмка 15).
- Двойная доставка `shift.attendance_changed` и доставка в обратном порядке → одно живое начисление на смену; `Σ accrual = формула` (ночная сверка).
- Штраф без причины – `COMMENT_REQUIRED`; отмена сохраняет исходную запись и причину (приёмка 16–17).
- TC-19: `paid` → один `payroll.payout`; двойное нажатие «Создать расход» → одна связь и операции на `toPayKop`; второй вызов – `PAYOUT_EXPENSE_EXISTS`; сторно расхода в кассе → расход можно создать заново; сводка кассы K17 и ведомость сходятся.
- TC-16: Директор зоны {А} не видит смен и сумм филиала Б, не меняет ставки (`FORBIDDEN`), штраф сотруднику только филиала Б – `404`.
- Аудит каждой команды (05 §13): `shift.created/updated/cancelled`, `shift.attendance_set`, `staff.rate_set`, `staff.planning_changed`, `staff.employment_changed`, `payroll.period.created/closed`, `payroll.statement.status_changed`, `payroll.paid`, `payroll.penalty.created/cancelled/amended`, `payroll.correction.posted`, `payroll.payout_expense.created/linked`.
