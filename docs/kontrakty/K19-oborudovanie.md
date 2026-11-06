# K19. Оборудование, инвентаризация, ремонт

Статус: контракт Э3 (04.11.2026), черновик до ревью архитектуры (шаг S3-00). Модуль-владелец: `equipment` (`apps/api/src/modules/equipment/*`: `items.ts`, `placement.ts`, `accounts.ts`, `repairs.ts`, `repair-blocks.ts`, `repair-close.ts`, `executors.ts`, `repair-expense.ts`, `routes.crm.ts`, `routes.repairs.ts`). Таблицы: `equipment_categories`, `equipment_items`, `equipment_placements`, `equipment_accounts` (`0304_equipment.sql`), `repair_executors`, `repairs`, `repair_status_history`, `repair_blocks`, `equipment_warranties` (`0307_repairs.sql`). Вложения – общие `attachments` (`0302_attachments.sql`, §9).
Основа: 10 §2–§17; 02 §9–§11; 01 §13; 16 §12, §14; 18 §7.2 п.10–14, §7.4; 20 §4.2, §5 «Ремонт», TC-12; Q-50…Q-54, R-01, R-14; K1, K2, K4, K6 (блокировки), K7, K17 (расход), K3.

Пометки: «по умолчанию, ждёт заказчика (Q-xx)» – умолчание плана; «решение» – вывод архитектора.
«K17 §14» – новый раздел K17 «Связи операций кассы с объектами»: текст – K20 §11, вносит шаг S3-00.

## 1. Главные решения

1. **Статус оборудования не управляет доступностью.** Доступность ресурсов меняет только блокировка K6 (`createBlock`), которую **подтверждает сотрудник** (10 §6.2). Смена статуса оборудования или регистрация поломки только **предлагает** блокировку с готовой целью и периодом. Исключение – флаг `equipment.critical_auto_block` (по умолчанию `false`, ждёт заказчика, Q-111): при `true` критическая неисправность создаёт блокировку сама (10 §6.2 «если не настроено правило»).
   Почему: блокировка даёт то, чего нет у статуса, – период, список затронутых броней и аудит (01 §13, TC-12); автоматический пересчёт по статусу (02 §9.3, §11) молча снимал бы ресурс с продажи без решения о бронях, что запрещают 10 §6.2, 16 §12 и 18 §7.4 «существующие брони не отменяются автоматически».
2. **Статус ресурса (`resources.status = 'repair'`) ремонт не трогает** (решение): `RESOURCE_UNAVAILABLE` отрезал бы ресурс без периода и без списка броней. Колонка остаётся для ручного вывода ресурса из работы (02 §7.3).
3. **Оборудование привязано к единице занятости, а не к ресурсу** (решение по K6): единица (`VR1`) – физическое место; ресурс («VR-место 1», «VR-комната целиком») – то, что продаётся. Блокировка единицы `VR1` сама закрывает и «VR-место 1», и «комнату целиком», а «VR-место 2» остаётся свободным (10 §12.1, приёмка 16). Общий компонент комнаты (телевизор, роутер) привязан к **комнате** → блокировка комнаты. Это и есть «зависимости в справочнике» 10 §12.1: они уже лежат в составе ресурсов K6, отдельной таблицы зависимостей нет.
4. **Расход на ремонт – одна операция кассы K17, связанная с ремонтом через `finance_operation_links`** (K17 §14); второй связи у операции быть не может (PK по `operation_id`) – двойного учёта нет ни между ремонтами, ни с мероприятием или зарплатой (10 §9.1, §9.3, приёмка 18).

## 2. Единый список статусов оборудования (расхождение 02 §9.3 / 10 §4.3 – решение, Q-50)

| Код | Подпись | Из 02 §9.3 | Из 10 §4.3 | Может стоять в единице/комнате | Предлагает блокировку |
|---|---|---|---|---|---|
| `in_service` | В эксплуатации | «В эксплуатации», «Доступно» | «В эксплуатации» | да | нет |
| `reserve` | В резерве | «В наличии» | «В резерве» | нет (склад филиала) | – |
| `diagnostics` | На диагностике | да | да | да | да |
| `repair` | В ремонте | да | да | да | да |
| `awaiting_parts` | Ожидает запчастей | да | нет (в 10 – статус ремонта) | да | да |
| `unavailable` | Временно недоступно | нет | да | да | да |
| `written_off` | Списано | да | да | нет, навсегда | – |
| `lost` | Утеряно | да | да | нет | – |

- «Доступно» из 02 – не статус, а вычисление: `in_service` + единица без активной блокировки (решение; 02 §9.3 «согласовываться с состоянием ресурса» – так и выполняется).
- «В наличии» из 02 = «В резерве» из 10 (учтено, в услуге не используется).
- Переходы: из любого, кроме `written_off`, в любой; `written_off` – конечный (10 §4.3: не назначается на активный ресурс, не удаляется); `lost → in_service` – только Владелец с причиной (нашлось). Каждая смена – `equipment.status_changed` в аудите, причина обязательна для `written_off`, `lost`, `unavailable`.
- Статусы ремонта переводят оборудование автоматически (это не доступность, а карточка): `diagnostics` → «На диагностике», `in_repair` → «В ремонте», `awaiting_parts` → «Ожидает запчастей»; итоговый статус при закрытии выбирает сотрудник (10 §13.5).
- Подписи – в `dict_statuses` (15 §16: системный код неизменен, подпись меняется).

## 3. Карточка (10 §3, §13.2)

