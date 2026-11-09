// S4-111: охват публикации словами (K22 §4), дата по зоне клуба, адреса клубов охвата для JSON-LD.
import { describe, expect, it } from 'vitest';
import type { CityWithBranches } from '../../apps/site/src/lib/api.ts';
import { chosenBranch, displayZone, formatDay, scopeBranchPaths, scopeCities, scopeText } from '../../apps/site/src/lib/publications.ts';

const B = (id: string, slug: string, name: string, timezone: string) => ({ id, cityId: 'c', slug, name, address: '', timezone, status: 'active' as const, phone: null, publicContacts: {}, bookingWindow: { defaultDays: 7, maxDays: 30 }, holdMinutes: 15 });
const net: CityWithBranches[] = [
  { id: 'c1', slug: 'tomsk', name: 'Томск', timezone: 'Asia/Tomsk', branches: [B('b1', 'lenina', 'Ю-Клуб на Ленина', 'Asia/Tomsk')] },
  { id: 'c2', slug: 'moskva', name: 'Москва', timezone: 'Europe/Moscow', branches: [B('b2', 'arbat', 'Ю-Клуб Арбат', 'Europe/Moscow')] },
];

describe('показ публикаций', () => {
  it('охват словами: сеть, город, клуб, несколько', () => {
    expect(scopeText([])).toBe('Во всех клубах сети');
    expect(scopeText([{ type: 'city', id: 'c1', name: 'Томск' }])).toBe('Только в городе Томск');
    expect(scopeText([{ type: 'branch', id: 'b1', name: 'Ю-Клуб на Ленина' }])).toBe('Только в клубе «Ю-Клуб на Ленина»');
    expect(scopeText([{ type: 'branch', id: 'b1', name: 'А' }, { type: 'branch', id: 'b2', name: 'Б' }])).toBe('Только: А, Б');
  });

  it('дата – по зоне клуба: полночь UTC+7 – уже следующий день', () => {
    expect(formatDay('2026-11-10T18:30:00.000Z', 'Asia/Tomsk')).toBe('11 ноября 2026 г.');
    expect(formatDay('2026-11-10T18:30:00.000Z', 'Europe/Moscow')).toBe('10 ноября 2026 г.');
  });

  it('зона показа: выбранный клуб, иначе первый город, иначе Москва', () => {
    expect(displayZone(net, chosenBranch(net, { city: 'moskva', branch: 'arbat' }))).toBe('Europe/Moscow');
    expect(displayZone(net, null)).toBe('Asia/Tomsk');
    expect(displayZone(null, null)).toBe('Europe/Moscow');
    expect(chosenBranch(net, { city: 'tomsk', branch: 'nope' })).toBeNull();
  });

  it('адреса клубов охвата – только существующие в сети; города – именами', () => {
    const only = [{ type: 'branch' as const, id: 'b1', name: 'x' }, { type: 'branch' as const, id: 'gone', name: 'y' }, { type: 'city' as const, id: 'c2', name: 'Москва' }];
    expect(scopeBranchPaths(only, net)).toEqual(['/tomsk/lenina/']);
    expect(scopeCities(only)).toEqual(['Москва']);
  });
});
