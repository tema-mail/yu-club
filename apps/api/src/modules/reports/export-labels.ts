// Подписи файла экспорта (K24 §7, 14 §16): названия отчётов, показателей и столбцов по-русски. Неизвестный ключ – сам ключ: столбец не теряется.
export const REPORT_TITLES: Record<string, string> = {
  dashboard: 'Сводка',
  bookings: 'Бронирования и посещаемость',
  utilization: 'Загрузка ресурсов',
  finance: 'Финансы и касса',
  events: 'Мероприятия',
  clients: 'Клиенты и повторные посещения',
  loyalty: 'Лояльность и баллы',
  certificates: 'Сертификаты',
  staff: 'Сотрудники и смены',
  equipment: 'Оборудование и ремонты',
  comms: 'Уведомления и публикации',
};

export const METRIC_TITLES: Record<string, string> = {
  // 3.2
  created: 'Создано', planned: 'Запланировано', visited: 'Состоялось', cancelledByClient: 'Отмены клиентом', cancelledByClub: 'Отмены клубом',
  rescheduled: 'Перенесено', noShows: 'Неявки', awaitingDecision: 'Ожидают решения', avgMinutes: 'Средняя длительность', uniqueVisitors: 'Уникальные посетители',
  // 3.3
  available: 'Доступное время', availableElapsed: 'Доступное время до текущего момента', blocked: 'Заблокировано', technical: 'Техническое время', booked: 'Забронировано',
  used: 'Использовано', free: 'Свободно', actualLoad: 'Фактическая загрузка', commercialLoad: 'Коммерческая загрузка',
  // 3.4
  income: 'Поступления', incomeSession: 'Поступления от сеансов', incomeEvent: 'Поступления от мероприятий', incomeCertificateSale: 'Продажи сертификатов',
  incomeExtraService: 'Дополнительные услуги', incomeOther: 'Прочие поступления', refunds: 'Возвраты', expenses: 'Расходы', withdrawals: 'Изъятия', transfers: 'Переводы',
  corrections: 'Исправления', netMovement: 'Чистое движение денег', nonMoneyPoints: 'Оплачено баллами (не деньги)', nonMoneyCertificate: 'Оплачено сертификатами (не деньги)',
  cashOpening: 'Остаток на начало', cashClosing: 'Остаток на конец',
  // 3.6
  withVisit: 'Клиенты с посещением', firstTime: 'Впервые', returning: 'Вернувшиеся', repeat: 'Повторные', notVisited: 'Не приходили', profileVisits: 'Посещения клиентов с профилем',
  newProfiles: 'Новые профили', visitsPerClient: 'Посещений на клиента', avgIntervalDays: 'Средний интервал, дней',
  // 3.7
  accrued: 'Начислено', spentTime: 'Списано на время', spentGoods: 'Списано на товары', penalties: 'Штрафы', returned: 'Возвращено', adjusted: 'Корректировки', expired: 'Сгорело',
  clientsPositive: 'Клиенты с плюсовым балансом', clientsNegative: 'Клиенты с минусом', clientsAtThreshold: 'Клиенты у порога', clientsBlocked: 'Заблокировано оплат баллами', totalBalance: 'Итоговый баланс',
  // 3.8
  salesCount: 'Продано, шт.', salesAmount: 'Продано на сумму', redeemedAmount: 'Погашено на сумму', redeemReturnedAmount: 'Возвращено погашений', expiredCount: 'Сгорело, шт.',
  expiredAmount: 'Сгорело на сумму', cancelledCount: 'Отменено, шт.', activeCount: 'Действующие, шт.', activeBalance: 'Остаток действующих', partiallyRedeemed: 'Погашены частично', birthdayGift: 'Подарки имениннику: выдано',
  birthdayGiftUsed: 'Подарки имениннику: использовано', birthdayGiftExpired: 'Подарки имениннику: сгорело',
};

// 3.11: показатели уведомлений по категориям собираются из двух частей
const COMMS_CATEGORY_TITLES: Record<string, string> = { service: 'Сервисные', reminder: 'Напоминания', marketing: 'Реклама' };
const COMMS_PART_TITLES: Record<string, string> = {
  Created: 'создано', SentToProvider: 'передано в браузер, показ не подтверждён', InboxOnly: 'только в центре уведомлений', SkippedByPrefs: 'пропущено по настройкам',
  SkippedByFrequency: 'пропущено по частоте', SkippedBookingChanged: 'пропущено: бронь изменилась', Errors: 'ошибки', OpenedInCabinet: 'открыто в кабинете',
};
for (const [c, ct] of Object.entries(COMMS_CATEGORY_TITLES)) for (const [k, pt] of Object.entries(COMMS_PART_TITLES)) METRIC_TITLES[`${c}${k}`] = `${ct}: ${pt}`;
Object.assign(METRIC_TITLES, {
  campaignsCount: 'Рекламные кампании', campaignsReach: 'Охват кампаний', optOuts: 'Отказы от рекламы', publishedNews: 'Опубликовано: новости', publishedPromotion: 'Опубликовано: акции',
  publishedGiveaway: 'Опубликовано: розыгрыши', publishedTournament: 'Опубликовано: турниры', publishedGame: 'Опубликовано: игры', publishedRoomPage: 'Опубликовано: страницы комнат',
  publishedBranchPage: 'Опубликовано: страницы филиалов', publishedPage: 'Опубликовано: страницы', publishedHomeBlock: 'Опубликовано: блоки главной', siteViews: 'Просмотры на сайте', siteClicks: 'Переходы с сайта',
});