```ts
export interface EquipmentDto {
  id: string;
  inventoryNumber: string;          // 'INV-000123' – генерирует система, UNIQUE по сети (10 §3.1)
  legacyNumber: string | null;      // прежний номер клуба, если вёлся (02 §9.1, Q-51)
  name: string; categoryId: string;
  manufacturer: string | null; model: string | null;
  serialNumber: string | null;      // заводской; может отсутствовать (10 §3.1)
  parentId: string | null;          // компонент → родитель (10 §3.3); глубина ≤ 3
  purchaseDate: LocalDate | null; purchaseCostKop: number | null;   // «если ведётся» (10 §18 п.1)
  commissionedOn: LocalDate | null;
  status: EquipmentStatus; statusReason: string | null;
  placement: { branchId: string; roomId: string | null; unitId: string | null; since: string };   // текущее (§4)
  openRepairsCount: number;
  warrantyUntil: LocalDate | null;  // ближайшая действующая гарантия (§8)
  lastRepairAt: string | null;
  comment: string | null; rowVersion: number;
}
export function createEquipment(tx, ctx, input: { name; categoryId; branchId; roomId?; unitId?; manufacturer?; model?; serialNumber?; legacyNumber?; parentId?; purchaseDate?; purchaseCostKop?; commissionedOn?; status?: 'in_service' | 'reserve'; comment? }, meta): Promise<EquipmentDto>;
export function updateEquipment(tx, ctx, id, input: { rowVersion; ...поля карточки, кроме размещения и статуса }, meta): Promise<EquipmentDto>;
export function setEquipmentStatus(tx, ctx, id, input: { rowVersion; status; reason? }, meta): Promise<{ equipment: EquipmentDto; blockProposal: BlockProposal | null }>;
```

- **Инвентарный номер** – последовательность сети `equipment_inventory_seq`, формат `INV-` + 6 цифр; не меняется (10 §3.1, Q-51). Правка `legacyNumber`, `serialNumber`, `purchaseCostKop` – право `equipment.financial.edit` (Владелец; 10 §14 «не может менять инвентарные/финансовые данные»), изменение серийного номера – отдельный код аудита `equipment.serial_changed` (10 §14).
- **Серийный номер не уникален жёстко** (решение: у разных производителей совпадают): дубль в той же категории и модели → предупреждение `details.duplicateOf` в ответе, сохранение не блокируется.
- **Разные серийные номера – разные карточки** (10 §3.3); компонент наследует размещение родителя при перемещении родителя (одна операция, история у каждого).
- **Категории** – справочник Владельца, архив вместо удаления (10 §3.2); посев 0304 – список 10 §3.2 как предложение (утверждение – вопрос в 6.5.3 плана).
- Пароли не хранятся: полей для секрета нет ни в карточке, ни в учётках (§5); комментарии – свободный текст, сотрудник предупреждён подписью формы (10 §5.3).

## 4. Размещение и перемещение (10 §4, 02 §10)

```ts
export function moveEquipment(tx, ctx, id, input: {
  rowVersion; to: { branchId: string; roomId?: string | null; unitId?: string | null }; at: string; reason: string;
  acknowledgeBookings?: boolean;           // сотрудник видел список и берёт решение на себя
}, meta): Promise<{ equipment: EquipmentDto; affectedBookingIds: string[]; blockProposal: BlockProposal | null }>;
```

- Размещение – строка `equipment_placements (item, branch, room?, unit?, placed_at, removed_at)`; текущее – `removed_at IS NULL`, одно на единицу оборудования (`UNIQUE (item_id) WHERE removed_at IS NULL`). Перемещение закрывает текущую строку и вставляет новую в одной транзакции; карточку нельзя «перепрописать» правкой (10 §4.2).
- `unitId` и `roomId` должны принадлежать `branchId` (составной FK, как `occupancy`). `written_off`, `lost`, `reserve` в единицу/комнату не ставятся → `EQUIPMENT_NOT_PLACEABLE`.
- **Будущие брони** (02 §10): если оборудование уходит из единицы (или комнаты), на которой есть живые брони, удержания **или мероприятия** с `end > at`, команда без `acknowledgeBookings` отвечает `EQUIPMENT_MOVE_HAS_BOOKINGS` со списками `bookingIds` и `eventIds` (K6 провайдер booking `bookingsOnUnits`, S3-09). Мероприятия приходят из занятости `occupancy.source_type = 'event'` → `event_resources` → событие; сейчас `affected()` в `booking/blocks.ts:58–71` их не выбирает (только `booking` и `hold_item`) – S3-09 добавляет ветку (ревью 04.11). С `acknowledgeBookings: true` перемещение проводится, **брони не трогаются**, список и автор пишутся в аудит, ответ содержит `blockProposal` на освободившуюся единицу (решение: 02 §10 «не лишать автоматически… решение и его автор фиксируются»).
- Перемещение между филиалами – право `equipment.move` в зоне **обоих** филиалов (иначе `404`).

## 5. Учётные записи PS/VR (10 §5)

```ts
export interface EquipmentAccountDto {
  id; platform: 'playstation' | 'meta' | 'other'; displayName: string;   // идентификатор/имя, не пароль
  equipmentId: string | null; branchId: string; status: 'active' | 'ended';
  boundFrom: LocalDate; boundTo: LocalDate | null; accessHint: string | null;   // «где взять доступ», 10 §5.3
  comment: string | null;
}
export function bindAccount(tx, ctx, input: { platform; displayName; equipmentId; branchId; boundFrom; accessHint?; comment? }, meta): Promise<EquipmentAccountDto>;
export function rebindAccount(tx, ctx, accountId, input: { equipmentId: string | null; at: LocalDate; reason }, meta): Promise<{ ended: EquipmentAccountDto; current: EquipmentAccountDto | null }>;
```

