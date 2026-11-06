// S4-56: общий список карты сайта. Город только при двух филиалах; адрес только при существующей странице; контент только из №217;
// турниры без материала – нет хаба; дата – только у того, у кого есть живая версия; сам разбор файлов страниц не зависит от имени параметра.
import { describe, expect, it } from 'vitest';

import { buildSitemap, type SitemapInput } from '../../apps/site/src/lib/sitemap.ts';

const branch = (id: string, slug: string, status: 'active' | 'temporarily_closed' = 'active') => ({ id, cityId: 'c', slug, name: slug, address: 'а', timezone: 'Asia/Omsk', status, phone: null, publicContacts: {}, bookingWindow: { defaultDays: 7, maxDays: 30 }, holdMinutes: 15 });
const NETWORK: SitemapInput['network'] = [
  { id: 'c1', slug: 'nsk', name: 'Новосибирск', timezone: 'Asia/Novosibirsk', branches: [branch('b1', 'one'), branch('b2', 'two', 'temporarily_closed')] },
  { id: 'c2', slug: 'tomsk', name: 'Томск', timezone: 'Asia/Tomsk', branches: [branch('b3', 'lenina')] },
];
const paths = (i: Partial<SitemapInput>) => buildSitemap({ network: NETWORK, rooms: new Map(), entries: [], routes: [], ...i }).flatMap((s) => s.items.map((x) => x.path));

describe('адреса сети', () => {
  it('город только при двух филиалах, филиалы и комнаты по данным', () => {
    const p = paths({ rooms: new Map([['b1', [{ slug: 'vr', name: 'VR' }]]]) });
    expect(p).toContain('/nsk/');
    expect(p).not.toContain('/tomsk/');
    for (const a of ['/', '/rules/', '/nsk/one/', '/nsk/two/', '/tomsk/lenina/', '/nsk/one/rooms/vr/']) expect(p, a).toContain(a);
  });
});

describe('страницы, которых ещё нет', () => {
  const entries = [
    { path: '/news/a/', title: 'Новость', lastmod: '2026-11-01T00:00:00.000Z' },
    { path: '/games/vr/alyx/', title: 'Alyx', lastmod: '2026-11-02T00:00:00.000Z' },
    { path: '/tournaments/cup/', title: 'Кубок', lastmod: null },
    { path: '/about/', title: 'О клубе', lastmod: '2026-11-02T00:00:00.000Z' },
  ];

  it('нет файла страницы – нет адреса: карта не ведёт на 404', () => {
    const p = paths({ entries });
    for (const a of ['/news/', '/news/a/', '/games/', '/games/vr/', '/games/vr/alyx/', '/tournaments/', '/tournaments/cup/', '/schedule/', '/about/', '/contacts/', '/birthday/', '/sitemap/']) expect(p, a).not.toContain(a);
  });

  it('появился файл – адрес включается сам; имя параметра не важно', () => {
    const p = paths({ entries, routes: ['schedule.astro', 'sitemap.astro', 'news/index.astro', 'news/[slug].astro', 'games/index.astro', 'games/[direction]/index.astro', 'games/[direction]/[game].astro', 'tournaments/index.astro', 'tournaments/[slug].astro', 'contacts.astro', 'info/[key].astro'] });
    for (const a of ['/schedule/', '/sitemap/', '/news/', '/news/a/', '/games/', '/games/pc/', '/games/vr/', '/games/playstation/', '/games/vr/alyx/', '/tournaments/', '/tournaments/cup/', '/contacts/', '/about/']) expect(p, a).toContain(a);
    expect(new Set(p).size).toBe(p.length);
  });

  it('файл страницы есть, а «О клубе» не опубликована – в карте её нет', () => {
    expect(paths({ routes: ['info/[key].astro'] })).not.toContain('/about/');
  });

  it('хаб турниров без материала закрыт; хаб новостей – есть', () => {
    const p = paths({ routes: ['tournaments/index.astro', 'news/index.astro'] });
    expect(p).not.toContain('/tournaments/');
    expect(p).toContain('/news/');
  });
});

describe('даты и контент', () => {
  it('lastmod из №217, в том числе у страницы филиала; нет версии – null; записи филиалов и комнат адресов не добавляют', () => {
    const sections = buildSitemap({
      network: NETWORK,
      rooms: new Map(),
      entries: [
        { path: '/nsk/one/', title: null, lastmod: '2026-11-03T00:00:00.000Z' },
        { path: '/ghost/branch/', title: null, lastmod: '2026-11-03T00:00:00.000Z' },
        { path: '/rules/', title: 'Правила', lastmod: '2026-11-04T00:00:00.000Z' },
      ],
      routes: [],
    });
    const all = sections.flatMap((s) => s.items);
    expect(all.find((i) => i.path === '/nsk/one/')?.lastmod).toBe('2026-11-03T00:00:00.000Z');
    expect(all.find((i) => i.path === '/nsk/two/')?.lastmod).toBeNull();
    expect(all.find((i) => i.path === '/rules/')?.lastmod).toBe('2026-11-04T00:00:00.000Z');
    expect(all.map((i) => i.path)).not.toContain('/ghost/branch/');
    expect(all.filter((i) => i.path.includes('?'))).toEqual([]);
  });
});
