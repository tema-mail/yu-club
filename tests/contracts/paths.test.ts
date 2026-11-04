// S4-08: реестр адресов K23 §1 – шаблоны карты сайта (docs/karta-sayta.md, разделы 3.1–3.6), разбор и строители.
// Файл лежит в tests/contracts, а не в packages/contracts/tests: vitest собирает только tests/**/*.test.ts.
import { describe, expect, it } from 'vitest';
import {
  RESERVED_CITY_SLUGS,
  branchPath,
  buildPath,
  gamePath,
  normalizePath,
  pagePath,
  parsePath,
  publicationPath,
  roomPath,
  type PathMatch,
} from '../../packages/contracts/src/paths.ts';

// Пример каждого шаблона карты сайта и ожидаемый адрес. 45 шаблонов сайта (карта 4: 1 + 7 + 4 + 2 + 9 + 6 + 5 + 11);
// 46-й – CRM на своём домене, в реестр сайта не входит.
const TEMPLATES: [string, PathMatch, string][] = [
  // 3.1 Главная и хабы (1 + 7)
  ['главная', { kind: 'static', page: 'home' }, '/'],
  ['город', { kind: 'city', city: 'novosibirsk' }, '/novosibirsk/'],
  ['филиал', { kind: 'branch', city: 'novosibirsk', branch: 'lenina-12' }, '/novosibirsk/lenina-12/'],
  ['хаб игр', { kind: 'static', page: 'games' }, '/games/'],
  ['хаб новостей', { kind: 'publications', type: 'news' }, '/news/'],
  ['хаб акций', { kind: 'publications', type: 'promotion' }, '/promotions/'],
  ['хаб розыгрышей', { kind: 'publications', type: 'giveaway' }, '/giveaways/'],
  ['хаб турниров', { kind: 'publications', type: 'tournament' }, '/tournaments/'],
  // 3.2 Каталоги (4) и карточки (2)
  ['каталог комнат', { kind: 'static', page: 'rooms' }, '/rooms/'],
  ['игры ПК', { kind: 'gamesDirection', direction: 'pc' }, '/games/pc/'],
  ['игры VR', { kind: 'gamesDirection', direction: 'vr' }, '/games/vr/'],
  ['игры PlayStation', { kind: 'gamesDirection', direction: 'playstation' }, '/games/playstation/'],
  ['комната', { kind: 'room', city: 'novosibirsk', branch: 'lenina-12', room: 'vr-ps4-room' }, '/novosibirsk/lenina-12/rooms/vr-ps4-room/'],
  ['игра', { kind: 'game', direction: 'vr', game: 'beat-saber' }, '/games/vr/beat-saber/'],
  // 3.3 Страницы (9)
  ['расписание', { kind: 'static', page: 'schedule' }, '/schedule/'],
  ['день рождения', { kind: 'static', page: 'birthday' }, '/birthday/'],
  ['новость', { kind: 'publication', type: 'news', slug: 'branch-opening-lenina' }, '/news/branch-opening-lenina/'],
  ['акция', { kind: 'publication', type: 'promotion', slug: 'happy-hours-weekdays' }, '/promotions/happy-hours-weekdays/'],
  ['розыгрыш', { kind: 'publication', type: 'giveaway', slug: 'ps5-november' }, '/giveaways/ps5-november/'],
  ['турнир', { kind: 'publication', type: 'tournament', slug: 'cs2-cup-2026' }, '/tournaments/cs2-cup-2026/'],
  ['отзывы', { kind: 'static', page: 'reviews' }, '/reviews/'],
  ['о клубе', { kind: 'static', page: 'about' }, '/about/'],
  ['контакты', { kind: 'static', page: 'contacts' }, '/contacts/'],
  // 3.4 Юридические (6)
  ['политика ПДн', { kind: 'legal', key: 'privacy-policy' }, '/privacy-policy/'],
  ['согласие ПДн', { kind: 'legal', key: 'personal-data-consent' }, '/personal-data-consent/'],
  ['cookie', { kind: 'legal', key: 'cookie-policy' }, '/cookie-policy/'],
  ['согласие на рекламу', { kind: 'legal', key: 'advertising-consent' }, '/advertising-consent/'],
  ['правила клуба', { kind: 'static', page: 'rules' }, '/rules/'],
  ['правила розыгрыша', { kind: 'giveawayRules', slug: 'ps5-november' }, '/giveaways/ps5-november/rules/'],
  // 3.5 Технические (5)
  ['вход', { kind: 'static', page: 'login' }, '/login/'],
  ['404', { kind: 'static', page: 'notFound' }, '/404'],
  ['HTML-карта', { kind: 'static', page: 'sitemap' }, '/sitemap/'],
  ['sitemap.xml', { kind: 'static', page: 'sitemapXml' }, '/sitemap.xml'],
  ['robots.txt', { kind: 'static', page: 'robots' }, '/robots.txt'],
  // 3.6 ЛК (11)
  ['ЛК обзор', { kind: 'account', section: '' }, '/account/'],
  ['ЛК профиль', { kind: 'account', section: 'profile' }, '/account/profile/'],
  ['ЛК записи', { kind: 'account', section: 'bookings' }, '/account/bookings/'],
  ['ЛК запись', { kind: 'accountBooking', id: '0f0e0d0c-0b0a-4908-8706-050403020100' }, '/account/bookings/0f0e0d0c-0b0a-4908-8706-050403020100/'],
  ['ЛК посещения', { kind: 'account', section: 'visits' }, '/account/visits/'],
  ['ЛК баллы', { kind: 'account', section: 'bonuses' }, '/account/bonuses/'],
  ['ЛК сертификаты', { kind: 'account', section: 'certificates' }, '/account/certificates/'],
  ['ЛК платежи', { kind: 'account', section: 'payments' }, '/account/payments/'],
  ['ЛК уведомления', { kind: 'account', section: 'notifications' }, '/account/notifications/'],
  ['ЛК настройки', { kind: 'account', section: 'settings' }, '/account/settings/'],
  ['ЛК помощь', { kind: 'account', section: 'support' }, '/account/support/'],
];