- Пароли и коды не хранятся – по умолчанию, ждёт заказчика (Q-53); защищённого хранилища в Э3 нет (10 §5.3 «для первой версии достаточно идентификатора»).
- Переназначение закрывает прежнюю связь (`boundTo`, причина) и создаёт новую (10 §5.4).
- Видят учётки Владелец и Директор; Администратор – нет (Q-54), ответы карточки для него без вкладки и без `accounts`.

## 6. Ремонтное событие (10 §6–§8, §13.3–13.5)

```ts
export type RepairStatus = 'new' | 'diagnostics' | 'awaiting_approval' | 'planned' | 'in_repair' | 'awaiting_parts'
  | 'done_pending_check' | 'closed' | 'cancelled';   // 10 §7, 9 статусов
export type RepairPriority = 'critical' | 'high' | 'medium' | 'low';   // 10 §6.3

export interface RepairDto {
  id: string; number: string;                  // 'R-000123', последовательность сети
  equipmentId: string; branchId: string; roomId: string | null; unitId: string | null;   // снимок места на момент регистрации
  brokenAt: string | null; brokenAtUnknown: boolean; detectedAt: string; registeredAt: string;   // 10 §7.1 – три даты
  reportedBy: { staffId: string | null; name: string | null };
  symptoms: string;                            // первоначальное описание, не перезаписывается (10 §7.2)
  priority: RepairPriority; impact: 'none' | 'partial' | 'full';
  status: RepairStatus;
  diagnostics: string | null; cause: string | null; worksDone: string | null; partsUsed: string | null; conclusion: string | null;
  plan: { works: string | null; start: LocalDate | null; end: LocalDate | null; costKop: number | null;
          responsibleStaffId: string | null; partsNeeded: boolean; comment: string | null };   // 10 §7.3 – отдельно от факта
  executor: { id: string | null; snapshot: ExecutorSnapshot | null };   // 10 §8.3 – реквизиты на момент работ
  approval: { required: boolean; approvedBy: string | null; approvedAt: string | null };
  actualCostKop: number | null; noCost: boolean; completedAt: string | null;
  finalEquipmentStatus: EquipmentStatus | null; acceptedBy: string | null;
  previousRepairId: string | null;             // повтор (10 §10.2)
  blocks: Array<{ blockId: string; active: boolean; period: Interval; liftedAt: string | null }>;
  payment: { paidKop: number; status: 'unpaid' | 'partially_paid' | 'paid' | 'overpaid' | 'no_cost'; lastPaidAt: string | null; operationIds: string[] };
  rowVersion: number;
}
export function registerRepair(tx, ctx, input: { equipmentId; detectedAt; brokenAt?; brokenAtUnknown?; symptoms; priority; impact; reportedByName?; previousRepairId? }, meta):
  Promise<{ repair: RepairDto; blockProposal: BlockProposal | null; autoBlock: { blockId; affectedBookingIds } | null }>;
export function updateRepair(tx, ctx, id, input: { rowVersion; diagnostics?; cause?; worksDone?; partsUsed?; conclusion?; plan?; executorId?; priority? }, meta): Promise<RepairDto>;
export function changeRepairStatus(tx, ctx, id, input: { rowVersion; to: RepairStatus; comment: string }, meta): Promise<RepairDto>;
export function approveRepair(tx, ctx, id, input: { rowVersion; decision: 'approve' | 'reject'; comment }, meta): Promise<RepairDto>;
```

- **Дата поломки не подменяется датой обнаружения** (10 §6.1): `brokenAt = null` требует `brokenAtUnknown = true`; `brokenAt ≤ detectedAt ≤ registeredAt`.
- **Переходы** (каждый – строка `repair_status_history`: из, в, кто, когда, комментарий обязателен, 10 §7):

| Из | В |
|---|---|
| `new` | `diagnostics`, `planned`, `in_repair`, `cancelled` |
| `diagnostics` | `awaiting_approval`, `planned`, `in_repair`, `done_pending_check` (ремонт не нужен), `cancelled` |
| `awaiting_approval` | `planned` (только через `approveRepair`), `diagnostics` (отклонено), `cancelled` |
| `planned` | `in_repair`, `awaiting_parts`, `cancelled` |
| `in_repair` | `awaiting_parts`, `done_pending_check` |
| `awaiting_parts` | `in_repair`, `cancelled` |
| `done_pending_check` | `closed` (только через `closeRepair`, §7), `in_repair` (не принят) |

  Остальное → `REPAIR_TRANSITION_INVALID`. `cancelled` («ошибочно создан») возможен до `in_repair`; после – только через закрытие с результатом.
- **Согласование** (Q-52): если `plan.costKop > repair.approval_threshold_kop` (по умолчанию 1 000 000 коп. = 10 000 ₽), переход в `planned`/`in_repair` идёт только через `awaiting_approval` и `approveRepair` Владельца (`repair.approve`); иначе – `REPAIR_APPROVAL_REQUIRED`. Изменение плана после согласования выше порога сбрасывает согласование.
- **Исполнитель** (10 §8): справочник `repair_executors` (тип `staff | contractor | service_center | manufacturer`, наименование/ФИО, контакт, телефон, email, адрес, ИНН, комментарий, архив). В ремонт кладётся **снимок** реквизитов на момент назначения (`executor_snapshot jsonb`) – правка справочника прошлые ремонты не меняет (10 §8.3). Необязательные поля внутренний ремонт не блокируют (10 §8.2).
- **Повтор поломки** (10 §10.2): `registerRepair` возвращает `details.history` – прошлые ремонты оборудования и действующие гарантии; связь `previousRepairId` ставит сотрудник; гарантийным случаем система ничего не признаёт.

