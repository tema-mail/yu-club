// S4-01: права Э4 – K1 «Действия Э4» (K21 §10, K22 §10, K24 §8), переписаны независимо от кода.
import { describe, expect, it } from 'vitest';
import { ACTIONS, actionsOf, assertCan, can, roleAllows, type AccessContext, type StaffRole, type Target } from '../../apps/api/src/core/permissions.ts';

const CITY_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const CITY_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const BR_A1 = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const BR_A2 = 'aaaaaaaa-0000-4000-8000-0000000000a2';
const BR_B1 = 'bbbbbbbb-0000-4000-8000-0000000000b1';

function ctx(role: StaffRole, zone: { cityIds?: string[]; branchIds?: string[] } = {}): AccessContext {
  return {
    actor: { kind: 'staff', staffId: { owner: '0', director: '1', admin: '2' }[role].repeat(8) + '-0000-4000-8000-000000000004', sessionId: 's' },
    role,
    network: role === 'owner',
    cityIds: new Set(zone.cityIds ?? []),
    branchIds: new Set(zone.branchIds ?? []),
    at: new Date('2026-11-15T07:00:00Z'),
  };
}
const owner = ctx('owner');
const director = ctx('director', { cityIds: [CITY_A], branchIds: [BR_A1, BR_A2] });
const admin = ctx('admin', { branchIds: [BR_A1] });

// 'role' – цель «роль» (D4-02): проверяется только набор роли, зона не участвует.
type Kind = 'network' | 'city' | 'branch' | 'role';
const E4: [string, string, Kind][] = [
  ['notifications.send.service', 'ОДА', 'branch'],
  ['notifications.send.marketing', 'ОД', 'branch'],
  ['notifications.send.mass', 'ОД', 'branch'],
  ['notifications.retry', 'ОД', 'branch'],
  ['notifications.templates.manage', 'О', 'network'],
  ['content.view', 'ОДА', 'branch'],
  ['content.draft.edit', 'ОДА', 'branch'],
  ['content.publish', 'ОД', 'city'],
  ['content.network.manage', 'О', 'network'],
  ['content.catalog.availability', 'ОД', 'branch'],
  ['content.legal.publish', 'О', 'network'],
  ['content.media.upload', 'ОДА', 'role'],
  ['content.media.archive', 'ОД', 'role'],
  ['content.media.purge', 'О', 'network'],
  ['content.preview', 'ОДА', 'branch'],
  ['reports.ops.view', 'ОДА', 'branch'],
  ['reports.finance.view', 'ОД', 'branch'],
  ['reports.clients.view', 'ОД', 'branch'],
  ['reports.loyalty.view', 'ОД', 'branch'],
  ['reports.events.view', 'ОД', 'branch'],
  ['reports.staff.view', 'ОД', 'branch'],
  ['reports.payroll.view', 'ОД', 'branch'],
  ['reports.equipment.view', 'ОДА', 'branch'],
  ['reports.comms.view', 'ОД', 'branch'],
  ['reports.export', 'ОД', 'branch'],
  ['reports.export.detail', 'ОД', 'branch'],
  ['reports.export.payroll', 'О', 'network'],
  ['search.global', 'ОДА', 'role'],
];
const E4_RE = /^(content|reports|search)\.|^notifications\.(send|retry|templates)(\.|$)/;

const LETTER: Record<StaffRole, string> = { owner: 'О', director: 'Д', admin: 'А' };
const own: Record<string, Target> = { network: { network: true }, city: { cityId: CITY_A }, branch: { branchId: BR_A1 } };
const foreign: Record<string, Target> = { network: { network: true }, city: { cityId: CITY_B }, branch: { branchId: BR_B1 } };

describe('S4-01: действия Э4 × роль × своя/чужая цель', () => {
  it('действия Э4 в коде совпадают с K1 «Действия Э4» построчно', () => {
    expect(ACTIONS.filter((a) => E4_RE.test(a)).sort()).toEqual(E4.map((r) => r[0]).sort());
  });

  const rows = E4.flatMap(([action, roles, kind]) =>
    (['owner', 'director', 'admin'] as const).map((role) => ({ action, role, kind, allowed: roles.includes(LETTER[role]) })),
  );

  it.each(rows)('$action / $role', ({ action, role, kind, allowed }) => {
    const c = { owner, director, admin }[role];
    expect(roleAllows(role, action)).toBe(allowed);
    if (kind === 'role') return; // зона не участвует – только roleAllows (D4-02)
    expect(can(c, action, own[kind]!)).toBe(allowed && (kind !== 'network' || role === 'owner'));
    expect(can(c, action, foreign[kind]!)).toBe(allowed && role === 'owner');
  });

  it('Администратор получает ровно 8 действий Э4 – ничего из рекламы, публикации, финансовых отчётов и экспорта', () => {
    expect(actionsOf('admin').filter((a) => E4_RE.test(a)).sort()).toEqual(
      [
        'content.draft.edit', 'content.media.upload', 'content.preview', 'content.view', 'notifications.send.service',
        'reports.equipment.view', 'reports.ops.view', 'search.global',
      ].sort(),
    );
    for (const a of ['notifications.send.marketing', 'notifications.send.mass', 'content.publish', 'reports.finance.view', 'reports.export', 'export.pd']) {
      expect(roleAllows('admin', a), a).toBe(false);
    }
  });

  it('Директор: без content.network.manage, content.legal.publish, export.pd; с reports.payroll.view своей зоны', () => {
    for (const a of ['content.network.manage', 'content.legal.publish', 'export.pd', 'content.media.purge', 'notifications.templates.manage', 'reports.export.payroll']) {
      expect(roleAllows('director', a), a).toBe(false);
      expect(roleAllows('owner', a), a).toBe(true);
    }
    expect(can(director, 'reports.payroll.view', { branchId: BR_A2 })).toBe(true);
    expect(() => assertCan(director, 'reports.payroll.view', { branchId: BR_B1 })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => assertCan(admin, 'reports.payroll.view', { branchId: BR_A1 })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('сетевые изменяющие действия Э4 – только Владелец (сетевая цель у Директора – FORBIDDEN)', () => {
    for (const a of ['notifications.send.marketing', 'notifications.send.mass']) {
      expect(can(owner, a, { network: true })).toBe(true);
      expect(() => assertCan(director, a, { network: true })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
      expect(can(director, a, { cityId: CITY_A })).toBe(true);
      expect(() => assertCan(director, a, { branchId: BR_B1 })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    }
  });

  it('права Э0–Э2 не изменились (полная сверка – permissions.test.ts, здесь – соседние строки)', () => {
    expect(roleAllows('admin', 'notifications.view')).toBe(true);
    expect(roleAllows('director', 'export.pd')).toBe(false);
    expect(roleAllows('admin', 'finance.view')).toBe(false);
    expect(roleAllows('director', 'finance.correct')).toBe(false);
  });
});
