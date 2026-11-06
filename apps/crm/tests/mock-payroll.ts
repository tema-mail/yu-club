// Мок зарплаты строго по apps/api/src/modules/shifts/routes.payroll.ts, payroll.ts, penalties.ts, payout-expense.ts, report.ts (K18 №311–318): периоды,
// ведомости, выплата, расход, штрафы за флагом payroll.penalties_enabled, корректировки, отчёт. Состояние и проверки смен – mock-shifts-staff.ts.
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { addDays, inZone } from '../src/lib/booking.ts';
import {
  accrualOf, assertOpen, computeTotals, DATE_RE, dto, entries, expenses, Fail, forbidden, invalid, nextSeq, notFound, penalties, periodOf, periods, rateAt, shifts, statements, TZ, unresolved,
  type Entry, type Penalty, type Period, type Rec, type ShiftsHelpers, type Staffish, type Statement, type StatementStatus,
} from './mock-shifts-staff.ts';

export function registerPayroll(app: FastifyInstance, P: string, h: ShiftsHelpers): void {
  const { deps, branchOf, tzOf, inZ, can, assertCan, owner, viewer, read, command, send, staffOf, staffBranches, reasonOf, dateRange, coverageOf } = h;

  // ---- зарплата

  const zoneOfStatement = (s: Staffish, staffId: string, range: { from: string; to: string }) => {
    const set = new Set<string>();
    for (const x of shifts) if (x.staffId === staffId && x.localDate >= range.from && x.localDate <= range.to) set.add(x.branchId);
    for (const e of entries) if (e.staffId === staffId && e.branchId && e.date >= range.from && e.date <= range.to) set.add(e.branchId);
    return [...set].filter((b) => inZ(s, b));
  };
  const rangeOf = (st: Statement) => {
    const p = periods.find((x) => x.id === st.periodId)!;
    return { from: p.from, to: p.to };
  };
  const statementDto = (s: Staffish, st: Statement) => {
    const range = rangeOf(st);
    const net = deps.zone(s).network;
    const { totals, byBranch } = net ? { totals: st.totals, byBranch: st.byBranch } : computeTotals(range, st.staffId, zoneOfStatement(s, st.staffId, range));
    const needsReview = unresolved(range, Date.now(), st.staffId).filter((u) => net || inZ(s, u.branchId)).map((u) => ({ shiftId: u.shiftId, reason: u.reason }));
    return { id: st.id, periodId: st.periodId, staffId: st.staffId, status: st.status, totals, byBranch, plannedPayoutDate: st.plannedPayoutDate, actualPayoutDate: st.actualPayoutDate, payoutComment: st.payoutComment, needsReview, rowVersion: st.rowVersion };
  };
  /** readStatement: нет – 404; чужая зона Директора – 404; без права – 403. */
  const readStatement = (s: Staffish, id: string, right = 'payroll.view') => {
    const st = statements.find((x) => x.id === id);
    if (!st) throw notFound();
    viewer(s);
    if (!deps.zone(s).network && zoneOfStatement(s, st.staffId, rangeOf(st)).length === 0) throw notFound();
    owner(s, right);
    return st;
  };
  const staffInPeriod = (range: { from: string; to: string }) => [...new Set([...shifts.filter((x) => x.localDate >= range.from && x.localDate <= range.to).map((x) => x.staffId), ...entries.filter((e) => e.date >= range.from && e.date <= range.to).map((e) => e.staffId)])];
  const findPeriod = (id: string) => {
    const p = periods.find((x) => x.id === id);
    if (!p) throw notFound();
    return p;
  };
  const openDate = () => periods.filter((p) => p.status === 'open').map((p) => p.from).sort()[0] ?? addDays(periods.map((p) => p.to).sort().at(-1) ?? inZone(Date.now(), TZ).date, 1);

  app.get(`${P}/payroll/periods`, read((s) => {
    viewer(s);
    return { items: [...periods].sort((a, b) => (a.from < b.from ? 1 : -1)) };
  }));
  app.post(`${P}/payroll/periods`, command('payroll.period.create', 201, (s, _p, b) => {
    owner(s, 'payroll.period.manage');
    if (typeof b.from !== 'string' || typeof b.to !== 'string') throw invalid('Нужны даты from и to');
    if (!DATE_RE.test(b.from) || !DATE_RE.test(b.to)) throw invalid('Даты – ГГГГ-ММ-ДД');
    if (b.to < b.from) throw invalid('Конец периода раньше начала');
    const { from, to } = b as { from: string; to: string };
    if (periods.some((p) => p.from <= to && from <= p.to)) throw new Fail(409, 'PAYROLL_PERIOD_OVERLAP', 'Период пересекается с существующим');
    const last = periods.map((p) => p.to).sort().at(-1);
    if (last && from !== addDays(last, 1)) throw new Fail(409, 'PAYROLL_PERIOD_GAP', 'Периоды идут без разрывов: новый начинается сразу за последним', { expectedFrom: addDays(last, 1) });
    const p: Period = { id: randomUUID(), from, to, status: 'open', closedAt: null, closedBy: null };
    periods.push(p);
    return p;
  }));
  app.post(`${P}/payroll/periods/:id/close`, command('payroll.period.close', 200, (s, p) => {
    owner(s, 'payroll.period.manage');
    const period = findPeriod(p.id!);
    if (period.status === 'closed') throw new Fail(409, 'PAYROLL_PERIOD_CLOSED', 'Период уже закрыт', { periodId: period.id });
    const range = { from: period.from, to: period.to };
    const bad = unresolved(range, null);
    if (bad.length > 0) throw new Fail(409, 'PAYROLL_PERIOD_HAS_UNRESOLVED', 'В периоде есть нерешённые смены или необработанные ставки', { shiftIds: [...new Set(bad.map((x) => x.shiftId))], rateIds: [], reasons: bad });
    for (const staffId of staffInPeriod(range)) {
      const { totals, byBranch } = computeTotals(range, staffId);
      const st = statements.find((x) => x.periodId === period.id && x.staffId === staffId);
      if (st) Object.assign(st, { totals, byBranch, status: st.status === 'draft' ? 'calculated' : st.status, rowVersion: st.rowVersion + 1 });
      else statements.push({ id: randomUUID(), periodId: period.id, staffId, status: 'calculated', totals, byBranch, plannedPayoutDate: null, actualPayoutDate: null, payoutComment: null, rowVersion: 1 });
    }
    Object.assign(period, { status: 'closed', closedAt: new Date().toISOString(), closedBy: s.id });
    return period;
  }));
  app.post(`${P}/payroll/periods/:id/calculate`, command('payroll.calculate', 200, (s, p) => {
    owner(s, 'payroll.statement.review');
    const period = findPeriod(p.id!);
    const range = { from: period.from, to: period.to };
    let ids = staffInPeriod(range);
    if (!deps.zone(s).network) ids = ids.filter((id) => zoneOfStatement(s, id, range).length > 0);
    if (period.status === 'open') {
      for (const staffId of ids) {
        const { totals, byBranch } = computeTotals(range, staffId);
        const st = statements.find((x) => x.periodId === period.id && x.staffId === staffId);
        if (!st) statements.push({ id: randomUUID(), periodId: period.id, staffId, status: 'calculated', totals, byBranch, plannedPayoutDate: null, actualPayoutDate: null, payoutComment: null, rowVersion: 1 });
        else if (st.status === 'draft' || st.status === 'calculated') Object.assign(st, { totals, byBranch, status: 'calculated', rowVersion: st.rowVersion + 1 });
      }
    }
    return statements.filter((x) => x.periodId === period.id && ids.includes(x.staffId)).map((x) => statementDto(s, x));
  }));
  app.get(`${P}/payroll/periods/:id/statements`, read((s, req) => {
    viewer(s);
    const id = (req.params as { id: string }).id;
    return { items: statements.filter((x) => x.periodId === id && (deps.zone(s).network || zoneOfStatement(s, x.staffId, rangeOf(x)).length > 0)).map((x) => statementDto(s, x)) };
  }));
  app.get(`${P}/payroll/statements/:id`, read((s, req) => statementDto(s, readStatement(s, (req.params as { id: string }).id))));
  const TRANSITIONS: Record<StatementStatus, StatementStatus[]> = { draft: [], calculated: ['checked', 'disputed'], checked: ['ready', 'disputed'], ready: ['disputed'], disputed: ['calculated'], paid: [] };
  app.post(`${P}/payroll/statements/:id/status`, command('payroll.statement.status', 200, (s, p, b) => {
    const to = b.status as StatementStatus;
    if (!Number.isInteger(b.rowVersion) || !['checked', 'ready', 'disputed', 'calculated'].includes(to)) throw invalid();
    const st = readStatement(s, p.id!, to === 'ready' ? 'payroll.statement.ready' : 'payroll.statement.review');
    if (st.rowVersion !== b.rowVersion) throw new Fail(409, 'VERSION_CONFLICT', 'Ведомость уже изменили, обновите данные', { rowVersion: st.rowVersion });
    if (!TRANSITIONS[st.status].includes(to)) throw invalid(`Переход ${st.status} → ${to} не разрешён`, { from: st.status, to });
    if (to === 'ready') {
      if (periods.find((x) => x.id === st.periodId)!.status !== 'closed') throw new Fail(409, 'PAYROLL_PERIOD_OPEN', 'Сначала закройте расчётный период', { periodId: st.periodId });
      const open = unresolved(rangeOf(st), Date.now(), st.staffId);
      if (open.length > 0) throw new Fail(409, 'PAYROLL_STATEMENT_NEEDS_REVIEW', 'В ведомости есть нерешённые смены', { needsReview: open });
    }
    Object.assign(st, { status: to, rowVersion: st.rowVersion + 1 });
    if (typeof b.comment === 'string' && b.comment.trim()) st.payoutComment = b.comment.trim();
    return statementDto(s, st);
  }));
  app.post(`${P}/payroll/statements/:id/paid`, command('payroll.paid', 200, (s, p, b) => {
    owner(s, 'payroll.payout.mark');
    if (!Number.isInteger(b.rowVersion) || typeof b.actualPayoutDate !== 'string') throw invalid();
    if (!DATE_RE.test(b.actualPayoutDate)) throw invalid('Дата выплаты – ГГГГ-ММ-ДД', { field: 'actualPayoutDate' });
    const st = readStatement(s, p.id!, 'payroll.payout.mark');
    if (st.status === 'paid') return statementDto(s, st);
    if (st.rowVersion !== b.rowVersion) throw new Fail(409, 'VERSION_CONFLICT', 'Ведомость уже изменили, обновите данные', { rowVersion: st.rowVersion });
    if (periods.find((x) => x.id === st.periodId)!.status !== 'closed') throw new Fail(409, 'PAYROLL_PERIOD_OPEN', 'Сначала закройте расчётный период', { periodId: st.periodId });
    if (st.status !== 'ready') throw invalid(`Выплатить можно только ведомость в статусе ready, сейчас ${st.status}`, { from: st.status, to: 'paid' });
    Object.assign(st, { status: 'paid', actualPayoutDate: b.actualPayoutDate, rowVersion: st.rowVersion + 1 });
    if (typeof b.comment === 'string' && b.comment.trim()) st.payoutComment = b.comment.trim();
    return statementDto(s, st);
  }));
  /** createPayoutExpense: только после paid, один живой расход на ведомость; разбивка по филиалам – пропорционально начисленному. */
  app.post(`${P}/payroll/statements/:id/payout-expense`, command('payroll.payout_expense', 201, (s, p, b) => {
    if (!['cash', 'noncash'].includes(b.place as string) || !['cash', 'card', 'transfer'].includes(b.method as string) || typeof b.occurredAt !== 'string') throw invalid();
    if ((b.method === 'cash') !== (b.place === 'cash')) throw invalid('Способ не подходит к месту денег', { field: 'method' });
    const st = readStatement(s, p.id!, 'payroll.payout.expense');
    if (st.status !== 'paid') throw invalid('Расход создаётся только после отметки «Выплачен»', { reason: 'statement_not_paid', status: st.status });
    const toPay = st.totals.toPayKop;
    if (toPay <= 0) throw invalid('По ведомости нет выплаты: расход не нужен', { reason: 'nothing_paid', toPayKop: toPay });
    if (expenses.has(st.id)) throw new Fail(409, 'PAYOUT_EXPENSE_EXISTS', 'Расход по этой выплате уже создан', { operationIds: expenses.get(st.id) });
    const split = b.split ?? 'by_branch';
    let list: Array<{ branchId: string; amountKop: number }>;
    if (split === 'by_branch') {
      const lines = st.byBranch.filter((l) => l.accruedKop > 0).sort((x, y) => y.accruedKop - x.accruedKop);
      const sum = lines.reduce((a, l) => a + l.accruedKop, 0);
      if (lines.length === 0) throw new Fail(422, 'BRANCH_REQUIRED', 'В ведомости нет начислений по филиалам: выберите филиал расхода');
      list = lines.map((l) => ({ branchId: l.branchId, amountKop: Math.floor((toPay * l.accruedKop) / sum) }));
      list[0]!.amountKop += toPay - list.reduce((a, x) => a + x.amountKop, 0);
    } else {
      const id = (split as { branchId?: string }).branchId;
      if (!id || !branchOf(id)) throw notFound();
      list = [{ branchId: id, amountKop: toPay }];
    }
    const operations = list.map((x) => ({ id: randomUUID(), kind: 'expense', branchId: x.branchId, place: b.place, method: b.method, amountKop: x.amountKop, occurredAt: b.occurredAt, comment: (typeof b.comment === 'string' && b.comment.trim()) || 'Выплата зарплаты', ref: { type: 'staff', id: st.staffId } }));
    expenses.set(st.id, operations.map((o) => o.id));
    return { operations };
  }));

  // ---- штрафы, премии, корректировки

  const flag = async () => {
    const r = await app.inject({ method: 'GET', url: `${P}/settings?scope=network`, headers: { cookie: deps.ownerCookie() } });
    return (r.json() as { items: Array<{ key: string; value: unknown }> }).items.find((i) => i.key === 'payroll.penalties_enabled')?.value === true;
  };
  const penaltyEntry = (x: Penalty, sign: 1 | -1, basis: string): Entry => ({ id: String(nextSeq()), staffId: x.staffId, date: x.date, type: x.kind === 'bonus' ? 'payroll.bonus' : 'payroll.penalty', kind: x.kind === 'bonus' ? 'payroll.bonus' : 'payroll.penalty', branchId: x.branchId, amountKop: sign * (x.kind === 'bonus' ? x.amountKop : -x.amountKop), basis, ref: { type: 'payroll_penalty', id: x.id } });
  const amountOf = (v: unknown) => {
    if (!Number.isSafeInteger(v) || (v as number) <= 0) throw new Fail(422, 'INVALID_AMOUNT', 'Сумма – целое число копеек больше нуля');
    return v as number;
  };
  const guardTarget = (s: Staffish, staffId: string, branchId: string | null) => {
    if (!deps.can(s, 'payroll.penalty.manage')) throw forbidden('payroll.penalty.manage');
    const t = staffOf(staffId);
    if (!t) throw notFound();
    if (deps.zone(s).network) {
      if (branchId !== null && !branchOf(branchId)) throw notFound();
      return;
    }
    if (branchId === null) {
      if (!staffBranches(t).some((b) => inZ(s, b))) throw notFound();
      throw new Fail(422, 'BRANCH_REQUIRED', 'Укажите филиал: без филиала запись ставит только Владелец');
    }
    assertCan(s, 'payroll.penalty.manage', branchId);
  };
  const lockedPenalty = (s: Staffish, id: string) => {
    const x = penalties.find((y) => y.id === id);
    if (!x) throw notFound();
    guardTarget(s, x.staffId, x.branchId);
    return x;
  };
  app.get(`${P}/payroll/penalties`, read((s, req) => {
    viewer(s);
    const q = req.query as { staffId?: string; periodId?: string };
    const p = q.periodId ? periods.find((x) => x.id === q.periodId) : null;
    return { items: penalties.filter((x) => (deps.zone(s).network || (x.branchId !== null && inZ(s, x.branchId))) && (!q.staffId || x.staffId === q.staffId) && (!p || (x.date >= p.from && x.date <= p.to))).reverse() };
  }));
  app.post(`${P}/payroll/penalties`, command('payroll.penalty.create', 201, async (s, _p, b) => {
    const branchId = (b.branchId as string | null | undefined) ?? null;
    guardTarget(s, String(b.staffId ?? ''), branchId);
    if (!(await flag())) throw new Fail(409, 'FEATURE_DISABLED', 'Штрафы выключены до юридической проверки', { setting: 'payroll.penalties_enabled' });
    const reason = reasonOf(b.reason);
    const amountKop = amountOf(b.amountKop);
    if (typeof b.date !== 'string' || !DATE_RE.test(b.date)) throw invalid('Дата – ГГГГ-ММ-ДД', { field: 'date' });
    assertOpen(b.date);
    const x: Penalty = { id: randomUUID(), kind: 'penalty', staffId: String(b.staffId), branchId, date: b.date, amountKop, reason, comment: (typeof b.comment === 'string' && b.comment.trim()) || null, status: 'active', periodId: periodOf(b.date)?.id ?? null, authorId: s.id, postingId: randomUUID(), cancelReason: null, replacedBy: null };
    penalties.push(x);
    entries.push(penaltyEntry(x, 1, reason));
    return x;
  }));
  app.post(`${P}/payroll/penalties/:id/cancel`, command('payroll.penalty.cancel', 200, (s, p, b) => {
    const reason = reasonOf(b.reason);
    const x = lockedPenalty(s, p.id!);
    if (x.status !== 'active') throw new Fail(409, 'ALREADY_REVERSED', 'Запись уже отменена');
    entries.push(penaltyEntry(x, -1, reason));
    Object.assign(x, { status: 'cancelled', cancelReason: reason });
    return x;
  }));
  app.post(`${P}/payroll/penalties/:id/amend`, command('payroll.penalty.amend', 200, (s, p, b) => {
    const why = reasonOf(b.why, 'why');
    const x = lockedPenalty(s, p.id!);
    assertOpen(x.date);
    if (x.status !== 'active') throw new Fail(409, 'ALREADY_REVERSED', 'Запись уже отменена');
    const amountKop = b.amountKop === undefined ? x.amountKop : amountOf(b.amountKop);
    const reason = b.reason === undefined ? x.reason : reasonOf(b.reason);
    const next: Penalty = { ...x, id: randomUUID(), amountKop, reason, comment: b.comment === undefined ? x.comment : (typeof b.comment === 'string' && b.comment.trim()) || null, postingId: randomUUID() };
    entries.push(penaltyEntry(x, -1, why));
    entries.push(penaltyEntry(next, 1, reason));
    Object.assign(x, { status: 'cancelled', cancelReason: why, replacedBy: next.id });
    penalties.push(next);
    return next;
  }));
  app.post(`${P}/payroll/corrections`, command('payroll.correction', 201, (s, _p, b) => {
    owner(s, 'payroll.correct');
    const ref = b.ref as { type?: string; id?: string } | undefined;
    if (typeof b.staffId !== 'string' || !ref || !['shift', 'payroll_statement'].includes(ref.type ?? '') || typeof ref.id !== 'string') throw invalid();
    if (!Number.isSafeInteger(b.amountKop) || b.amountKop === 0) throw new Fail(422, 'INVALID_AMOUNT', 'Сумма – целое ненулевое число копеек');
    const reason = reasonOf(b.reason);
    let branchId: string | null = null;
    if (ref.type === 'shift') {
      const x = shifts.find((y) => y.id === ref.id && y.staffId === b.staffId);
      if (!x) throw notFound();
      branchId = x.branchId;
    } else if (!statements.some((y) => y.id === ref.id && y.staffId === b.staffId)) throw notFound();
    const date = openDate();
    entries.push({ id: String(nextSeq()), staffId: b.staffId, date, type: 'payroll.correction', kind: 'payroll.correction', branchId, amountKop: b.amountKop as number, basis: reason, ref: { type: ref.type!, id: ref.id } });
    return { postingId: randomUUID(), date };
  }));

  // ---- отчёт №318

  app.get(`${P}/payroll/report`, async (req, reply) => {
    const s = deps.current(req);
    try {
      viewer(s);
      reply.header('cache-control', 'no-store');
      return report(s, req.query as Record<string, string | undefined>);
    } catch (e) {
      return send(reply, e);
    }
  });
  function report(s: Staffish, q: Record<string, string | undefined>) {
    let range: { from: string; to: string };
    let periodId: string | null = null;
    if (q.periodId) {
      const p = findPeriod(q.periodId);
      range = { from: p.from, to: p.to };
      periodId = p.id;
    } else range = dateRange(q.from, q.to, 93);
    const zone = deps.zone(s);
    let list: string[] | null = null;
    if (q.branchIds) {
      list = q.branchIds.split(',').filter(Boolean);
      for (const id of list) if (!can(s, 'payroll.view', id)) throw notFound();
    }
    if (q.cityId) {
      const inCity = deps.branches().filter((b) => b.cityId === q.cityId && can(s, 'payroll.view', b.id)).map((b) => b.id);
      if (inCity.length === 0) throw notFound();
      list = list ? list.filter((id) => inCity.includes(id)) : inCity;
    }
    const scope = list ?? (zone.network ? null : zone.branchIds);
    const mineShifts = shifts.filter((x) => x.localDate >= range.from && x.localDate <= range.to && x.status !== 'cancelled' && (!scope || scope.includes(x.branchId)) && (!q.staffId || x.staffId === q.staffId) && (!q.shiftStatus || x.status === q.shiftStatus));
    const matched = new Set(mineShifts.map((x) => x.id));
    const mineEntries = entries.filter((e) => e.date >= range.from && e.date <= range.to && (!scope || (e.branchId !== null && scope.includes(e.branchId))) && (!q.staffId || e.staffId === q.staffId) && (!q.shiftStatus || (e.ref?.type === 'shift' && matched.has(e.ref.id))));
    const ids = [...new Set([...mineShifts.map((x) => x.staffId), ...mineEntries.map((e) => e.staffId)])];
    const people = deps.staff().filter((x) => ids.includes(x.id) && (!q.role || x.role === q.role)).sort((a, b) => a.lastName.localeCompare(b.lastName, 'ru'));
    const rows: Rec[] = [];
    const sums = { forecastKop: 0, accruedKop: 0, penaltiesKop: 0, bonusesKop: 0, correctionsKop: 0, toPayKop: 0 };
    for (const t of people) {
      const st = periodId ? statements.find((x) => x.periodId === periodId && x.staffId === t.id) : undefined;
      if (q.statementStatus && st?.status !== q.statementStatus) continue;
      const myShifts = mineShifts.filter((x) => x.staffId === t.id);
      const myEntries = mineEntries.filter((e) => e.staffId === t.id);
      const lines = new Map<string, { branchId: string; plannedShifts: number; workedShifts: number; noShows: number; plannedMinutes: number; paidMinutes: number; forecastKop: number; accruedKop: number }>();
      const lineOf = (b: string) => {
        const l = lines.get(b) ?? { branchId: b, plannedShifts: 0, workedShifts: 0, noShows: 0, plannedMinutes: 0, paidMinutes: 0, forecastKop: 0, accruedKop: 0 };
        lines.set(b, l);
        return l;
      };
      const rate = rateAt(t.id, range.to);
      const row = { plannedShifts: 0, workedShifts: 0, noShows: 0, plannedMinutes: 0, paidMinutes: 0, forecastKop: 0, accruedKop: 0, penaltiesKop: 0, bonusesKop: 0, correctionsKop: 0, toPayKop: 0 };
      for (const x of myShifts) {
        const l = lineOf(x.branchId);
        const d = dto(x, tzOf(x.branchId));
        for (const o of [row, l]) {
          o.plannedShifts += 1;
          o.plannedMinutes += d.plannedMinutes;
          if (x.status === 'no_show') o.noShows += 1;
          if (x.status === 'planned') o.forecastKop += d.plannedAccrualKop ?? 0;
          if (x.status === 'worked') {
            o.workedShifts += 1;
            o.paidMinutes += x.paidMinutes ?? 0;
          }
        }
      }
      for (const e of myEntries) {
        if (e.kind === 'payroll.accrual') {
          row.accruedKop += e.amountKop;
          if (e.branchId) lineOf(e.branchId).accruedKop += e.amountKop;
        } else if (e.kind === 'payroll.penalty') row.penaltiesKop -= e.amountKop;
        else if (e.kind === 'payroll.bonus') row.bonusesKop += e.amountKop;
        else if (e.kind === 'payroll.correction') row.correctionsKop += e.amountKop;
      }
      row.toPayKop = row.accruedKop - row.penaltiesKop + row.bonusesKop + row.correctionsKop;
      for (const k of Object.keys(sums) as Array<keyof typeof sums>) sums[k] += row[k];
      rows.push({
        staffId: t.id, name: `${t.firstName} ${t.lastName}`, role: t.role, branches: [...lines.values()], ...row, otherDeductionsKop: 0,
        hourlyKop: rate?.hourlyKop ?? null, attendanceFeeKop: rate?.attendanceFeeKop ?? null,
        statementStatus: st?.status ?? null, plannedPayoutDate: st?.plannedPayoutDate ?? null, actualPayoutDate: st?.actualPayoutDate ?? null,
        ...(q.detail === 'true' ? {
          detail: {
            shifts: myShifts.map((x) => {
              const d = dto(x, tzOf(x.branchId));
              const r = rateAt(x.staffId, x.localDate);
              return { id: d.id, branchId: d.branchId, localDate: d.localDate, plannedStart: d.plannedStart, plannedEnd: d.plannedEnd, plannedMinutes: d.plannedMinutes, status: d.status, factStart: d.factStart, factEnd: d.factEnd, paidMinutes: d.paidMinutes, flags: d.flags, hourlyKop: r?.hourlyKop ?? null, attendanceFeeKop: r?.attendanceFeeKop ?? null, forecastKop: d.status === 'planned' ? d.plannedAccrualKop : null, accruedKop: accrualOf(x.id).reduce((a, e) => a + e.amountKop, 0) };
            }),
            entries: myEntries.map((e) => ({ id: e.id, date: e.date, type: e.type, kind: e.kind, branchId: e.branchId, amountKop: e.amountKop, basis: e.basis, ref: e.ref })),
          },
        } : {}),
      });
    }
    const shown = new Set(rows.map((r) => r.staffId as string));
    const gapBranches = deps.branches().filter((b) => (scope ? scope.includes(b.id) : true));
    const emptyIntervals = gapBranches.reduce((a, b) => a + coverageOf(b, range).reduce((c, d) => c + d.gaps.length, 0), 0);
    return {
      from: range.from, to: range.to, rows,
      totals: { ...sums, otherDeductionsKop: 0, staffCount: rows.length, emptyIntervals, unclosedShifts: unresolved(range, Date.now(), q.staffId).filter((u) => shown.has(u.staffId) && matched.has(u.shiftId)).length },
    };
  }
}