## 7. Закрытие (10 §13.5, §12.2; 16 §12)

```ts
export function closeRepair(tx, ctx, id, input: {
  rowVersion; worksDone: string; completedAt: string; finalEquipmentStatus: EquipmentStatus;
  actualCostKop?: number; noCost?: boolean; costComment?: string;     // ровно одно из двух
  executorId?: string | null;                                         // обязателен, если ремонт был (не «ремонт не нужен»)
  warranty?: { startsOn: LocalDate; endsOn: LocalDate; terms?: string; issuer?: string; attachmentId?: string };
  liftBlockIds?: string[];                                            // снять сразу (подтверждение сотрудника)
}, meta): Promise<{ repair: RepairDto; stillBlocked: Array<{ blockId; reason: 'other_open_repair' | 'not_selected' }> }>;
```

- Обязательны: результат (`worksDone` или «ремонт не потребовался» с причиной), дата завершения, итоговый статус оборудования, сумма **или** «без затрат» с комментарием, исполнитель (10 §13.5). Иначе `REPAIR_CLOSE_INCOMPLETE` со списком полей.
- Кто принимает ремонт – Администратор филиала (`repair.accept` при переходе в `done_pending_check → closed`, Q-52); закрывает – `repair.close` (Владелец, Директор) или Администратор, если `repair.accept` и сумма ≤ порога согласования (решение: Администратор не меняет финансовые данные выше порога, 10 §14).
- **Снятие блокировки – только явное** (16 §12 «после явного закрытия ремонта»): `liftBlockIds` снимает выбранные блокировки ремонта через K6 `liftBlock`. Блокировка, на единицах или комнате которой есть **другой** открытый ремонт, в ответе – `stillBlocked: other_open_repair` и сама не снимается, даже если выбрана (02 §11 «завершение ремонта не должно автоматически открывать ресурс…»). Невыбранные остаются активными (`not_selected`), CRM напоминает о них в карточке.
- Снятие блокировки не трогает прошлые брони (10 §12.2); история блокировки остаётся (статус `lifted`, `lifted_at`).

## 8. Блокировка ресурса из ремонта (10 §6.2, §12; TC-12)

```ts
export interface BlockProposal {
  target: { type: 'unit' | 'room'; ids: string[] };       // по размещению (§1 п.3)
  period: Interval;                                       // [detectedAt|now, plan.end + 1 день | now + equipment.critical_block_hours)
  reasonCode: 'repair';                                   // dict_reasons resource_block/repair (0010)
  affectedBookings: CrmBookingRow[];                      // предпросмотр, ничего не пишет (booking previewBlock, S3-09)
  affectedEvents: Array<{ eventId: string; number: string; status: string; start: string; end: string }>;   // мероприятия на тех же единицах – отдельным списком
  otherOpenRepairs: string[];
}
export function proposeBlock(db, ctx, repairId, input?: { period?: Interval; target?: BlockProposal['target'] }): Promise<BlockProposal>;
export function confirmBlock(tx, ctx, repairId, input: { target; period; comment? }, meta): Promise<{ blockId: string; affectedBookingIds: string[] }>;
```

- `confirmBlock` вызывает K6 `createBlock` (право `block.manage` – у Администратора есть, Q-56) и пишет `repair_blocks (repair_id, block_id UNIQUE)`. Блокировок у ремонта может быть несколько (продление, другой период).
- Затронутые мероприятия (`affectedEvents`) тоже не трогаются: CRM показывает их отдельным списком со ссылкой на карточку мероприятия (перенос – `moveEvent` K20 §4, отмена – K20 §7).
- Затронутые брони **не отменяются и не переносятся** (01 §13, 18 §7.4): CRM показывает их списком «требуют решения» с действиями существующих команд K11 №6 (отмена клубом с причиной – сервисный push клиенту по Э1, K4 `booking.cancelled`), №7 (перенос), смена ресурса – переносом на другой ресурс. Это и есть TC-12: выявить, не удалять молча, запустить процесс уведомления/переноса.
- Блокировка без ремонта (ручная, Э1) работает как раньше; связать её с ремонтом – `confirmBlock` с `blockId` уже существующей (`linkExisting`).
- **Простой** (10 §15): только по связанным блокировкам `[lower(period), min(upper(period), lifted_at))`; ремонт без блокировки в отчёте Э4 показывает сроки ремонта с пометкой «не простой».
- Критическая автоблокировка (`equipment.critical_auto_block = true`): `registerRepair` с `priority='critical'` и размещением в единице/комнате создаёт блокировку `[detectedAt, detectedAt + equipment.critical_block_hours)` в той же транзакции, ответ – `autoBlock` со списком затронутых.

## 9. Гарантии и документы (10 §10–§11)

