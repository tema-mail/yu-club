// S4-75. Глобальный поиск CRM (K24 §5, K11 №250, 13 §7.1, Q-88). Строка ≥ 2 символов, телефон ≥ 4 цифр; группы по типам, ≤ 5 в группе.
// Тип без права в ответе отсутствует (не «0 найдено»); клиент вне зоны не находится даже по точному телефону – факт существования
// не раскрывается. Все запросы – одной READ ONLY транзакцией основного пула, statement_timeout 2 с: поиску нужны клиенты и сотрудники,
// которых роль yu_reports не видит, бронь и касса – те же rpt_*. Поиск по телефону – в аудит с маской номера (видно перебор), отдельной записью.
// Группы мероприятий и оборудования появятся после Э3 (S4-79).
import type { AuditRequestMeta, Db, Tx } from '../../core/audit.ts';
import { writeAudit } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { roleAllows, type AccessContext } from '../../core/permissions.ts';
import { formatLocal, parseLocalDate, todayIn, type Clock, type LocalDate } from '../../core/time.ts';
import { searchClients } from '../clients/index.ts';
import { getBranches, type BranchInfo } from '../network/index.ts';
import { searchStaffByName } from '../staff/index.ts';
import { maskClient, resolveBranches, where, windowsOf, withReportTx, type MaskedClient, type ReportsPool } from './framework.ts';

export const SEARCH_TIMEOUT_MS = 2_000;
const SEARCH_BUDGET_MS = 5_000; // все запросы поиска вместе (D4-22)
/** Поиск идёт основным пулом (10 соединений): ввод по буквам у многих сотрудников не должен занять соединения брони и оплаты (17 §6). */
export const MAX_CONCURRENT_SEARCHES = 3;
let searching = 0;
const GROUP_LIMIT = 5;
const FINANCE_COMMENT_DAYS = 92;
const PHONE_LIKE_RE = /^[+\d\s().-]+$/;
const NUMBER_RE = /^\d{1,15}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MONTH_RE = /^(\d{2})\.(\d{2})$/;

