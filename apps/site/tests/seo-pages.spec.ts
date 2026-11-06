// S4-54: мета на собранных страницах (K23 §4): шаблоны title, description, H1 один на страницу; canonical и og:url без параметров; индекс по единому решению.
import { expect, test, type APIRequestContext } from '../../../tests/support/e2e.ts';
import { PROD_PORT } from '../playwright.config.ts';

const PROD = `http://127.0.0.1:${PROD_PORT}`;
const html = async (request: APIRequestContext, path: string) => (await request.get(`${PROD}${path}`)).text();
const h1Count = (s: string) => (s.match(/<h1[\s>]/g) ?? []).length;

/** Все блоки разметки страницы: каждый разбирается как JSON, сырого < в них нет. */
function jsonLd(s: string): Array<Record<string, unknown>> {
  return [...s.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map((m) => {
    expect(m[1]).not.toContain('<');
    return JSON.parse(m[1]!) as Record<string, unknown>;
  });
}
const ofType = (blocks: Array<Record<string, unknown>>, type: string) => blocks.find((b) => b['@type'] === type);

test('JSON-LD филиала и комнаты: только реальные данные, связь через @id, нет рейтинга и цены', async ({ request }) => {
  const s = await html(request, '/tomsk/lenina/');
  const blocks = jsonLd(s);
  const b = ofType(blocks, 'EntertainmentBusiness')!;
  expect(b).toMatchObject({ '@id': 'https://yu-club.test/tomsk/lenina/#branch', name: 'Ю-Клуб на Ленина', url: 'https://yu-club.test/tomsk/lenina/', parentOrganization: { '@id': 'https://yu-club.test/#organization' } });
  expect(b.openingHoursSpecification).toHaveLength(7);
  expect(b.telephone).toBeUndefined(); // телефона нет в данных – поля нет
  expect(b.address).toBeUndefined(); // разобранного адреса CMS нет – строку не подставляем
  expect(ofType(blocks, 'Organization')).toBeTruthy();
  expect(ofType(blocks, 'BreadcrumbList')!.itemListElement).toHaveLength(2); // у Томска один филиал – страницы города нет, в крошках её нет
  const closed = ofType(jsonLd(await html(request, '/novosibirsk/akademgorodok/')), 'EntertainmentBusiness')!;
  expect(closed.openingHoursSpecification).toBeUndefined(); // временно закрыт – без часов
  const near = ofType(jsonLd(await html(request, '/novosibirsk/krasny-prospekt/')), 'BreadcrumbList')!;
  expect(near.itemListElement).toHaveLength(3); // в Новосибирске страница города есть

  const roomHtml = await html(request, '/novosibirsk/krasny-prospekt/rooms/vr-ps4-room/');
  const room = ofType(jsonLd(roomHtml), 'Place');
  expect(room).toMatchObject({ '@type': 'Place', containedInPlace: { '@id': 'https://yu-club.test/novosibirsk/krasny-prospekt/#branch' } });
  for (const page of [s, roomHtml]) for (const word of ['AggregateRating', 'priceCurrency', '"price"', '"review"']) expect(page).not.toContain(word);
});

test('JSON-LD главной и города: организация и сайт только на главной, крошки – везде, кроме главной', async ({ request }) => {
  const home = jsonLd(await html(request, '/'));
  expect(ofType(home, 'Organization')).toMatchObject({ name: 'Ю-Клуб', url: 'https://yu-club.test/' });
  expect(ofType(home, 'WebSite')).toBeTruthy();
  expect(ofType(home, 'BreadcrumbList')).toBeUndefined();
  for (const path of ['/novosibirsk/', '/rules/', '/schedule/']) {
    expect(ofType(jsonLd(await html(request, path)), 'BreadcrumbList'), path).toBeTruthy();
  }
});

test('филиал: шаблон title и description, один H1, canonical и og:url без параметров', async ({ request }) => {
  const s = await html(request, '/tomsk/lenina/?branch=1&zone=pc&utm_source=x');
  expect(s).toContain('<title>Ю-Клуб на Ленина, Томск – проспект Ленина, 80</title>');
  expect(s).toMatch(/<meta name="description" content="[^"]*Сегодня: 10:00–22:00\. Онлайн-запись на сайте\."/);
  expect(s).toContain('<link rel="canonical" href="https://yu-club.test/tomsk/lenina/">');
  expect(s).toContain('<meta property="og:url" content="https://yu-club.test/tomsk/lenina/">');
  expect(s).toContain('<meta property="og:type" content="website">');
  expect(s).toContain('<meta name="robots" content="index, follow">');
  expect(h1Count(s)).toBe(1);
  expect(s).not.toContain('Ю-Клуб Ю-Клуб');
});

test('город с двумя филиалами: шаблон, индекс; временно закрытый филиал остаётся в индексе', async ({ request }) => {
  const s = await html(request, '/novosibirsk/');
  expect(s).toContain('<title>Компьютерные клубы Ю-Клуб в городе Новосибирск: 2 адреса</title>');
  expect(s).toContain('<meta name="robots" content="index, follow">');
  expect(h1Count(s)).toBe(1);
  expect(s).toMatch(/<h1[^>]*>Ю-Клуб в городе Новосибирск<\/h1>/);
  const closed = await html(request, '/novosibirsk/akademgorodok/');
  expect(closed).toContain('<meta name="robots" content="index, follow">');
  expect(closed).toMatch(/<meta name="description" content="[^"]*Временно закрыт\."/);
});

test('юридическая – noindex, правила – индекс, стенд – noindex на тех же страницах', async ({ request }) => {
  expect(await html(request, '/privacy-policy/')).toContain('content="noindex, nofollow"');
  expect(await html(request, '/rules/')).toContain('content="index, follow"');
  for (const path of ['/tomsk/lenina/', '/novosibirsk/', '/rules/']) {
    expect(await (await request.get(path)).text(), path).toContain('<meta name="robots" content="noindex, nofollow">');
  }
});