- `equipment_warranties`: вид `manufacturer` (на оборудование) или `repair` (на работы, со ссылкой на ремонт), `startsOn`, `endsOn`, условия, кто дал, документ (`attachmentId`), комментарий. В карточке – «гарантия до» = максимальная действующая `endsOn`.
- **Вложения** – общие `attachments` (0302, `core/files.ts`, S3-06): владелец `{ type: 'equipment' | 'repair' | 'event', id }`, тип документа (`photo`, `receipt`, `check`, `invoice`, `act`, `warranty_card`, `waybill`, `service_report`, `other`), автор, дата, комментарий, sha256, размер, MIME. Форматы и лимит – JPG, PNG, PDF до 10 МБ – по умолчанию, ждёт заказчика (Q-96). Файл не заменяется: новая версия – новая строка с `supersedes`, ошибочная помечается `invalid` с причиной (10 §11). Хранилище – закрытый каталог сервера, выдача только через API с проверкой права на объект-владелец (решение: не медиатека CMS Э4 – там публичные файлы; сход с 6.6).
- Фото/скан квитанции при закрытии с затратами не обязателен (решение: 06 §8 запрещает обязательное вложение у расхода; 10 §2 п.5 требует **возможности**) – обязательность – вопрос Q-112.

## 10. Расход на ремонт (10 §9; K17)

```ts
export function createRepairExpense(tx, ctx, repairId, input: { branchId /* плательщик, 10 §9.1 */; place; method; amountKop; subcategoryId?; occurredAt; comment }, meta): Promise<FinanceOperationDto>;
export function linkRepairExpense(tx, ctx, repairId, input: { operationId }, meta): Promise<void>;
```

- `createRepairExpense` – K17 `recordExpense` с категорией «Ремонт и обслуживание», подкатегорией по умолчанию «Оборудование» (посев 0202), `ref { type: 'repair', id }`, и связью K17 §14 `(ref_type 'repair', role 'expense')` в той же транзакции. Кнопка с подтверждением, без автомата (10 §9.3 «безопаснее»).
- `linkRepairExpense` – расход уже внесён в кассу вручную: связь без новой операции. Операция должна быть `expense`, не сторнирована, в зоне сотрудника; уже связанная с чем-либо → `OPERATION_ALREADY_LINKED` (10 §9.1 «не дублировать, если уже внесён»).
- Плательщик может быть другим филиалом зоны (10 §9.1) – по умолчанию, ждёт заказчика (Q-120).
- **Статус оплаты вычисляется**: `paidKop = Σ живых связанных расходов` (сторно K17 исключает операцию); `no_cost` – если закрыт «без затрат»; иначе сравнение с `actualCostKop` (или `plan.costKop` до закрытия). «Дата оплаты» – `occurred_at` последней связанной операции. Отдельных полей «сумма оплаты» в ремонте нет – источник истины касса (16 §14 «расходы совпадают со связанными операциями»).
- Право: `repair.expense.create` (Владелец, Директор) **и** проверка K17 `finance.expense.create` в филиале-плательщике.

## 11. События (дополняют K4)

| `type` @ver | Когда | `aggregateVersion` | Payload | Потребители |
|---|---|---|---|---|
| `repair.registered` @1 | `registerRepair` | `1` | `{ repairId, number, equipmentId, branchId, priority, impact, autoBlockId \| null }` | Э4: уведомление Владельцу/Директору (10 §18 п.15 – вопрос, по умолчанию выключено) |
| `repair.closed` @1 | `closeRepair` | `'closed'` | `{ repairId, branchId, finalEquipmentStatus, stillBlockedIds: string[] }` | Э4: отчёты, уведомления |

Блокировки публикуют существующие `resource.blocked` / `resource.unblocked` (K4) – отдельного события ремонта для них нет. Тип агрегата – `repair` (S3-08).

## 12. Права (K1, шаг S3-01)

| Действие | О | Д | А | Цель | Основание |
|---|:-:|:-:|:-:|---|---|
| `equipment.view` (карточки, размещение, ремонты – чтение) | ✓ | ✓ | ✓ | branch | 10 §14 |
| `equipment.view.accounts` | ✓ | ✓ | | branch | Q-54 |
| `equipment.manage` (создать, изменить карточку, статус, учётки) | ✓ | ✓ | | branch | 10 §14 |
| `equipment.move` | ✓ | ✓ | | branch (оба) | 10 §14; решение |
| `equipment.financial.edit` (инв. номер прежний, серийный, стоимость) | ✓ | | | network | 10 §14 «без отдельного права» |
| `equipment.write_off` (`written_off`, `lost → in_service`) | ✓ | | | network | 10 §14 «Владелец: списание» |
| `equipment.category.manage` | ✓ | | | network | 10 §3.2 |
| `repair.register`, `repair.attach` | ✓ | ✓ | ✓ | branch | 10 §14 |
| `repair.manage` (диагностика, план, исполнитель, статусы) | ✓ | ✓ | | branch | 10 §14 |
| `repair.approve` | ✓ | | | network | Q-52 |
| `repair.accept` | ✓ | ✓ | ✓ | branch | Q-52 «принимает Администратор филиала» |
| `repair.close` | ✓ | ✓ | | branch | Q-52 |
| `repair.expense.create` | ✓ | ✓ | | branch | 10 §14 «согласование затрат» |
| `repair.executor.manage` | ✓ | ✓ | | network | 10 §8.3 |

Блокировка – существующее `block.manage` (ОДА, Q-56).

## 13. Данные (`0304_equipment.sql`, `0307_repairs.sql`)

