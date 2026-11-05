// S2-15. Сводка кассы филиала и сети (K17 §9, №48; 06 §11.1–11.2, 11.4; 16 §14; 18 §6.5).
// Каждое число – сумма своих операций журнала кассы (TC-20 для кассы): сторно и исправления относятся к виду исходной
// операции со знаком минус, поэтому сводка по видам совпадает с детализацией. Сутки – по зоне филиала (K8), а не TZ машины.
// Формула на место: closing = opening + income − expense − withdrawal + transferIn − transferOut + correction − refund;
// результат = income − expense − refund: изъятия и переводы между местами – не доход и не расход (06 §4.3, §11.4).
// Начальный остаток, внесённый в периоде, входит в opening (06 §3.2: «остаток на начало» отдельно от результата).
// Деньги отдельно от баллов и погашений (06 §11.2): nonMoney – по платежам сеансов и журналу K3 сертификатов, касса их не видит.
import type { Db } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { scopeFilter, type AccessContext } from '../../core/permissions.ts';
import { addDays, branchDay, parseLocalDate, type LocalDate } from '../../core/time.ts';
import { getBranches, type BranchInfo } from '../network/index.ts';
import { guardFinance, type IncomeSource, type MoneyPlace, type OperationKind, type OperationMethod } from './cashbox.ts';

export interface PlaceSummary {
  place: MoneyPlace;
  openingKop: number;
  incomeKop: number;
  expenseKop: number;
  withdrawalKop: number;
  transferInKop: number;
  transferOutKop: number;
  correctionKop: number;
  refundKop: number;
  closingKop: number;
}

export interface CashSummaryDto {
  branchId: string;
  from: LocalDate;
  to: LocalDate;
  timezone: string;
  places: PlaceSummary[];
  total: { openingKop: number; incomeKop: number; expenseKop: number; resultKop: number; closingKop: number; operationsCount: number };
  incomeBySource: Record<IncomeSource, number>;
  incomeByMethod: Record<OperationMethod, number>;
  expenseByCategory: Array<{ categoryId: string; name: string; amountKop: number; sub: Array<{ subcategoryId: string; name: string; amountKop: number }> }>;
  nonMoney: { pointsSessions: number; pointsCenti: number; certificateRedeemedKop: number; certificateBurnedKop: number };
}

interface OpRow {
  kind: OperationKind;
  place: MoneyPlace;
  method: OperationMethod | null;
  direction: 'in' | 'out';
  amount_kop: string;
  source: IncomeSource | null;
  category_id: string | null;
  subcategory_id: string | null;
  occurred_at: Date;
  // для сторно – вид и разметка исходной
  o_kind: OperationKind | null;
  o_source: IncomeSource | null;
  o_method: OperationMethod | null;
  o_category_id: string | null;
  o_subcategory_id: string | null;
}

const PLACES: MoneyPlace[] = ['cash', 'noncash'];
const MAX_DAYS = 366;

function emptyPlace(place: MoneyPlace): PlaceSummary {
  return { place, openingKop: 0, incomeKop: 0, expenseKop: 0, withdrawalKop: 0, transferInKop: 0, transferOutKop: 0, correctionKop: 0, refundKop: 0, closingKop: 0 };
}

/** Вклад операции (сторно – со знаком минус к виду исходной) в строки места; inPeriod=false – только в opening. */
function apply(places: Record<MoneyPlace, PlaceSummary>, r: OpRow, inPeriod: boolean): void {
  const reversal = r.kind === 'reversal';
  const kind = reversal ? r.o_kind! : r.kind;
  const sign = reversal ? -1 : 1;
  const amt = Number(r.amount_kop) * sign;
  const other: MoneyPlace = r.place === 'cash' ? 'noncash' : 'cash';
  const p = places[r.place];
  if (!inPeriod || kind === 'opening_balance') {
    // до периода – всё в остаток на начало; начальный остаток в периоде – тоже в opening
    if (kind === 'place_transfer') {
      p.openingKop -= amt;
      places[other].openingKop += amt;
    } else {
      const dir = reversal ? (r.direction === 'in' ? 'out' : 'in') : r.direction; // направление исходной
      p.openingKop += dir === 'in' ? amt : -amt;
    }
    return;
  }
  switch (kind) {
    case 'income':
      p.incomeKop += amt;
      break;
    case 'expense':
      p.expenseKop += amt;
      break;
    case 'withdrawal':
      p.withdrawalKop += amt;
      break;
    case 'refund':
      p.refundKop += amt;
      break;
    case 'place_transfer':
      p.transferOutKop += amt;
      places[other].transferInKop += amt;
      break;
    case 'correction': {
      const dir = reversal ? (r.direction === 'in' ? 'out' : 'in') : r.direction;
      p.correctionKop += dir === 'in' ? amt : -amt;
      break;
    }
    default:
      break;
  }
}