export const COLUMN_TITLES: Record<string, string> = {
  bookingId: 'ID брони', number: 'Номер', startLocal: 'Начало сеанса', branchId: 'ID филиала', branchName: 'Филиал', clientId: 'ID клиента', clientName: 'Клиент', clientPhone: 'Телефон',
  clientKind: 'Вид клиента', resourceType: 'Тип ресурса', resourceName: 'Ресурс', minutes: 'Минут', status: 'Статус', priceKop: 'Стоимость, ₽', paymentState: 'Оплата', paymentMethods: 'Способы оплаты',
  paymentPaidKop: 'Оплачено, ₽', reasonCode: 'Причина', cancelledAt: 'Отменено', metricValue: 'Значение', value: 'Значение',
  id: 'ID', occurredLocal: 'Дата операции', kind: 'Вид', isReversal: 'Сторно', place: 'Место денег', method: 'Способ', source: 'Источник', categoryId: 'ID статьи', amountKop: 'Сумма, ₽',
  refType: 'Связь: тип', refId: 'Связь: ID', authorId: 'ID автора', comment: 'Комментарий',
  openingKop: 'На начало, ₽', incomeKop: 'Поступления, ₽', refundKop: 'Возвраты, ₽', expenseKop: 'Расходы, ₽', withdrawalKop: 'Изъятия, ₽', transferInKop: 'Переводы сюда, ₽',
  transferOutKop: 'Переводы отсюда, ₽', correctionKop: 'Исправления, ₽', closingKop: 'На конец, ₽',
  entryId: 'ID записи', atLocal: 'Дата', type: 'Тип', spendKind: 'Вид списания', authorType: 'Автор', certificateId: 'ID сертификата', op: 'Операция', balanceAfterKop: 'Остаток после, ₽',
  unitId: 'ID единицы', unitName: 'Единица', resourceId: 'ID ресурса', roomId: 'ID комнаты', availableMin: 'Доступно, мин', availableElapsedMin: 'Доступно до текущего момента, мин',
  notificationId: 'ID уведомления', category: 'Категория', campaignId: 'ID кампании', createdLocal: 'Создано', sentLocal: 'Передано', readLocal: 'Прочитано', consentId: 'ID записи согласия',
  versionId: 'ID версии', entityType: 'Сущность', entityId: 'ID сущности', scopeType: 'Охват',
  blockedMin: 'Заблокировано, мин', technicalMin: 'Техническое, мин', bookedMin: 'Забронировано, мин', usedMin: 'Использовано, мин', freeMin: 'Свободно, мин',
  // 3.5, 3.9, 3.10
  eventId: 'ID мероприятия', heldLocal: 'Проведено', hasBooking: 'С бронью', agreedKop: 'Согласовано, ₽', receivedKop: 'Поступило, ₽', refundedKop: 'Возвращено, ₽', dueKop: 'Осталось получить, ₽',
  plannedCostKop: 'Себестоимость план, ₽', factCostKop: 'Себестоимость факт, ₽', resultKop: 'Результат, ₽',
  staffId: 'ID сотрудника', staffName: 'Сотрудник', plannedMinutes: 'План, мин', paidMinutes: 'Оплачиваемые, мин', basis: 'Основание',
  equipmentId: 'ID оборудования', inventoryNo: 'Инвентарный номер', serialNo: 'Серийный номер', incidentLocal: 'Поломка', startedLocal: 'Начало ремонта', finishedLocal: 'Завершение',
  contractorId: 'ID исполнителя', contractorName: 'Исполнитель', warranty: 'Гарантия',
};

export const UNIT_TITLES: Record<string, string> = { count: 'шт.', kop: '₽', centi: 'баллы', minutes: 'мин', pct: '%', days: 'дн.' };
export const DATE_BASIS_TITLES: Record<string, string> = {
  session_start: 'по дате сеанса', created_at: 'по дате создания', arrived_at: 'по дате прихода', occurred_at: 'по дате операции', marked_at: 'по дате отметки', at: 'по дате события', rescheduled_at: 'по дате переноса', now: 'на момент запроса',
};
export const UNITS_NOTE = 'Суммы – в рублях с двумя знаками, баллы – с двумя знаками, копейки и сотые балла переведены; нет данных и недоступно – не ноль.';