```sql
-- 0304 (equipment)
CREATE SEQUENCE app.equipment_inventory_seq; CREATE SEQUENCE app.repair_number_seq;   -- вторую использует 0307
CREATE TABLE app.equipment_categories (id uuid PK, name text NOT NULL, sort_order int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')), UNIQUE (name));
CREATE TABLE app.equipment_items (id uuid PK, inventory_number text NOT NULL UNIQUE, legacy_number text,
  name text NOT NULL, category_id uuid NOT NULL → equipment_categories, manufacturer text, model text, serial_number text,
  parent_id uuid → equipment_items, purchase_date date, purchase_cost_kop bigint CHECK (purchase_cost_kop >= 0), commissioned_on date,
  status text NOT NULL CHECK (status IN ('in_service','reserve','diagnostics','repair','awaiting_parts','unavailable','written_off','lost')),
  status_reason text, branch_id uuid NOT NULL → branches /* текущий, дублирует размещение для scopeFilter */,
  comment text, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), row_version int NOT NULL DEFAULT 1);
CREATE INDEX equipment_items_serial_idx ON app.equipment_items (serial_number) WHERE serial_number IS NOT NULL;
CREATE TABLE app.equipment_placements (id uuid PK, item_id uuid NOT NULL → equipment_items, branch_id uuid NOT NULL → branches,
  room_id uuid, unit_id uuid, placed_at timestamptz NOT NULL, removed_at timestamptz, moved_by uuid NOT NULL, reason text NOT NULL,
  FOREIGN KEY (room_id, branch_id) → rooms(id, branch_id), FOREIGN KEY (unit_id, branch_id) → occupancy_units(id, branch_id),
  CHECK (removed_at IS NULL OR removed_at >= placed_at));
CREATE UNIQUE INDEX equipment_placements_current ON app.equipment_placements (item_id) WHERE removed_at IS NULL;
CREATE TABLE app.equipment_accounts (id uuid PK, platform text NOT NULL CHECK (platform IN ('playstation','meta','other')),
  display_name text NOT NULL, equipment_id uuid → equipment_items, branch_id uuid NOT NULL → branches,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')), bound_from date NOT NULL, bound_to date,
  end_reason text, access_hint text, comment text, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
-- 0307 (equipment)
CREATE TABLE app.repair_executors (id uuid PK, kind text NOT NULL CHECK (kind IN ('staff','contractor','service_center','manufacturer')),
  name text NOT NULL, staff_id uuid → staff, contact_person text, phone text, email text, address text, inn text, comment text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')));
CREATE TABLE app.repairs (id uuid PK, number text NOT NULL UNIQUE, equipment_id uuid NOT NULL → equipment_items,
  branch_id uuid NOT NULL → branches, room_id uuid, unit_id uuid, broken_at timestamptz, broken_at_unknown boolean NOT NULL DEFAULT false,
  detected_at timestamptz NOT NULL, registered_at timestamptz NOT NULL, reported_by_staff_id uuid, reported_by_name text,
  symptoms text NOT NULL, priority text NOT NULL CHECK (priority IN ('critical','high','medium','low')),
  impact text NOT NULL CHECK (impact IN ('none','partial','full')), status text NOT NULL DEFAULT 'new' CHECK (status IN (…9 кодов…)),
  diagnostics text, cause text, works_done text, parts_used text, conclusion text,
  plan_works text, plan_start date, plan_end date, plan_cost_kop bigint CHECK (plan_cost_kop >= 0), plan_responsible_staff_id uuid,
  plan_parts_needed boolean NOT NULL DEFAULT false, plan_comment text,
  executor_id uuid → repair_executors, executor_snapshot jsonb, approval_required boolean NOT NULL DEFAULT false,
  approved_by uuid, approved_at timestamptz, actual_cost_kop bigint CHECK (actual_cost_kop >= 0), no_cost boolean NOT NULL DEFAULT false,
  cost_comment text, completed_at timestamptz, final_equipment_status text, accepted_by uuid, previous_repair_id uuid → repairs,
  created_by uuid NOT NULL, row_version int NOT NULL DEFAULT 1,
  CHECK (broken_at IS NOT NULL OR broken_at_unknown), CHECK (broken_at IS NULL OR broken_at <= detected_at),
  CHECK (NOT (no_cost AND actual_cost_kop IS NOT NULL)),
  CHECK (status <> 'closed' OR (completed_at IS NOT NULL AND final_equipment_status IS NOT NULL AND (no_cost OR actual_cost_kop IS NOT NULL))));
CREATE TABLE journal.repair_status_history (id bigint IDENTITY PK, repair_id uuid NOT NULL → repairs, from_status text,
  to_status text NOT NULL, at timestamptz NOT NULL, by_staff_id uuid NOT NULL, comment text NOT NULL);
CREATE TABLE app.repair_blocks (repair_id uuid NOT NULL → repairs, block_id uuid NOT NULL UNIQUE → resource_blocks,
  linked_at timestamptz NOT NULL, linked_by uuid NOT NULL, PRIMARY KEY (repair_id, block_id));
CREATE TABLE app.equipment_warranties (id uuid PK, kind text NOT NULL CHECK (kind IN ('manufacturer','repair')),
  equipment_id uuid NOT NULL → equipment_items, repair_id uuid → repairs, starts_on date NOT NULL, ends_on date NOT NULL CHECK (ends_on >= starts_on),
  terms text, issuer text, attachment_id uuid → attachments, comment text, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','invalid')),
  CHECK ((kind = 'repair') = (repair_id IS NOT NULL)));
```

`REVOKE DELETE` на все таблицы модуля. FK `repair_blocks → resource_blocks` (0104) и `equipment_warranties → attachments` (0302) смотрят назад – отложенных FK нет.

## 14. API CRM (дополняет K11; номера 3xx)

