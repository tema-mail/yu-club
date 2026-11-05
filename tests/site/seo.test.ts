// S4-54: K23 §2 и §4. Единое решение индексации по таблице; стенд – noindex везде; preparing – noindex; пустые ручные поля → шаблон, заполненные → ручные.
// Файл в tests/site, а не в apps/site/tests: vitest собирает только tests/**/*.test.ts (как rich-text.test.ts).
import { describe, expect, it } from 'vitest';
import { cutByWord, isIndexablePage, metaFor, plural, robotsFor, type IndexInput, type PageMetaInput } from '../../apps/site/src/lib/seo.ts';

const TABLE: Array<[string, IndexInput, boolean]> = [
  ['главная и каталоги', { kind: 'open' }, true],
  ['юридическая, вход, 404, ЛК, предпросмотр', { kind: 'closed' }, false],
  ['филиал работает', { kind: 'branch', status: 'active' }, true],
  ['филиал временно закрыт', { kind: 'branch', status: 'temporarily_closed' }, true],
  ['филиал готовится', { kind: 'branch', status: 'preparing' }, false],
  ['филиал в архиве', { kind: 'branch', status: 'archived' }, false],
  ['город с двумя филиалами', { kind: 'city', openBranches: 2 }, true],
  ['город с одним филиалом', { kind: 'city', openBranches: 1 }, false],
  ['комната опубликована', { kind: 'room', published: true, branchStatus: 'active' }, true],
  ['комната снята', { kind: 'room', published: false, branchStatus: 'active' }, false],
  ['комната в готовящемся филиале', { kind: 'room', published: true, branchStatus: 'preparing' }, false],
  ['игра с описанием', { kind: 'game', live: true, hasFull: true }, true],
  ['игра без описания', { kind: 'game', live: true, hasFull: false }, false],
  ['игра не опубликована', { kind: 'game', live: false, hasFull: true }, false],
  ['публикация живая', { kind: 'publication', live: true, indexable: true, ended: false }, true],
  ['публикация с выключенным индексом', { kind: 'publication', live: true, indexable: false, ended: false }, false],
  ['завершённая акция', { kind: 'publication', live: true, indexable: true, ended: true }, false],
  ['черновик', { kind: 'publication', live: false, indexable: true, ended: false }, false],
  ['турниры с материалом', { kind: 'hubWithMaterial', hasMaterial: true }, true],
  ['турниры пустые', { kind: 'hubWithMaterial', hasMaterial: false }, false],
];

describe('решение индексации', () => {
  it.each(TABLE)('%s', (_name, page, expected) => {
    expect(isIndexablePage(page)).toBe(expected);
    expect(robotsFor(page, true)).toBe(expected ? 'index' : 'noindex');
    expect(robotsFor(page, false)).toBe('noindex');
  });
});

const PAGES: Array<[PageMetaInput, { title: string; description: string; h1: string; ogType: string }]> = [
  [{ page: 'home', about: 'Текст о клубе', hero: 'Заголовок баннера' }, { title: 'Ю-Клуб – компьютерный клуб: ПК, VR, PlayStation', description: 'Текст о клубе', h1: 'Заголовок баннера', ogType: 'website' }],
  [{ page: 'city', city: 'Новосибирск', branches: ['На Красном', 'Академ'] }, { title: 'Компьютерные клубы Ю-Клуб в городе Новосибирск: 2 адреса', description: 'Ю-Клуб в городе Новосибирск: На Красном, Академ. ПК, VR и PlayStation, онлайн-запись.', h1: 'Ю-Клуб в городе Новосибирск', ogType: 'website' }],
  [{ page: 'branch', branch: 'На Красном', city: 'Новосибирск', address: 'Красный, 25', directions: ['ПК', 'VR'], hoursToday: 'Сегодня 10:00–22:00' }, { title: 'Ю-Клуб На Красном, Новосибирск – Красный, 25', description: 'ПК, VR. Сегодня 10:00–22:00. Онлайн-запись на сайте.', h1: 'Ю-Клуб На Красном', ogType: 'website' }],
  [{ page: 'room', room: 'Комната VR', branch: 'Ю-Клуб на Ленина', city: 'Томск', description: 'Большая комната' }, { title: 'Комната VR – Ю-Клуб на Ленина, Томск', description: 'Большая комната', h1: 'Комната VR', ogType: 'website' }],
  [{ page: 'gameCatalog', direction: 'playstation', count: 21 }, { title: 'Игры на PlayStation в Ю-Клуб', description: '21 игра, где поиграть – по филиалам.', h1: 'Игры на PlayStation', ogType: 'website' }],
  [{ page: 'game', title: 'Half-Life: Alyx', short: 'Коротко' }, { title: 'Half-Life: Alyx – где поиграть в Ю-Клуб', description: 'Коротко', h1: 'Half-Life: Alyx', ogType: 'website' }],
  [{ page: 'publication', title: 'Турнир', lead: 'Подводка' }, { title: 'Турнир – Ю-Клуб', description: 'Подводка', h1: 'Турнир', ogType: 'article' }],
  [{ page: 'info', title: 'О клубе', text: 'Первые строки' }, { title: 'О клубе – Ю-Клуб', description: 'Первые строки', h1: 'О клубе', ogType: 'website' }],
];

describe('шаблоны и ручные поля', () => {
  it.each(PAGES)('пустые ручные поля → шаблон: %j', (input, expected) => {
    expect(metaFor(input)).toEqual({ ...expected, ogImage: null });
    expect(metaFor(input, { title: '  ', description: null, h1: '' })).toEqual({ ...expected, ogImage: null });
  });

  it.each(PAGES)('заполненные ручные поля важнее шаблона: %j', (input, expected) => {
    const m = metaFor(input, { title: 'Ручной', description: 'Ручное', h1: 'Ручной H1', ogImage: '/media/a.jpg' });
    expect(m).toEqual({ title: 'Ручной', description: 'Ручное', h1: 'Ручной H1', ogImage: '/media/a.jpg', ogType: expected.ogType });
  });

  it('каждое поле решается отдельно; бренд не удваивается; один город – в title главной', () => {
    expect(metaFor({ page: 'game', title: 'Игра', short: 'К' }, { h1: 'Свой' })).toMatchObject({ title: 'Игра – где поиграть в Ю-Клуб', h1: 'Свой' });
    expect(metaFor({ page: 'branch', branch: 'Ю-Клуб на Ленина', city: 'Томск', address: 'а', directions: [], hoursToday: 'Закрыто сегодня' })).toMatchObject({ h1: 'Ю-Клуб на Ленина', description: 'Закрыто сегодня. Онлайн-запись на сайте.' });
    expect(metaFor({ page: 'home', singleCity: 'Томск' }).title).toBe('Ю-Клуб – компьютерный клуб: ПК, VR, PlayStation – Томск');
  });

  it('обрезка по слову, склонение', () => {
    const s = cutByWord('слово '.repeat(60));
    expect(s.length).toBeLessThanOrEqual(160);
    expect(s.endsWith('слово')).toBe(true);
    expect(cutByWord('коротко  и   ясно')).toBe('коротко и ясно');
    expect([1, 2, 5, 11, 21, 22, 25].map((n) => plural(n, 'а', 'б', 'в'))).toEqual(['а', 'б', 'в', 'в', 'а', 'б', 'в']);
  });
});