export interface SearchGroup {
  type: 'client' | 'booking' | 'finance_operation' | 'staff';
  items: Array<Record<string, unknown>>;
  more: boolean;
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function queryDate(q: string, clock: Clock, tz: BranchInfo['timezone'] | undefined): LocalDate | null {
  try {
    if (ISO_DATE_RE.test(q)) return parseLocalDate(q);
    const m = DAY_MONTH_RE.exec(q);
    if (m && tz) return parseLocalDate(`${todayIn(clock, tz).slice(0, 4)}-${m[2]}-${m[1]}`);
  } catch {
    return null; // 31.02 – не дата, ищем дальше как текст
  }
  return null;
}

/** Клиенты: зона – через брони в rpt_bookings (searchClients по точному телефону зону не сужает: ему нужно находить для записи). */
async function clientGroup(tx: Tx, ctx: AccessContext, q: string): Promise<{ group: SearchGroup; ids: string[] } | null> {
  if (!roleAllows(ctx.role, 'client.view.basic')) return null;
  const links = { existsSql: (client: string, branches: string) => `EXISTS (SELECT 1 FROM app.rpt_bookings bk WHERE bk.client_id = ${client} AND bk.branch_id = ANY(${branches}))` };
  const found = (await searchClients(tx, ctx, { text: q }, { limit: GROUP_LIMIT * 4 }, links)).items;
  let branchOf = new Map<string, string>();
  let visible = found;
  if (!ctx.network) {
    const zone = [...ctx.branchIds];
    const r = await tx.query<{ client_id: string; branch_id: string }>(
      `SELECT client_id, min(branch_id::text) AS branch_id FROM app.rpt_bookings WHERE client_id = ANY($1::uuid[]) AND branch_id = ANY($2::uuid[]) GROUP BY client_id`,
      [found.map((c) => c.id), zone],
    );
    branchOf = new Map(r.rows.map((x) => [x.client_id, x.branch_id]));
    visible = found.filter((c) => branchOf.has(c.id));
  }
  const items = visible.slice(0, GROUP_LIMIT).map((c) => {
    const m: MaskedClient = maskClient(c, ctx, branchOf.get(c.id) ?? '');
    return { id: c.id, name: m.name, phone: m.phone, kind: m.kind };
  });
  return { group: { type: 'client', items, more: visible.length > GROUP_LIMIT }, ids: visible.map((c) => c.id) };
}

async function bookingGroup(tx: Tx, ctx: AccessContext, q: string, clientIds: string[], clock: Clock): Promise<SearchGroup | null> {
  if (!roleAllows(ctx.role, 'schedule.view')) return null;
  const branches = await resolveBranches(tx, ctx, 'schedule.view');
  if (branches.length === 0) return { type: 'booking', items: [], more: false };
  const date = queryDate(q, clock, branches[0]?.timezone);
  const number = NUMBER_RE.test(q) ? q : null;
  const parts: Array<{ sql: string; values?: unknown[] }> = [];
  if (number) parts.push({ sql: 't.number = ?::bigint', values: [number] });
  if (clientIds.length) parts.push({ sql: 't.client_id = ANY(?::uuid[])', values: [clientIds] });
  if (date) parts.push({ sql: '(t.start_at >= w.s AND t.start_at < w.e)' });
  if (parts.length === 0) return { type: 'booking', items: [], more: false };
  const day = date ?? todayIn(clock, branches[0]!.timezone);
  const w = where(
    { view: 'app.rpt_bookings', conds: [{ sql: parts.map((p) => p.sql).join(' OR '), values: parts.flatMap((p) => p.values ?? []) }] },
    windowsOf(branches, { from: day, to: day }),
  );
  const rows = (
    await tx.query<{ booking_id: string; number: string; branch_id: string; start_at: Date; status: string; resource_name: string }>(
      `SELECT t.booking_id, t.number, t.branch_id, t.start_at, t.status, t.resource_name FROM ${w.sql} ORDER BY t.start_at DESC, t.booking_id LIMIT ${GROUP_LIMIT + 1}`,
      w.params,
    )
  ).rows;
  const zones = new Map(branches.map((b) => [b.id, b]));
  return {
    type: 'booking',
    items: rows.slice(0, GROUP_LIMIT).map((r) => ({
      id: r.booking_id, number: Number(r.number), branchId: r.branch_id, branchName: zones.get(r.branch_id)?.name ?? '',
      startLocal: formatLocal(r.start_at, zones.get(r.branch_id)!.timezone, 'datetime'), status: r.status, resourceName: r.resource_name,
    })),
    more: rows.length > GROUP_LIMIT,
  };
}

async function financeGroup(tx: Tx, ctx: AccessContext, q: string, clock: Clock): Promise<SearchGroup | null> {
  if (!roleAllows(ctx.role, 'finance.view')) return null;
  const branches = await resolveBranches(tx, ctx, 'finance.view');
  if (branches.length === 0) return { type: 'finance_operation', items: [], more: false };
  const since = new Date(clock.now().getTime() - FINANCE_COMMENT_DAYS * 86_400_000);
  const today = todayIn(clock, branches[0]!.timezone);
  const conds = NUMBER_RE.test(q)
    ? [{ sql: 't.number = ?::bigint OR (t.occurred_at >= ?::timestamptz AND t.comment ILIKE ?)', values: [q, since, `%${escapeLike(q)}%`] }]
    : [{ sql: 't.occurred_at >= ?::timestamptz AND t.comment ILIKE ?', values: [since, `%${escapeLike(q)}%`] }];
  const w = where({ view: 'app.rpt_finance_operations', conds }, windowsOf(branches, { from: today, to: today }));
  const rows = (
    await tx.query<{ operation_id: string; number: string; branch_id: string; original_kind: string; amount_kop: string; occurred_at: Date; comment: string | null }>(
      `SELECT t.operation_id, t.number, t.branch_id, t.original_kind, t.amount_kop, t.occurred_at, t.comment FROM ${w.sql} ORDER BY t.occurred_at DESC, t.number DESC LIMIT ${GROUP_LIMIT + 1}`,
      w.params,
    )
  ).rows;
  return {
    type: 'finance_operation',
    items: rows.slice(0, GROUP_LIMIT).map((r) => ({ id: r.operation_id, number: Number(r.number), branchId: r.branch_id, kind: r.original_kind, amountKop: Number(r.amount_kop), occurredAt: r.occurred_at.toISOString(), comment: r.comment })),
    more: rows.length > GROUP_LIMIT,
  };
}

/** Сотрудники: Владелец – все, Директор – у кого есть назначение на филиал или город его зоны (TC-16). */
async function staffGroup(tx: Tx, ctx: AccessContext, q: string): Promise<SearchGroup | null> {
  if (!roleAllows(ctx.role, 'staff.view')) return null;
  let zone: { branchIds: string[]; cityIds: string[] } | null = null;
  if (!ctx.network) {
    const branchIds = [...ctx.branchIds];
    zone = { branchIds, cityIds: [...new Set([...(await getBranches(tx, branchIds)).values()].map((b) => b.cityId))] };
  }
  const rows = await searchStaffByName(tx, { text: q, zone, limit: GROUP_LIMIT + 1 });
  return {
    type: 'staff',
    items: rows.slice(0, GROUP_LIMIT).map((r) => ({ id: r.id, name: `${r.firstName} ${r.lastName}`, role: r.role })),
    more: rows.length > GROUP_LIMIT,
  };
}

export async function globalSearch(
  deps: { pool: Db & { connect: ReportsPool['connect'] }; clock: Clock; signal?: AbortSignal | undefined },
  ctx: AccessContext,
  meta: AuditRequestMeta,
  raw: unknown,
): Promise<{ groups: SearchGroup[] }> {
  if (!roleAllows(ctx.role, 'search.global')) throw new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action: 'search.global' });
  const q = typeof raw === 'string' ? raw.trim() : '';
  const digits = q.replace(/\D/g, '');
  const isDate = ISO_DATE_RE.test(q) || DAY_MONTH_RE.test(q);
  const phoneLike = !isDate && PHONE_LIKE_RE.test(q);
  // номер брони и операции тоже из цифр: короткий запрос отвергается только когда это не номер
  if (q.length < 2 || q.length > 100) throw new AppError('SEARCH_QUERY_TOO_SHORT', 422, 'Введите не меньше 2 символов', { min: 2 });
  if (phoneLike && digits.length < 4 && !NUMBER_RE.test(q)) throw new AppError('SEARCH_QUERY_TOO_SHORT', 422, 'Для поиска по телефону нужно от 4 цифр', { min: 4 });
  if (searching >= MAX_CONCURRENT_SEARCHES) throw new AppError('RATE_LIMITED', 429, 'Слишком много одновременных поисков, повторите запрос');
  searching += 1;
  const groups = await withReportTx(
    { connect: () => deps.pool.connect(), end: async () => {} },
    async (tx) => {
      const out: SearchGroup[] = [];
      const canSearchClients = !isDate && (!phoneLike || digits.length >= 4);
      const clients = canSearchClients ? await clientGroup(tx, ctx, q) : null;
      if (clients) out.push(clients.group);
      else if (roleAllows(ctx.role, 'client.view.basic')) out.push({ type: 'client', items: [], more: false });
      const bookings = await bookingGroup(tx, ctx, q, clients?.ids ?? [], deps.clock);
      if (bookings) out.push(bookings);
      const finance = await financeGroup(tx, ctx, q, deps.clock);
      if (finance) out.push(finance);
      const staff = phoneLike || isDate ? null : await staffGroup(tx, ctx, q);
      if (staff) out.push(staff);
      else if (roleAllows(ctx.role, 'staff.view')) out.push({ type: 'staff', items: [], more: false });
      return out;
    },
    { timeoutMs: SEARCH_TIMEOUT_MS, budgetMs: SEARCH_BUDGET_MS, signal: deps.signal },
  ).finally(() => {
    searching -= 1;
  });
  // перебор телефонов виден в журнале: номер – в поле phone, redact маскирует его (K2 PD_KEYS)
  if (phoneLike && digits.length >= 4) {
    await writeAudit(deps.pool, meta, { action: 'client.searched', object: { type: 'client', id: null }, after: { phone: q } }, deps.clock);
  }
  return { groups };
}
