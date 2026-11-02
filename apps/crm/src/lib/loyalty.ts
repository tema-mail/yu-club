// Баллы в CRM (S2-65, S2-66): типы ответов K15 №24–28 (apps/api/src/modules/loyalty/routes.crm.ts), вызовы API из
// браузера (Idempotency-Key ставит browserCall), формат баллов и понятные администратору тексты ошибок по кодам.
// Суммы баллов – в сотых (POINT_CENTI): 2,5 балла = 250. Деньги – в копейках. Пересчёта ₽ ↔ баллы нет (07 §7.1).
import { ApiError, browserCall } from './api.ts';

export interface HistoryEntry {
  entryId: number; at: string; type: string; deltaCenti: number; balanceAfterCenti: number; comment: string | null; branchId: string | null;
  ref: { type: string; id: string } | null; author: { type: string; id: string | null };
}
export interface Batch {
  id: string; source: 'visit' | 'manual'; entryId: number; branchId: string | null; amountCenti: number; remainingCenti: number;
  expiresAt: string | null; status: 'active' | 'depleted' | 'expired'; accruedAt: string;
}
export interface GoodsOrder {
  id: string; goodsId: string; goodsName: string; branchId: string; priceCenti: number; status: 'issued' | 'returned'; issuedAt: string; returnReason: string | null;
}
export interface LoyaltyIssue { id: string; kind: string; ref: { type: string; id: string }; amountCenti: number; createdAt: string }
/** K15 №24: LoyaltyBalanceDto + история, партии, выданные товары, «требует решения», причина блокировки. */
export interface LoyaltyCard {
  balanceCenti: number; availableCenti: number; reservedCenti: number; nextExpiry: { at: string; centi: number } | null;
  preBookingBlocked: boolean; accrualBasis: 'planned';
  history: HistoryEntry[]; batches: Batch[]; goodsOrders: GoodsOrder[]; issues: LoyaltyIssue[]; blockedReason: string | null;
}
/** K15 №26: строка каталога филиала. */
export interface BranchGoods {
  id: string; name: string; description: string | null; imageUrl: string | null; priceRubKop: number | null; pricePointsCenti: number;
  status: 'active' | 'archived'; stock: number | null; rowVersion: number; available: boolean;
}
export interface GoodsDto {
  id: string; name: string; description: string | null; imageUrl: string | null; priceRubKop: number | null; pricePointsCenti: number;
  status: 'active' | 'archived'; rowVersion: number; branches: Array<{ branchId: string; stock: number | null; active: boolean }>;
}
export interface GoodsBody {
  name?: string; description?: string | null; priceRubKop?: number | null; pricePointsCenti?: number;
  branches?: Array<{ branchId: string; stock?: number | null; active?: boolean }>;
}

/** Предел счёта −50 баллов (07 §3.1, K15 §1). */
export const MIN_BALANCE = -5000;

export const ENTRY_LABEL: Record<string, string> = {
  'loyalty.accrual': 'Начисление за посещение',
  'loyalty.penalty': 'Штраф за неявку',
  'loyalty.spend_time': 'Оплата сеанса баллами',
  'loyalty.spend_goods': 'Товар за баллы',
  'loyalty.return': 'Возврат баллов',
  'loyalty.expire': 'Срок баллов истёк',
  'loyalty.manual': 'Корректировка',
  reversal: 'Исправление операции',
};
export const SOURCE_LABEL: Record<Batch['source'], string> = { visit: 'За посещение', manual: 'Корректировка' };
export const BATCH_STATUS: Record<Batch['status'], string> = { active: 'Действует', depleted: 'Израсходована', expired: 'Сгорела' };
export const ISSUE_LABEL: Record<string, string> = {
  accrual_reversal_below_limit: 'Сторно начисления не проведено: баланс ушёл бы ниже −50',
};
export const ISSUE_REF: Record<string, string> = { visit: 'исправление посещения', payment_refund: 'возврат платежа' };