| # | Метод и путь | Право | Успех |
|---|---|---|---|
| 331 | `GET /equipment?cityId=&branchId=&categoryId=&status=&roomId=&unitId=&serial=&warrantyExpiresBefore=&hasOpenRepair=&cursor=` | `equipment.view` | `200 { items, nextCursor }`, порядок `(inventory_number)` |
| 332 | `POST /equipment`, `GET /equipment/{id}`, `PATCH /equipment/{id}` | `equipment.manage` / `equipment.view` | `201` / `200` – вкладки 10 §13.2, `accounts` только с `equipment.view.accounts` |
| 333 | `POST /equipment/{id}/status` | `equipment.manage` (`equipment.write_off` для `written_off`, `lost→in_service`) | `200 { equipment, blockProposal }` |
| 334 | `POST /equipment/{id}/move` | `equipment.move` | `200` / `409 EQUIPMENT_MOVE_HAS_BOOKINGS` |
| 335 | `GET /equipment/{id}/placements` | `equipment.view` | `200` история |
| 336 | `POST /equipment-accounts`, `POST /equipment-accounts/{id}/rebind` | `equipment.manage` | `201` / `200` |
| 337 | `GET/POST/PATCH /equipment-categories` | `equipment.view` / `equipment.category.manage` | архив вместо удаления |
| 341 | `GET /repairs?period=&branchId=&equipmentId=&status=&executorId=&priority=&planOverdue=&cursor=` | `equipment.view` | `200` (10 §13.3) |
| 342 | `POST /repairs` | `repair.register` | `201 { repair, blockProposal, autoBlock }` |
| 343 | `GET /repairs/{id}`, `PATCH /repairs/{id}` | `equipment.view` / `repair.manage` | `200` + `timeline` (K2) |
| 344 | `POST /repairs/{id}/status`, `POST /repairs/{id}/approve` | `repair.manage` / `repair.approve` | `200` |
| 345 | `GET /repairs/{id}/block-proposal`, `POST /repairs/{id}/blocks` | `equipment.view` / `block.manage` | `200 BlockProposal` / `201 { blockId, affectedBookings }` |
| 346 | `POST /repairs/{id}/close` | `repair.close` / `repair.accept` | `200 { repair, stillBlocked }` |
| 347 | `POST /repairs/{id}/expense`, `POST /repairs/{id}/expense/link` | `repair.expense.create` | `201` / `200` |
| 348 | `GET/POST /equipment/{id}/warranties`, `POST /warranties/{id}/invalidate` | `equipment.view` / `repair.manage` | `201` |
| 349 | `GET/POST/PATCH /repair-executors` | `equipment.view` / `repair.executor.manage` | архив вместо удаления |
| 350 | `POST /attachments?ownerType=&ownerId=&docType=` (тело – файл, `Content-Type` файла), `GET /attachments/{id}`, `POST /attachments/{id}/invalidate` | право записи/чтения владельца | `201 { attachmentId }` / поток файла (S3-07) |

## 15. Ошибки

| Код | HTTP | Когда |
|---|---|---|
| `EQUIPMENT_NOT_PLACEABLE` | 409 | списанное, утерянное или резервное ставится в единицу/комнату |
| `EQUIPMENT_MOVE_HAS_BOOKINGS` | 409 | уход из единицы с будущими бронями или мероприятиями без подтверждения (`details.bookingIds`, `details.eventIds`) |
| `EQUIPMENT_WRITTEN_OFF` | 409 | любое изменение списанного, кроме документов |
| `REPAIR_TRANSITION_INVALID` | 409 | переход не по таблице §6 |
| `REPAIR_APPROVAL_REQUIRED` | 409 | план выше порога без согласования |
| `REPAIR_CLOSE_INCOMPLETE` | 422 | не хватает полей закрытия (`details.fields`) |
| `REPAIR_DATES_INVALID` | 422 | `brokenAt > detectedAt`, нет даты и нет «неизвестна» |
| `OPERATION_ALREADY_LINKED` | 409 | расход уже связан с другим объектом (K17 §14) |
| `ATTACHMENT_TOO_LARGE`, `ATTACHMENT_TYPE_NOT_ALLOWED` | 413 / 415 | вложение больше лимита / не JPG, PNG, PDF |
| `COMMENT_REQUIRED` | 422 | смена статуса ремонта, списание без причины |

## 16. Настройки (K7, шаг S3-01; сеть, Владелец)

| Ключ | Тип | По умолчанию | Основание |
|---|---|---|---|
| `equipment.critical_auto_block` | boolean | false | 10 §6.2, Q-111 |
| `equipment.critical_block_hours` | int 1..720 | 24 | решение |
| `repair.approval_threshold_kop` | `int \| null` | 1 000 000 | Q-52 (`null` – согласование не требуется) |
| `attachments.max_bytes` | int | 10 485 760 | Q-96 |
| `attachments.mime_types` | string[] | `['image/jpeg','image/png','application/pdf']` | Q-96 |

## 17. Проверка (приёмка 10 §17, TC-12, 18 §7.4)

