// K23 §2, §4 (S4-54). Одно решение индексации на страницу и мета: ручные поля CMS важнее шаблона; пустое ручное – шаблон.
// Формулировки шаблонов – по умолчанию, ждут заказчика (Q-138). Числа и часы – из данных, не из текста. Файл без зависимостей от Astro:
// его импортируют страницы, Site.astro, карта сайта и тесты.

export type BranchSeoStatus = 'preparing' | 'active' | 'temporarily_closed' | 'archived';

/** Что нужно знать, чтобы решить судьбу страницы (K23 §2). */
export type IndexInput =
  | { kind: 'open' } // главная, каталоги, расписание, «о клубе»: индексируются, пока страница есть
  | { kind: 'closed' } // юридические, /login/, /404, ЛК, предпросмотр – noindex всегда
  | { kind: 'branch'; status: BranchSeoStatus }
  | { kind: 'city'; openBranches: number }
  | { kind: 'room'; published: boolean; branchStatus: BranchSeoStatus }
  | { kind: 'game'; live: boolean; hasFull: boolean }
  | { kind: 'publication'; live: boolean; indexable: boolean; ended: boolean }
  | { kind: 'hubWithMaterial'; hasMaterial: boolean }; // /tournaments/, /reviews/: без материала – noindex и пустое состояние

const indexedBranch = (s: BranchSeoStatus) => s === 'active' || s === 'temporarily_closed';

/** Решение без учёта режима: страница индексируется по своим данным. На нём же строится sitemap.xml и /sitemap/. */
export function isIndexablePage(p: IndexInput): boolean {
  switch (p.kind) {
    case 'open':
      return true;
    case 'closed':
      return false;
    case 'branch':
      return indexedBranch(p.status);
    case 'city':
      return p.openBranches >= 2; // правило «не дорвеи»: страница города только при двух и более филиалах
    case 'room':
      return p.published && indexedBranch(p.branchStatus);
    case 'game':
      return p.live && p.hasFull;
    case 'publication':
      return p.live && p.indexable && !p.ended;
    case 'hubWithMaterial':
      return p.hasMaterial;
  }
}

/** K23 §2: стенд (siteIndexable = false) – noindex всегда, правило 3.5 плана. */
export function robotsFor(p: IndexInput, siteIndexable: boolean): 'index' | 'noindex' {
  return siteIndexable && isIndexablePage(p) ? 'index' : 'noindex';
}

// ---- мета страницы

export interface ManualSeo {
  title?: string | null | undefined;
  description?: string | null | undefined;
  h1?: string | null | undefined;
  ogImage?: string | null | undefined;
}

export type PageMetaInput =
  | { page: 'home'; singleCity?: string | undefined; about?: string | undefined; hero?: string | undefined }
  | { page: 'city'; city: string; branches: readonly string[] }
  | { page: 'branch'; branch: string; city: string; address: string; directions: readonly string[]; hoursToday: string }
  | { page: 'room'; room: string; branch: string; city: string; description?: string | undefined }
  | { page: 'gameCatalog'; direction: 'pc' | 'vr' | 'playstation'; count: number }
  | { page: 'game'; title: string; short: string }
  | { page: 'publication'; title: string; lead: string }
  | { page: 'info'; title: string; text?: string | undefined };

export interface PageMeta {
  title: string;
  description: string;
  h1: string;
  ogImage: string | null;
  ogType: 'website' | 'article';
}

/** Обрезка по целому слову до предела (K23 §4: 160 знаков у описания). */
export function cutByWord(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const part = clean.slice(0, max + 1);
  const space = part.lastIndexOf(' ');
  return (space > 0 ? part.slice(0, space) : clean.slice(0, max)).replace(/[\s,;:–-]+$/, '');
}

/** Склонение числа: 1 адрес, 2 адреса, 5 адресов. */
export function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 100;
  if (d >= 11 && d <= 14) return many;
  const u = n % 10;
  return u === 1 ? one : u >= 2 && u <= 4 ? few : many;
}

/** Бренд не удваивается, если филиал уже назван «Ю-Клуб на Красном». */
const branded = (name: string) => (/^ю-клуб/i.test(name) ? name : `Ю-Клуб ${name}`);

const GAME_WHERE = { pc: 'на ПК', vr: 'VR', playstation: 'на PlayStation' } as const;

function template(p: PageMetaInput): Omit<PageMeta, 'ogImage'> {
  switch (p.page) {
    case 'home':
      return {
        title: `Ю-Клуб – компьютерный клуб: ПК, VR, PlayStation${p.singleCity ? ` – ${p.singleCity}` : ''}`,
        description: cutByWord(p.about ?? 'Игровые ПК, VR и PlayStation в одной сети. Выберите свой клуб: адрес, часы и онлайн-запись.'),
        h1: p.hero ?? 'Компьютерные клубы Ю-Клуб',
        ogType: 'website',
      };
    case 'city': {
      // В данных город только в именительном падеже: «в городе Томск», а не «в Томск» (уточнение шаблона K23 §4, Q-138).
      const n = p.branches.length;
      return {
        title: `Компьютерные клубы Ю-Клуб в городе ${p.city}: ${n} ${plural(n, 'адрес', 'адреса', 'адресов')}`,
        description: cutByWord(`Ю-Клуб в городе ${p.city}: ${p.branches.join(', ')}. ПК, VR и PlayStation, онлайн-запись.`),
        h1: `Ю-Клуб в городе ${p.city}`,
        ogType: 'website',
      };
    }
    case 'branch':
      return {
        title: `${branded(p.branch)}, ${p.city} – ${p.address}`,
        description: cutByWord(`${[...p.directions, ''].join(', ').replace(/, $/, '')}. ${p.hoursToday}. Онлайн-запись на сайте.`.replace(/^\. /, '')),
        h1: branded(p.branch),
        ogType: 'website',
      };
    case 'room':
      return {
        title: `${p.room} – ${branded(p.branch)}, ${p.city}`,
        description: cutByWord(p.description?.trim() || `${p.room} в клубе ${branded(p.branch)}, ${p.city}. Онлайн-запись на сайте.`),
        h1: p.room,
        ogType: 'website',
      };
    case 'gameCatalog':
      return {
        title: `Игры ${GAME_WHERE[p.direction]} в Ю-Клуб`,
        description: `${p.count} ${plural(p.count, 'игра', 'игры', 'игр')}, где поиграть – по филиалам.`,
        h1: `Игры ${GAME_WHERE[p.direction]}`,
        ogType: 'website',
      };
    case 'game':
      return { title: `${p.title} – где поиграть в Ю-Клуб`, description: cutByWord(p.short), h1: p.title, ogType: 'website' };
    case 'publication':
      return { title: `${p.title} – Ю-Клуб`, description: cutByWord(p.lead), h1: p.title, ogType: 'article' };
    case 'info':
      return { title: `${p.title} – Ю-Клуб`, description: cutByWord(p.text ?? p.title), h1: p.title, ogType: 'website' };
  }
}

const filled = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

/** Мета страницы: заполненное ручное поле важнее шаблона, каждое поле решается отдельно. */
export function metaFor(p: PageMetaInput, manual: ManualSeo = {}): PageMeta {
  const t = template(p);
  return {
    title: filled(manual.title) ?? t.title,
    description: filled(manual.description) ?? t.description,
    h1: filled(manual.h1) ?? t.h1,
    ogImage: filled(manual.ogImage),
    ogType: t.ogType,
  };
}
