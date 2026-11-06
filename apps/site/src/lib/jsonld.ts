// K23 §6 (S4-55). Микроразметка JSON-LD только из правдивых данных: нет значения – нет поля. Без AggregateRating и Review (отзывов нет),
// без цены (Q-79). Сущности связаны через @id: комната и турнир указывают на филиал, филиал – на организацию.
// Адрес филиала – только разобранный из страницы CMS (postal), строка адреса целиком в разметку не идёт (Q-137).

export type JsonLd = Record<string, unknown>;

const CONTEXT = 'https://schema.org';
const orgId = (origin: string) => `${origin}/#organization`;
export const branchId = (origin: string, path: string) => `${origin}${path}#branch`;

/** Ключи с пустым значением не выводятся: разметка не обещает того, чего нет. */
function compact(o: JsonLd): JsonLd {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)),
  );
}
const abs = (origin: string, url: string) => new URL(url, `${origin}/`).href;
const orgRef = (origin: string) => ({ '@id': orgId(origin) });

/** Экранирование `<`: текст из CMS с </script> не закрывает тег разметки. */
export function serializeJsonLd(data: JsonLd): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

export function organizationLd(origin: string, opts: { logo?: string | null; sameAs?: readonly string[] } = {}): JsonLd {
  return compact({
    '@context': CONTEXT, '@type': 'Organization', '@id': orgId(origin), name: 'Ю-Клуб', url: `${origin}/`,
    logo: opts.logo ? abs(origin, opts.logo) : undefined,
    sameAs: opts.sameAs ? [...opts.sameAs] : undefined,
  });
}

export function websiteLd(origin: string): JsonLd {
  return { '@context': CONTEXT, '@type': 'WebSite', name: 'Ю-Клуб', url: `${origin}/`, publisher: orgRef(origin) };
}

export function breadcrumbLd(origin: string, items: ReadonlyArray<{ name: string; path: string }>): JsonLd {
  return {
    '@context': CONTEXT,
    '@type': 'BreadcrumbList',
    itemListElement: items.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: `${origin}${c.path}` })),
  };
}

const DAY = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export interface BranchLdInput {
  path: string;
  name: string;
  status: 'active' | 'temporarily_closed';
  phone?: string | null | undefined;
  weeklyHours?: ReadonlyArray<{ weekday: number; open: string; close: string }> | undefined;
  /** content_branch_pages.postal и geo (K22): не заполнены – поля нет. */
  postal?: { street: string; locality: string; region: string; postalCode: string } | null | undefined;
  geo?: { lat: number; lng: number } | null | undefined;
  images?: readonly string[] | undefined;
}

/** EntertainmentBusiness – подтип LocalBusiness; отдельного типа «компьютерный клуб» в schema.org нет. У временно закрытого часов нет. */
export function branchLd(origin: string, b: BranchLdInput): JsonLd {
  const hours = b.status === 'active' ? (b.weeklyHours ?? []) : [];
  const postal = b.postal
    ? { '@type': 'PostalAddress', addressCountry: 'RU', streetAddress: b.postal.street, addressLocality: b.postal.locality, addressRegion: b.postal.region, postalCode: b.postal.postalCode }
    : undefined;
  return compact({
    '@context': CONTEXT, '@type': 'EntertainmentBusiness', '@id': branchId(origin, b.path), name: b.name, url: `${origin}${b.path}`,
    telephone: b.phone,
    address: postal,
    geo: b.geo ? { '@type': 'GeoCoordinates', latitude: b.geo.lat, longitude: b.geo.lng } : undefined,
    openingHoursSpecification: hours.map((h) => ({ '@type': 'OpeningHoursSpecification', dayOfWeek: DAY[h.weekday], opens: h.open, closes: h.close })),
    image: b.images?.map((u) => abs(origin, u)),
    parentOrganization: orgRef(origin),
  });
}

export function roomLd(origin: string, r: { path: string; name: string; branchPath: string; description?: string | null | undefined; images?: readonly string[] | undefined; capacity?: number | null | undefined }): JsonLd {
  return compact({
    '@context': CONTEXT, '@type': 'Place', name: r.name, url: `${origin}${r.path}`, description: r.description,
    image: r.images?.map((u) => abs(origin, u)),
    maximumAttendeeCapacity: r.capacity,
    containedInPlace: { '@id': branchId(origin, r.branchPath) },
  });
}

/** Турнир: разметка только при охвате ровно одним филиалом – иначе место проведения было бы выдумкой (K23 §6). */
export function tournamentLd(origin: string, t: { path: string; title: string; lead: string; startDate?: string | null | undefined; branchPaths: readonly string[]; image?: string | null | undefined }): JsonLd | null {
  if (t.branchPaths.length !== 1 || !t.startDate) return null;
  return compact({
    '@context': CONTEXT, '@type': 'Event', name: t.title, url: `${origin}${t.path}`, startDate: t.startDate,
    description: t.lead,
    location: { '@id': branchId(origin, t.branchPaths[0]!) },
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    organizer: orgRef(origin),
    image: t.image ? abs(origin, t.image) : undefined,
  });
}

/** Акция: без цены (Q-79). Охват – один филиал: offeredBy он, иначе организация; города охвата – areaServed. */
export function promotionLd(origin: string, p: { path: string; title: string; lead: string; publishFrom?: string | null | undefined; publishTo?: string | null | undefined; ended: boolean; branchPaths: readonly string[]; cities: readonly string[] }): JsonLd {
  return compact({
    '@context': CONTEXT, '@type': 'Offer', name: p.title, description: p.lead, url: `${origin}${p.path}`,
    validFrom: p.publishFrom, validThrough: p.publishTo,
    availability: p.ended ? 'https://schema.org/Discontinued' : 'https://schema.org/InStock',
    offeredBy: p.branchPaths.length === 1 ? { '@id': branchId(origin, p.branchPaths[0]!) } : orgRef(origin),
    areaServed: p.cities.map((name) => ({ '@type': 'City', name })),
  });
}

export function newsLd(origin: string, n: { path: string; title: string; datePublished: string; dateModified?: string | null | undefined; image?: string | null | undefined }): JsonLd {
  return compact({
    '@context': CONTEXT, '@type': 'NewsArticle', headline: n.title, url: `${origin}${n.path}`,
    datePublished: n.datePublished, dateModified: n.dateModified ?? n.datePublished,
    image: n.image ? abs(origin, n.image) : undefined,
    author: orgRef(origin), publisher: orgRef(origin),
  });
}
