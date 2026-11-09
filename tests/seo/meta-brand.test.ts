// Бренд в H1 и title филиала не дублируется при любом написании в названии (стенд 09.11: «Ю-Клуб Ю Клуб Арбат»).
import { describe, expect, it } from 'vitest';
import { metaFor } from '../../apps/site/src/lib/seo.ts';

const branch = (name: string) =>
  metaFor({ page: 'branch', branch: name, city: 'Москва', address: 'Арбат, 1', directions: ['ПК'], hoursToday: 'Сегодня: 10:00–22:00' });

describe('бренд в мете филиала', () => {
  it('«Ю Клуб», «Ю-Клуб», «ЮКлуб» в названии – без второго бренда', () => {
    for (const name of ['Ю Клуб Арбат', 'Ю-Клуб Арбат', 'ЮКлуб Арбат', 'ю клуб Арбат']) {
      expect(branch(name).h1).toBe(name);
      expect(branch(name).title.startsWith(`${name}, Москва`)).toBe(true);
    }
  });
  it('без бренда в названии – бренд добавляется', () => {
    expect(branch('на Ленина').h1).toBe('Ю-Клуб на Ленина');
    expect(branch('Юность').h1).toBe('Ю-Клуб Юность');
  });
});