async function summaryOf(db: Db, branch: BranchInfo, from: LocalDate, to: LocalDate): Promise<CashSummaryDto> {
  const start = branchDay(from, branch.timezone).start;
  const end = branchDay(to, branch.timezone).end;
  const r = await db.query<OpRow>(
    // одно определение с отчётом K24 §3.4: у сторно источник, способ и статьи – исходной операции (0407)
    `SELECT kind, place, method, direction, amount_kop, source, category_id, subcategory_id, occurred_at,
            original_kind AS o_kind, source AS o_source, method AS o_method, category_id AS o_category_id, subcategory_id AS o_subcategory_id
     FROM app.rpt_finance_operations
     WHERE branch_id = $1 AND occurred_at < $2 ORDER BY occurred_at, number`,
    [branch.id, end],
  );
  const places = { cash: emptyPlace('cash'), noncash: emptyPlace('noncash') };
  const bySource: Record<IncomeSource, number> = { session: 0, certificate_sale: 0, event: 0, extra_service: 0, other: 0 };
  const byMethod: Record<OperationMethod, number> = { cash: 0, card: 0, transfer: 0 };
  const byCat = new Map<string, { amount: number; sub: Map<string, number> }>();
  let count = 0;
  for (const row of r.rows) {
    const inPeriod = row.occurred_at.getTime() >= start.getTime();
    apply(places, row, inPeriod);
    if (!inPeriod) continue;
    count++;
    const reversal = row.kind === 'reversal';
    const kind = reversal ? row.o_kind : row.kind;
    const amt = Number(row.amount_kop) * (reversal ? -1 : 1);
    if (kind === 'income') {
      bySource[(reversal ? row.o_source : row.source)!] += amt;
      const m = reversal ? row.o_method : row.method;
      if (m) byMethod[m] += amt;
    }
    if (kind === 'expense') {
      const cat = (reversal ? row.o_category_id : row.category_id)!;
      const sub = reversal ? row.o_subcategory_id : row.subcategory_id;
      const c = byCat.get(cat) ?? { amount: 0, sub: new Map<string, number>() };
      c.amount += amt;
      if (sub) c.sub.set(sub, (c.sub.get(sub) ?? 0) + amt);
      byCat.set(cat, c);
    }
  }
  for (const place of PLACES) {
    const p = places[place];
    p.closingKop = p.openingKop + p.incomeKop - p.expenseKop - p.withdrawalKop + p.transferInKop - p.transferOutKop + p.correctionKop - p.refundKop;
  }
  const names = byCat.size
    ? new Map(
        (
          await db.query<{ id: string; name: string }>(`SELECT id, name FROM app.finance_categories WHERE id = ANY($1::uuid[])`, [
            [...byCat.keys(), ...[...byCat.values()].flatMap((c) => [...c.sub.keys()])],
          ])
        ).rows.map((x) => [x.id, x.name]),
      )
    : new Map<string, string>();
  const sum = (f: (p: PlaceSummary) => number) => PLACES.reduce((s, pl) => s + f(places[pl]), 0);
  const income = sum((p) => p.incomeKop);
  const expense = sum((p) => p.expenseKop);
  const refund = sum((p) => p.refundKop);

  // не деньги (06 §11.2): платежи сеансов филиала, проведённые в периоде, и журнал K3 сертификатов филиала
  const pts = await db.query<{ n: number; centi: string | null }>(
    `SELECT count(*)::int AS n, sum(l.points_centi)::text AS centi FROM app.payment_lines l
     JOIN app.payments p ON p.id = l.payment_id JOIN app.payment_sessions s ON s.booking_id = p.session_id
     WHERE s.branch_id = $1 AND l.method = 'points' AND p.status <> 'refunded' AND p.recorded_at >= $2 AND p.recorded_at < $3`,
    [branch.id, start, end],
  );
  const cert = await db.query<{ redeemed: string | null; burned: string | null }>(
    `SELECT sum(CASE WHEN coalesce(o.entry_type, e.entry_type) = 'certificate.redeem' THEN -e.amount END)::text AS redeemed,
            sum(CASE WHEN coalesce(o.entry_type, e.entry_type) = 'certificate.expire' THEN -e.amount END)::text AS burned
     FROM journal.ledger_entries e LEFT JOIN journal.ledger_entries o ON o.id = e.reversal_of
     WHERE e.branch_id = $1 AND e.occurred_at >= $2 AND e.occurred_at < $3
       AND coalesce(o.entry_type, e.entry_type) IN ('certificate.redeem', 'certificate.expire')`,
    [branch.id, start, end],
  );
  return {
    branchId: branch.id,
    from,
    to,
    timezone: branch.timezone,
    places: PLACES.map((p) => places[p]),
    total: {
      openingKop: sum((p) => p.openingKop),
      incomeKop: income,
      expenseKop: expense,
      resultKop: income - expense - refund,
      closingKop: sum((p) => p.closingKop),
      operationsCount: count,
    },
    incomeBySource: bySource,
    incomeByMethod: byMethod,
    expenseByCategory: [...byCat.entries()].map(([categoryId, c]) => ({
      categoryId,
      name: names.get(categoryId) ?? '',
      amountKop: c.amount,
      sub: [...c.sub.entries()].map(([subcategoryId, amountKop]) => ({ subcategoryId, name: names.get(subcategoryId) ?? '', amountKop })),
    })),
    nonMoney: {
      pointsSessions: pts.rows[0]?.n ?? 0,
      pointsCenti: Number(pts.rows[0]?.centi ?? 0),
      certificateRedeemedKop: Number(cert.rows[0]?.redeemed ?? 0),
      certificateBurnedKop: Number(cert.rows[0]?.burned ?? 0),
    },
  };
}