describe('S4-08: реестр адресов K23 §1', () => {
  it('шаблонов сайта 45 (карта сайта 4 без CRM), адреса не повторяются', () => {
    expect(TEMPLATES).toHaveLength(45);
    expect(new Set(TEMPLATES.map((t) => t[2])).size).toBe(45);
  });

  it.each(TEMPLATES)('%s: build → адрес, parsePath(build(x)) = x', (_name, match, path) => {
    expect(buildPath(match)).toBe(path);
    expect(parsePath(path)).toEqual(match);
    expect(normalizePath(path)).toBe(path); // нормальная форма неподвижна
  });

  it('зарезервированные слова не разбираются как город', () => {
    for (const w of RESERVED_CITY_SLUGS) {
      const m = parsePath(`/${w}/`);
      expect(m?.kind, w).not.toBe('city');
      expect(parsePath(`/${w}/some-branch/`)?.kind, w).not.toBe('branch');
    }
    for (const w of ['api', 'admin', 'crm', 'assets', 'media', 'preview', 'unsubscribe', 'info']) expect(parsePath(`/${w}/`), w).toBeNull();
  });

  it('промежуточный сегмент комнат филиала разбирается отдельно (301 на #rooms, карта п.2.11)', () => {
    expect(parsePath('/novosibirsk/lenina-12/rooms/')).toEqual({ kind: 'branchRooms', city: 'novosibirsk', branch: 'lenina-12' });
    expect(buildPath({ kind: 'branchRooms', city: 'novosibirsk', branch: 'lenina-12' })).toBe('/novosibirsk/lenina-12/rooms/');
  });

  it('не по шаблону и ненормализованное – null', () => {
    for (const p of [
      '/News/', '/news', '/novosibirsk', '//evil.ru/', '/games/xbox/', '/games/pc/a/b/', '/news/a/b/', '/promotions/x/rules/',
      '/account/unknown/', '/account/bookings/123/', '/Novosibirsk/', '/novo_sibirsk/', '/a/b/c/', '/a/b/rooms/c/d/',
      '/novosibirsk/lenina/rooms/Room/', '/' + 'a'.repeat(41) + '/', '/news/' + 'a'.repeat(91) + '/', '',
    ]) {
      expect(parsePath(p), p).toBeNull();
    }
  });

  it('normalizePath: регистр, слеш, файлы без слеша (K23 §1)', () => {
    expect(normalizePath('/News')).toBe('/news/');
    expect(normalizePath('/news')).toBe('/news/');
    expect(normalizePath('/Novosibirsk/Lenina//')).toBe('/novosibirsk/lenina/');
    expect(normalizePath('/sitemap.xml/')).toBe('/sitemap.xml');
    expect(normalizePath('/ROBOTS.TXT')).toBe('/robots.txt');
    expect(normalizePath('/404/')).toBe('/404');
    expect(normalizePath('')).toBe('/');
  });

  it('строители совпадают с прежними адресами сайта Э1 и ключами CMS (K22 §5)', () => {
    expect(branchPath('nsk', 'krasny')).toBe('/nsk/krasny/');
    expect(roomPath('nsk', 'krasny', 'vr-ps4-room')).toBe('/nsk/krasny/rooms/vr-ps4-room/');
    expect(gamePath('playstation', 'gran-turismo-7')).toBe('/games/playstation/gran-turismo-7/');
    expect(publicationPath('promotion', 'x')).toBe('/promotions/x/');
    expect(pagePath('about')).toBe('/about/');
    expect(pagePath('contacts_intro')).toBe('/contacts/');
    expect(pagePath('advertising-consent')).toBe('/advertising-consent/');
  });
});
