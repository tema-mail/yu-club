// S4-55: K23 §6. Структура по Zod на филиале, комнате, турнире, акции, новости; нет значения – нет поля; </script> в описании не ломает разметку;
// нет AggregateRating, Review и цены. Файл в tests/site: vitest собирает только tests/**/*.test.ts.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { branchId, branchLd, breadcrumbLd, newsLd, organizationLd, promotionLd, roomLd, serializeJsonLd, tournamentLd, websiteLd, type JsonLd } from '../../apps/site/src/lib/jsonld.ts';

const O = 'https://yu-club.test';
const P = '/tomsk/lenina/';
const ctx = z.literal('https://schema.org');
const ref = z.strictObject({ '@id': z.string().startsWith(O) });

const Branch = z.strictObject({
  '@context': ctx, '@type': z.literal('EntertainmentBusiness'), '@id': z.literal(`${O}${P}#branch`), name: z.string(), url: z.url(),
  telephone: z.string().optional(),
  address: z.strictObject({ '@type': z.literal('PostalAddress'), addressCountry: z.literal('RU'), streetAddress: z.string(), addressLocality: z.string(), addressRegion: z.string(), postalCode: z.string() }).optional(),
  geo: z.strictObject({ '@type': z.literal('GeoCoordinates'), latitude: z.number(), longitude: z.number() }).optional(),
  openingHoursSpecification: z.array(z.strictObject({ '@type': z.literal('OpeningHoursSpecification'), dayOfWeek: z.enum(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']), opens: z.string(), closes: z.string() })).optional(),
  image: z.array(z.url()).optional(),
  parentOrganization: ref,
});
const Room = z.strictObject({ '@context': ctx, '@type': z.literal('Place'), name: z.string(), url: z.url(), description: z.string().optional(), image: z.array(z.url()).optional(), maximumAttendeeCapacity: z.number().optional(), containedInPlace: ref });
const Event = z.strictObject({ '@context': ctx, '@type': z.literal('Event'), name: z.string(), url: z.url(), startDate: z.string(), description: z.string(), location: ref, eventStatus: z.url(), eventAttendanceMode: z.url(), organizer: ref, image: z.url().optional() });
const Offer = z.strictObject({ '@context': ctx, '@type': z.literal('Offer'), name: z.string(), description: z.string(), url: z.url(), validFrom: z.string().optional(), validThrough: z.string().optional(), availability: z.url(), offeredBy: ref, areaServed: z.array(z.strictObject({ '@type': z.literal('City'), name: z.string() })).optional() });
const News = z.strictObject({ '@context': ctx, '@type': z.literal('NewsArticle'), headline: z.string(), url: z.url(), datePublished: z.string(), dateModified: z.string(), image: z.url().optional(), author: ref, publisher: ref });

const noForbidden = (d: JsonLd) => {
  const s = JSON.stringify(d);
  for (const word of ['AggregateRating', 'aggregateRating', 'Review', 'review', '"price"', 'priceCurrency']) expect(s).not.toContain(word);
};

describe('филиал', () => {
  it('полный: адрес, координаты, часы, телефон; без цены и рейтинга', () => {
    const d = branchLd(O, { path: P, name: 'На Ленина', status: 'active', phone: '+73822000000', postal: { street: 'пр. Ленина, 80', locality: 'Томск', region: 'Томская область', postalCode: '634050' }, geo: { lat: 56.48, lng: 84.95 }, weeklyHours: [{ weekday: 1, open: '10:00', close: '22:00' }, { weekday: 7, open: '12:00', close: '20:00' }], images: ['/media/a.jpg'] });
    const r = Branch.parse(d);
    expect(r.openingHoursSpecification?.map((h) => h.dayOfWeek)).toEqual(['Monday', 'Sunday']);
    expect(r.image).toEqual([`${O}/media/a.jpg`]);
    noForbidden(d);
  });

  it('только факты: телефона, адреса и фото нет – полей нет; строка адреса не подставляется; временно закрытый – без часов', () => {
    const d = Branch.parse(branchLd(O, { path: P, name: 'На Ленина', status: 'temporarily_closed', phone: null, postal: null, geo: null, weeklyHours: [{ weekday: 1, open: '10:00', close: '22:00' }] }));
    expect(Object.keys(d).sort()).toEqual(['@context', '@id', '@type', 'name', 'parentOrganization', 'url']);
  });
});

describe('комната, турнир, акция, новость', () => {
  it('комната ссылается на филиал; вместимость только заданная', () => {
    const d = Room.parse(roomLd(O, { path: `${P}rooms/vr/`, name: 'VR', branchPath: P, capacity: null }));
    expect(d.containedInPlace['@id']).toBe(branchId(O, P));
    expect(d.maximumAttendeeCapacity).toBeUndefined();
    expect(Room.parse(roomLd(O, { path: `${P}rooms/vr/`, name: 'VR', branchPath: P, capacity: 8 })).maximumAttendeeCapacity).toBe(8);
  });

  it('турнир: только с одним филиалом и датой, иначе разметки нет', () => {
    const base = { path: '/tournaments/cs2/', title: 'CS2', lead: 'Подводка', startDate: '2026-12-01T12:00:00+07:00', ended: false };
    const d = tournamentLd(O, { ...base, branchPaths: [P] });
    expect(d).not.toBeNull();
    expect(Event.parse(d).location['@id']).toBe(branchId(O, P));
    noForbidden(d!);
    expect(tournamentLd(O, { ...base, branchPaths: [] })).toBeNull();
    expect(tournamentLd(O, { ...base, branchPaths: [P, '/tomsk/mira/'] })).toBeNull();
    expect(tournamentLd(O, { ...base, branchPaths: [P], startDate: null })).toBeNull();
  });

  it('акция: без цены; один филиал – он, иначе организация; завершённая – Discontinued', () => {
    const base = { path: '/promotions/x/', title: 'Акция', lead: 'Подводка', publishFrom: '2026-11-01T00:00:00Z', publishTo: '2026-12-01T00:00:00Z' };
    const one = Offer.parse(promotionLd(O, { ...base, ended: false, branchPaths: [P], cities: ['Томск'] }));
    expect(one.offeredBy['@id']).toBe(branchId(O, P));
    expect(one.availability).toBe('https://schema.org/InStock');
    const net = promotionLd(O, { ...base, ended: true, branchPaths: [], cities: [] });
    expect(Offer.parse(net).offeredBy['@id']).toBe(`${O}/#organization`);
    expect(net.availability).toBe('https://schema.org/Discontinued');
    expect(net.areaServed).toBeUndefined();
    noForbidden(net);
  });

  it('новость: автор и издатель – организация, дата правки по умолчанию – дата публикации', () => {
    const d = News.parse(newsLd(O, { path: '/news/a/', title: 'Новость', datePublished: '2026-11-01T00:00:00Z' }));
    expect(d.author['@id']).toBe(`${O}/#organization`);
    expect(d.dateModified).toBe('2026-11-01T00:00:00Z');
  });
});

describe('сеть и навигация', () => {
  it('Organization и WebSite; соцсети – только заданные', () => {
    expect(organizationLd(O)).toEqual({ '@context': 'https://schema.org', '@type': 'Organization', '@id': `${O}/#organization`, name: 'Ю-Клуб', url: `${O}/` });
    expect(organizationLd(O, { sameAs: ['https://vk.com/x'] }).sameAs).toEqual(['https://vk.com/x']);
    expect(websiteLd(O)).toMatchObject({ '@type': 'WebSite', url: `${O}/` });
  });

  it('BreadcrumbList: позиции с единицы, полные адреса', () => {
    expect(breadcrumbLd(O, [{ name: 'Главная', path: '/' }, { name: 'Томск', path: '/tomsk/' }]).itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Главная', item: `${O}/` },
      { '@type': 'ListItem', position: 2, name: 'Томск', item: `${O}/tomsk/` },
    ]);
  });
});

describe('экранирование', () => {
  it('</script> и <!-- из CMS не закрывают тег, текст после разбора тот же', () => {
    const description = 'Описание</script><script>alert(1)</script><!-- x';
    const s = serializeJsonLd(roomLd(O, { path: '/a/', name: 'R', branchPath: P, description }));
    expect(s).not.toContain('<');
    expect((JSON.parse(s) as { description: string }).description).toBe(description);
  });
});