function period(fromRaw: unknown, toRaw: unknown): { from: LocalDate; to: LocalDate } {
  if (typeof fromRaw !== 'string') throw new AppError('VALIDATION_FAILED', 400, 'Укажите from', { field: 'from' });
  const from = parseLocalDate(fromRaw);
  const to = typeof toRaw === 'string' ? parseLocalDate(toRaw) : from;
  if (to < from || addDays(from, MAX_DAYS) <= to) throw new AppError('VALIDATION_FAILED', 400, `Период – от 1 до ${MAX_DAYS} дней`, { field: 'to' });
  return { from, to };
}

/** K17 №48: сводка филиала (finance.view; вне зоны – 404). */
export async function branchSummary(db: Db, ctx: AccessContext, input: { branchId: string; from: unknown; to?: unknown }): Promise<CashSummaryDto> {
  const branch = await guardFinance(db, ctx, input.branchId, 'finance.view', { action: 'finance.operation.created' });
  const { from, to } = period(input.from, input.to);
  return summaryOf(db, branch, from, to);
}

/** K17 №48 (сеть, 06 §11.4): сводка по каждому филиалу зоны с кассой и сумма; переводов между филиалами в Э2 нет. */
export async function networkSummary(
  db: Db,
  ctx: AccessContext,
  input: { from: unknown; to?: unknown },
): Promise<{ branches: CashSummaryDto[]; total: CashSummaryDto['total'] & { nonMoney: CashSummaryDto['nonMoney'] } }> {
  const scope = scopeFilter(ctx, 'finance.view');
  if (scope.kind === 'none') throw new AppError('FORBIDDEN', 403, 'Недостаточно прав', { action: 'finance.view' });
  const { from, to } = period(input.from, input.to);
  const ids = (
    await db.query<{ id: string }>(
      `SELECT DISTINCT owner_id AS id FROM app.ledger_accounts WHERE kind IN ('cash_branch','cash_branch_noncash') AND owner_type = 'branch'
         AND ($1::uuid[] IS NULL OR owner_id = ANY($1::uuid[])) ORDER BY 1`,
      [scope.kind === 'all' ? null : scope.branchIds],
    )
  ).rows.map((x) => x.id);
  const info = await getBranches(db, ids);
  const branches: CashSummaryDto[] = [];
  for (const id of ids) if (info.get(id)) branches.push(await summaryOf(db, info.get(id)!, from, to));
  const add = <K extends keyof CashSummaryDto['total']>(k: K) => branches.reduce((s, b) => s + b.total[k], 0);
  const nm = <K extends keyof CashSummaryDto['nonMoney']>(k: K) => branches.reduce((s, b) => s + b.nonMoney[k], 0);
  return {
    branches,
    total: {
      openingKop: add('openingKop'), incomeKop: add('incomeKop'), expenseKop: add('expenseKop'), resultKop: add('resultKop'),
      closingKop: add('closingKop'), operationsCount: add('operationsCount'),
      nonMoney: { pointsSessions: nm('pointsSessions'), pointsCenti: nm('pointsCenti'), certificateRedeemedKop: nm('certificateRedeemedKop'), certificateBurnedKop: nm('certificateBurnedKop') },
    },
  };
}