- Отдельная карточка, системный инвентарный номер, серийный – сохраняется; дубль серийного – предупреждение, не отказ (приёмка 1–2).
- Перемещение пишет историю, старое размещение доступно; перемещение из `VR1` при будущей брони → `EQUIPMENT_MOVE_HAS_BOOKINGS`, с подтверждением – брони целы, аудит со списком (приёмка 3–4, 02 §10).
- Учётки: перепривязка закрывает прежнюю; Администратор их не получает ни в карточке, ни по прямому запросу (приёмка 5–6).
- Поломка: дата поломки и обнаружения различаются; «неизвестна» без даты – можно, без отметки – `REPAIR_DATES_INVALID` (приёмка 7–8).
- План выше порога без согласования – `REPAIR_APPROVAL_REQUIRED`; согласование Директором – `FORBIDDEN`.
- **TC-12**: бронь VR1 завтра 14:00; поломка шлема VR1 → предложение блокировки единицы `VR1` с этой бронью в `affectedBookings`; подтверждение → блокировка, бронь **осталась `confirmed`**, новая бронь VR1 и «комнаты целиком» на период → `RESOURCE_BLOCKED`, «VR-место 2» – бронируется (приёмка 15–16, 20 §4.2); отмена клубом из списка → клиенту сервисный push (Э1).
- Закрытие без суммы и без «без затрат» – `REPAIR_CLOSE_INCOMPLETE`; при втором открытом ремонте на той же комнате снятие блокировки не проходит (`other_open_repair`); снятая блокировка остаётся в истории (приёмка 17).
- Расход: «Создать расход» дважды (двойной клик) → одна операция; привязка ручного расхода → новой операции нет; та же операция ко второму ремонту или мероприятию → `OPERATION_ALREADY_LINKED`; сторно в кассе → `payment.status` пересчитан (приёмка 18, 16 §14).
- Списанное не ставится в единицу (приёмка 19); каждое действие – в аудите (10 §14, приёмка 20): `equipment.created/updated/serial_changed/status_changed/moved/written_off`, `equipment.account.bound/rebound`, `repair.registered/updated/status_changed/approved/closed/block_linked/expense_linked`, `warranty.created/invalidated`, `attachment.added/invalidated`.
- IDOR: каждый маршрут №331–350 с объектом чужого филиала → `404`.

## 18. Решения реализации (S3-30…S3-39)

- **`affectedEvents`:** поля `number`, `status`, `start`, `end` – от модуля events (`eventSummaries`, время – `plannedStart`/`plannedEnd`): `registerModuleHooks` в `server.ts` передаёт её в `registerEventSummaries` (`equipment/items.ts`), equipment events не импортирует (ADR 0002). До регистрации приходит только `eventId`, остальные поля `null`.
- **Выход из `lost`:** любой, а не только `lost → in_service`, – право `equipment.write_off` и причина: иначе Директор обошёл бы запрет переводом через другой статус.
- **`reserve`, `lost`, `written_off` при смене статуса** покидают единицу и комнату: текущая строка размещения закрывается, новая – на уровне филиала; бронь не трогается.
- **Перемещение:** будущие занятия считаются от «сейчас», а не от `at`: прошедшая бронь решения не требует, даже если перемещение датировано задним числом; `at` в будущем – отказ. `details` у `EQUIPMENT_MOVE_HAS_BOOKINGS` содержит ещё `holdIds`.
- **`impact = 'none'`** при регистрации не предлагает блокировку (сотрудник может запросить предложение №345).
- **Период предложения:** от `detectedAt`, при уже связанной блокировке – от «сейчас». №345 GET без места и без цели – `200` с `target: null`, цель выбирает сотрудник (`?targetType=&targetId=&start=&end=`).
- **`createRepairExpense`:** поля `place` нет – место денег выводит K17 из `method`. Плательщик вне зоны – `FORBIDDEN`, как и без права; по отменённому ремонту и закрытому «без затрат» – `REPAIR_TRANSITION_INVALID`.
- **Блокировка за закрытым ремонтом** (`stillBlocked`) снимается сотрудником обычной командой K11 №14; автоматически не снимается и после закрытия второго ремонта (16 §12 «только явно»).
- **Отмена ремонта** статус оборудования назад не возвращает: сотрудник ставит его вручную (K19 §2 не описывает возврат).
- **Согласование в работе (дыра таблицы §6):** после сброса в `planned` или подъёма плана в `in_repair` переход в `awaiting_approval` таблицей закрыт, поэтому `approveRepair` принимает ремонт в `planned`, `in_repair`, `awaiting_parts` с `approval_required` и без согласования – решение на месте, статус не меняется. Переход `in_repair → done_pending_check` тоже требует согласования. Ждёт подтверждения заказчика.
- **Администратор при закрытии:** порог сравнивается с большим из суммы и плана; «без затрат» при живом расходе и `actualCostKop: 0` – `REPAIR_CLOSE_INCOMPLETE`. Выход из `lost` закрытием – право `equipment.write_off`.
- **Архивное или пустое место:** предложения и автоблокировки нет (`null`), регистрация и смена статуса проходят; выбранная сотрудником цель – `RESOURCE_LINK_INVALID`.
- **Перемещение между филиалами:** действующие учётки переходят с оборудованием; компонент, уже стоящий в другом филиале, не едет. **Открытый ремонт остаётся в филиале регистрации** (снимок места §6): новый филиал видит `openRepairsCount`, но карточку ремонта – только с зоной старого. Вопрос заказчику: запрещать ли перевод при открытом ремонте.
- **№341:** вместо `period=` – `from` и `to` по `detected_at`.
- **Известные ограничения:** автоблокировка считается от `detectedAt` по букве §8: при давнем обнаружении период может оказаться в прошлом и ресурс не закроет. Параллельное перемещение родителя и компонента может дать редкий deadlock (откат с ошибкой, данные целы). «Действующая гарантия» считается по дате сервера, а не филиала.
- **Сверх §14:** `GET /equipment-accounts` (вкладка «Учётки», право `equipment.view.accounts`), `GET /repair-executors?includeArchived=`, в №343 – `downtime { minutes, hasBlocks }`.
