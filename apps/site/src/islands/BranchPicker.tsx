// Выбор города и филиала (S1-18, карта сайта п.2.9): список приходит с сервера (K5 №1–2, без запроса из браузера),
// выбор кладётся в куку yu_branch = `{city}/{branch}` на год и ведёт на /{city}/{branch}/.
// Кука не HttpOnly намеренно: в ней нет ничего секретного, сервер читает её только для показа.
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { BRANCH_COOKIE, BRANCH_COOKIE_MAX_AGE, branchPath, type BranchStatus } from '../lib/api.ts';

export interface PickerCity {
  slug: string;
  name: string;
  branches: Array<{ slug: string; name: string; address: string; status: BranchStatus }>;
}

interface Props {
  cities: PickerCity[];
  current: { city: string; branch: string } | null;
}

function remember(city: string, branch: string): void {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${BRANCH_COOKIE}=${city}/${branch}; Path=/; Max-Age=${BRANCH_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
}

export default function BranchPicker({ cities, current }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const chosen = current
    ? cities.find((c) => c.slug === current.city)?.branches.find((b) => b.slug === current.branch)
    : undefined;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        toggle.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = (city: string, branch: string) => {
    remember(city, branch);
    setOpen(false);
    location.assign(branchPath(city, branch));
  };

  return (
    <div class="yu-picker" ref={root} data-testid="branch-picker">
      <button
        ref={toggle}
        type="button"
        class="yu-picker__toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
      >
        <span class="yu-picker__label" data-testid="branch-current">{chosen ? chosen.name : 'Выберите клуб'}</span>
        <span class="yu-picker__chevron" aria-hidden="true" />
      </button>
      <div class="yu-picker__panel" id={panelId} hidden={!open}>
        <p class="yu-picker__title">Город и клуб</p>
        {cities.length === 0 && <p class="yu-picker__empty">Список клубов сейчас недоступен. Обновите страницу через минуту.</p>}
        {cities.map((c) => (
          <fieldset class="yu-picker__city" key={c.slug}>
            <legend class="yu-picker__city-name">{c.name}</legend>
            {c.branches.map((b) => {
              const isCurrent = current?.city === c.slug && current.branch === b.slug;
              return (
                <button
                  type="button"
                  class="yu-picker__option"
                  key={b.slug}
                  aria-current={isCurrent ? 'true' : undefined}
                  onClick={() => choose(c.slug, b.slug)}
                >
                  <span class="yu-picker__option-name">{b.name}</span>
                  <span class="yu-picker__option-meta">
                    {b.address}
                    {b.status === 'temporarily_closed' ? ', временно закрыт' : ''}
                  </span>
                </button>
              );
            })}
          </fieldset>
        ))}
      </div>
    </div>
  );
}