/** «45 баллов», «2,5 балла», «1 балл», «−3 балла». Дробное – «балла» (родительный ед. ч.). */
export function fmtPoints(centi: number, signed = false): string {
  const v = centi / 100;
  const abs = Math.abs(v);
  const num = abs.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  const sign = v < 0 ? '−' : signed && v > 0 ? '+' : '';
  let word = 'баллов';
  if (!Number.isInteger(abs)) word = 'балла';
  else {
    const n10 = abs % 10;
    const n100 = abs % 100;
    if (n10 === 1 && n100 !== 11) word = 'балл';
    else if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) word = 'балла';
  }
  return `${sign}${num} ${word}`;
}
export const fmtRub = (kop: number | null) => (kop === null ? '–' : `${(kop / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`);
/** Ввод «12,5» → 1250 сотых; пусто, не число, больше двух знаков – null. */
export function parsePoints(text: string): number | null {
  const t = text.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}
export function parseRub(text: string): number | null {
  const t = text.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

const UNAVAILABLE: Record<string, string> = {
  archived: 'товар в архиве', not_in_branch: 'товара нет в этом филиале', out_of_stock: 'товар закончился',
};
const FRIENDLY: Record<string, string> = {
  FORBIDDEN: 'Недостаточно прав для этого действия.',
  NOT_FOUND: 'Не найдено: запись удалена или вне вашей зоны.',
  COMMENT_REQUIRED: 'Укажите причину – без неё не сохранить.',
  LIMIT_OVERRIDE_NOT_ALLOWED: 'Ниже −50 баллов может опустить только Владелец в режиме «ниже предела».',
  LOYALTY_ISSUE_RESOLVED: 'Эта задача уже закрыта – обновите карточку.',
  ALREADY_REVERSED: 'Товар уже возвращён.',
  VERSION_CONFLICT: 'Карточку товара уже изменили – данные обновлены, проверьте и повторите.',
  IDEMPOTENCY_KEY_REUSED: 'Операция уже проведена – обновите страницу.',
  VALIDATION_FAILED: 'Проверьте поля формы.',
};
export function loyaltyError(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Не удалось связаться с сервером. Повторите.';
  const d = e.details ?? {};
  if (e.code === 'POINTS_INSUFFICIENT' && typeof d.availableCenti === 'number' && typeof d.requiredCenti === 'number') {
    return `Баллов недостаточно: доступно ${fmtPoints(d.availableCenti)}, нужно ${fmtPoints(d.requiredCenti)}.`;
  }
  if (e.code === 'GOODS_UNAVAILABLE') return `Товар сейчас нельзя выдать: ${UNAVAILABLE[String(d.reason)] ?? 'он недоступен'}.`;
  return FRIENDLY[e.code] ?? e.message;
}

const enc = encodeURIComponent;
export const loyaltyApi = {
  card: (clientId: string) => browserCall<LoyaltyCard>(`/clients/${enc(clientId)}/loyalty`),
  adjust: (clientId: string, body: { deltaCenti: number; reason: string; belowLimit?: true; issueId?: string }) =>
    browserCall<{ entryId: number }>(`/clients/${enc(clientId)}/loyalty/adjust`, { method: 'POST', body }),
  goods: (branchId: string) => browserCall<{ items: BranchGoods[] }>(`/branches/${enc(branchId)}/goods`),
  createGoods: (body: Required<Pick<GoodsBody, 'name' | 'pricePointsCenti' | 'branches'>> & GoodsBody) => browserCall<GoodsDto>('/goods', { method: 'POST', body }),
  updateGoods: (id: string, body: GoodsBody & { rowVersion: number; status?: 'active' | 'archived' }) => browserCall<GoodsDto>(`/goods/${enc(id)}`, { method: 'PATCH', body }),
  issue: (clientId: string, body: { goodsId: string; branchId: string }) =>
    browserCall<{ orderId: string; entryId: number }>(`/clients/${enc(clientId)}/goods-orders`, { method: 'POST', body }),
  returnOrder: (orderId: string, reason: string) =>
    browserCall<{ returnedCenti: number; notReturnedCenti: number }>(`/goods-orders/${enc(orderId)}/return`, { method: 'POST', body: { reason } }),
};
