// S4-111. Показ публикаций (K22 §4, 12 §8): охват словами, даты по зоне клуба, подписи разделов. Без зависимостей от Astro –
// импортируют компоненты PublicationList/PublicationPage, страницы /news/, /promotions/, /giveaways/, /tournaments/ и тесты.
import { publicationsPath, type PublicationType } from '../../../../packages/contracts/src/paths.ts';
import { branchPath, findBranch, type BranchDto, type CityWithBranches } from './api.ts';
import type { OnlyIn } from './content.ts';

export const SECTION: Record<PublicationType, { title: string; one: string; empty: string; ended: string }> = {
  news: { title: 'Новости', one: 'Новость', empty: 'Новостей пока нет. Загляните позже.', ended: 'Материал больше не актуален' },
  promotion: { title: 'Акции', one: 'Акция', empty: 'Сейчас действующих акций нет. Загляните позже.', ended: 'Акция завершена' },
  giveaway: { title: 'Розыгрыши', one: 'Розыгрыш', empty: 'Сейчас розыгрышей нет. Загляните позже.', ended: 'Розыгрыш завершён' },
  tournament: { title: 'Турниры', one: 'Турнир', empty: 'Турниров пока нет. Когда объявим первый, он появится здесь.', ended: 'Турнир завершён' },
};

export const sectionPath = (type: PublicationType) => publicationsPath(type);

/** Охват словами (K22 §4): пусто – вся сеть; один город или клуб – «Только в …»; несколько – списком. */
export function scopeText(onlyIn: readonly OnlyIn[]): string {
  if (onlyIn.length === 0) return 'Во всех клубах сети';
  if (onlyIn.length === 1) {
    const o = onlyIn[0]!;
    return o.type === 'city' ? `Только в городе ${o.name}` : `Только в клубе «${o.name}»`;
  }
  return `Только: ${onlyIn.map((o) => o.name).join(', ')}`;
}

/** «11 ноября 2026» по зоне клуба. */
export function formatDay(isoDate: string, timeZone: string): string {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone }).format(new Date(isoDate));
}

/** Зона показа дат: выбранного клуба, иначе первого города сети, иначе Москва. */
export function displayZone(network: CityWithBranches[] | null, chosen: { branch: BranchDto } | null): string {
  return chosen?.branch.timezone ?? network?.[0]?.timezone ?? 'Europe/Moscow';
}

/** Клуб из выбора посетителя (кука yu_branch) – id для параметра ?branch= API контента. */
export function chosenBranch(network: CityWithBranches[] | null, choice: { city: string; branch: string } | null) {
  return network && choice ? findBranch(network, choice.city, choice.branch) : null;
}

/** Адреса клубов охвата – для JSON-LD (location, offeredBy). Клуба нет в публичном списке – не выводим. */
export function scopeBranchPaths(onlyIn: readonly OnlyIn[], network: CityWithBranches[] | null): string[] {
  const out: string[] = [];
  for (const o of onlyIn) {
    if (o.type !== 'branch') continue;
    for (const c of network ?? []) {
      const b = c.branches.find((x) => x.id === o.id);
      if (b) out.push(branchPath(c.slug, b.slug));
    }
  }
  return out;
}

export const scopeCities = (onlyIn: readonly OnlyIn[]) => onlyIn.filter((o) => o.type === 'city').map((o) => o.name);
