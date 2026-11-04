// S3-01: права и настройки Э3 (K1 «Действия Э3», K7 «Реестр ключей Э3»). Матрица переписана из контрактов
// K18 §12, K19 §12, K20 §13 независимо от кода – расхождение с MATRIX ловится здесь.
import { describe, expect, it } from 'vitest';
import { ACTIONS, assertCan, can, roleAllows, type AccessContext, type StaffRole } from '../../apps/api/src/core/permissions.ts';
import { SETTINGS, settingDef } from '../../apps/api/src/core/settings.ts';

const BR_A = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const BR_B = 'bbbbbbbb-0000-4000-8000-0000000000b1';

function ctx(role: StaffRole, branchIds: string[]): AccessContext {
  return {
    actor: { kind: 'staff', staffId: '11111111-0000-4000-8000-000000000001', sessionId: 's' },
    role,
    network: role === 'owner',
    cityIds: new Set(),
    branchIds: new Set(branchIds),
    at: new Date('2026-11-15T07:00:00Z'),
  };
}
const owner = ctx('owner', []);
const director = ctx('director', [BR_A]);
const admin = ctx('admin', [BR_A]);

const EXPECTED_E3: [string, string, 'network' | 'branch'][] = [
  // K18 §12
  ['shift.view.own', 'ОДА', 'branch'],
  ['shift.plan.own', 'ОДА', 'branch'],
  ['shift.attendance.self', 'ОДА', 'branch'],
  ['shift.view', 'ОДА', 'branch'],
  ['shift.manage', 'ОД', 'branch'],
  ['shift.outside_hours', 'ОД', 'branch'],
  ['shift.attendance.correct', 'ОД', 'branch'],
  ['staff.planning_status', 'ОД', 'branch'],
  ['payroll.view', 'ОД', 'branch'],
  ['payroll.rate.manage', 'О', 'network'],
  ['payroll.penalty.manage', 'ОД', 'branch'],
  ['payroll.bonus.manage', 'О', 'network'],
  ['payroll.statement.review', 'ОД', 'branch'],
  ['payroll.period.manage', 'О', 'network'],
  ['payroll.statement.ready', 'О', 'network'],
  ['payroll.payout.mark', 'О', 'network'],
  ['payroll.correct', 'О', 'network'],
  ['payroll.payout.expense', 'О', 'branch'],
  // K19 §12
  ['equipment.view', 'ОДА', 'branch'],
  ['equipment.view.accounts', 'ОД', 'branch'],
  ['equipment.manage', 'ОД', 'branch'],
  ['equipment.move', 'ОД', 'branch'],
  ['equipment.financial.edit', 'О', 'network'],
  ['equipment.write_off', 'О', 'network'],
  ['equipment.category.manage', 'О', 'network'],
  ['repair.register', 'ОДА', 'branch'],
  ['repair.attach', 'ОДА', 'branch'],
  ['repair.manage', 'ОД', 'branch'],
  ['repair.approve', 'О', 'network'],
  ['repair.accept', 'ОДА', 'branch'],
  ['repair.close', 'ОД', 'branch'],
  ['repair.expense.create', 'ОД', 'branch'],
  ['repair.executor.manage', 'ОД', 'network'],
  // K20 §13
  ['event.view', 'ОДА', 'branch'],
  ['event.manage', 'ОДА', 'branch'],
  ['event.price.manage', 'ОД', 'branch'],
  ['event.money.view', 'ОД', 'branch'],
  ['event.money.record', 'ОДА', 'branch'],
  ['event.package.manage', 'О', 'network'],
  ['event.type.manage', 'О', 'network'],
  ['gift.issue', 'ОДА', 'branch'],
  ['gift.issue.manual', 'О', 'network'],
  ['gift.cancel', 'О', 'network'],
  ['gift.book', 'ОДА', 'branch'],
  ['holiday.manage', 'О', 'network'],
];

const E3 = /^(shift|payroll|equipment|repair|event|gift|holiday)\.|^staff\.planning_status$/;
const LETTER: Record<StaffRole, string> = { owner: 'О', director: 'Д', admin: 'А' };

describe('S3-01: матрица Э3 роль × действие', () => {
  it('действия Э3 в коде совпадают с K1 «Действия Э3» построчно', () => {
    expect(ACTIONS.filter((a) => E3.test(a)).sort()).toEqual(EXPECTED_E3.map((r) => r[0]).sort());
  });

  const rows = EXPECTED_E3.flatMap(([action, roles, kind]) =>
    (['owner', 'director', 'admin'] as const).map((role) => ({ action, role, kind, allowed: roles.includes(LETTER[role]) })),
  );
  it.each(rows)('$action / $role', ({ action, role, kind, allowed }) => {
    const c = { owner, director, admin }[role];
    expect(roleAllows(role, action)).toBe(allowed);
    const own = kind === 'network' ? { network: true as const } : { branchId: BR_A };
    expect(can(c, action, own)).toBe(allowed && (kind !== 'network' || role === 'owner'));
    expect(can(c, action, { branchId: BR_B })).toBe(allowed && role === 'owner');
  });

  it('Администратор не получает shift.manage, payroll.*, equipment.manage, repair.manage, repair.close, event.price.manage, event.money.view', () => {
    const denied = ['shift.manage', 'equipment.manage', 'repair.manage', 'repair.close', 'event.price.manage', 'event.money.view'];
    for (const a of [...denied, ...ACTIONS.filter((x) => x.startsWith('payroll.'))]) {
      expect(roleAllows('admin', a), a).toBe(false);
      expect(() => assertCan(admin, a, { branchId: BR_A }), a).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    }
  });

  it('Директор не получает payroll.rate.manage, payroll.payout.mark, repair.approve, equipment.write_off, gift.issue.manual', () => {
    for (const a of ['payroll.rate.manage', 'payroll.payout.mark', 'repair.approve', 'equipment.write_off', 'gift.issue.manual']) {
      expect(roleAllows('director', a), a).toBe(false);
      expect(roleAllows('owner', a), a).toBe(true);
      expect(() => assertCan(director, a, { branchId: BR_A }), a).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    }
  });

  it('Директор зоны {А} не видит смен и зарплаты филиала Б (TC-16): NOT_FOUND, а не FORBIDDEN', () => {
    for (const a of ['shift.view', 'payroll.view', 'payroll.penalty.manage', 'equipment.view', 'event.view']) {
      expect(() => assertCan(director, a, { branchId: BR_B }), a).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    }
  });

  it('неуказанное в Э3 запрещено: payroll.view.own (Q-108), payroll.export (Э4)', () => {
    for (const a of ['payroll.view.own', 'payroll.export', 'equipment.delete']) {
      for (const r of ['owner', 'director', 'admin'] as const) expect(roleAllows(r, a), `${r} ${a}`).toBe(false);
    }
  });
});

describe('S3-01: ключи настроек Э3', () => {
  // K18 §16, K19 §16, K20 §17 – умолчания из контрактов
  const expected: Record<string, unknown> = {
    'shift.min_minutes': null,
    'shift.self_edit_deadline_hours': 24,
    'shift.checkin_early_minutes': 30,
    'shift.review_grace_minutes': 60,
    'payroll.attendance_fee_min_minutes': 120,
    'payroll.bonus_enabled': false,
    'payroll.penalties_enabled': false,
    'payroll.negative_carry': 'carry',
    'payroll.period_kind': 'month',
    'equipment.critical_auto_block': false,
    'equipment.critical_block_hours': 24,
    'repair.approval_threshold_kop': 1_000_000,
    'attachments.max_bytes': 10_485_760,
    'attachments.mime_types': ['image/jpeg', 'image/png', 'application/pdf'],
    'event.party.min_minutes': 120,
    'event.party.max_guests': 10,
    'event.party.price_confirmed': false,
    'event.prepayment_required': false,
    'event.requests_enabled': true,
    'event.request_hold_hours': 48,
    'event.request_hold_remind_hours': 24,
    'gift.valid_days': 60,
    'gift.room_minutes': 40,
    'gift.start_align_minutes': 15,
    'gift.per_client_days': 365,
    'gift.no_show_returns': true,
  };

  it('умолчания совпадают с контрактами; уровень – сеть; менять – только Владелец', () => {
    for (const [key, value] of Object.entries(expected)) {
      const d = settingDef(key);
      expect(d.systemDefault, key).toEqual(value);
      expect([...d.levels], key).toEqual(['network']);
      expect(d.editAction, key).toBe('settings.network.manage');
      expect(d.schema.safeParse(d.systemDefault).success, key).toBe(true);
    }
    expect(roleAllows('director', 'settings.network.manage')).toBe(false);
    const e3Keys = Object.keys(SETTINGS).filter((k) => /^(shift|payroll|equipment|repair|attachments|event|gift)\./.test(k));
    expect(e3Keys.sort()).toEqual(Object.keys(expected).sort());
  });

  it('схемы отсекают неверное', () => {
    const bad: [string, unknown][] = [
      ['shift.min_minutes', 10],
      ['payroll.negative_carry', 'keep'],
      ['payroll.period_kind', 'day'],
      ['attachments.mime_types', []],
      ['attachments.mime_types', ['image/gif']],
      ['attachments.mime_types', ['image/png', 'image/png']],
      ['attachments.max_bytes', 0],
      ['repair.approval_threshold_kop', -1],
      ['gift.valid_days', 0],
      ['event.party.max_guests', 101],
    ];
    for (const [key, value] of bad) expect(settingDef(key).schema.safeParse(value).success, `${key}=${JSON.stringify(value)}`).toBe(false);
    expect(settingDef('repair.approval_threshold_kop').schema.safeParse(null).success).toBe(true);
  });
});
