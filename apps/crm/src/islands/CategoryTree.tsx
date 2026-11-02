// Дерево категорий доходов и расходов (S2-61, K17 №46, 06 §7): два уровня, порядок с сервера, архив вместо удаления.
// Смотрят все, у кого есть касса; меняет только Владелец (finance.category.manage). Третьего уровня нет – кнопка
// «Подкатегория» есть только у категории верхнего уровня. Архив и возврат – окном внутри записи; архив категории
// уводит в архив и её подкатегории (решает сервер). Устаревшая версия (VERSION_CONFLICT) – перечитывание дерева.
import { useRef, useState } from 'preact/hooks';
import { ApiError, browserCall } from '../lib/api.ts';

export interface Cat { id: string; kind: 'income' | 'expense'; parentId: string | null; name: string; sortOrder: number; status: 'active' | 'archived'; rowVersion: number }
export interface CatNode extends Cat { children: Cat[] }
export interface CategoryTreeProps { initial: CatNode[]; canManage: boolean }

type Edit = { mode: 'create'; kind: Cat['kind']; parent: CatNode | null } | { mode: 'rename'; cat: Cat } | { mode: 'status'; cat: Cat };
const KIND_TITLE = { expense: 'Расходы', income: 'Доходы' } as const;

const errorText = (e: unknown) =>
  e instanceof ApiError
    ? e.code === 'VERSION_CONFLICT' ? 'Категорию уже изменили – дерево обновлено, повторите.' : e.code === 'FORBIDDEN' ? 'Недостаточно прав.' : e.message
    : 'Не удалось сохранить. Повторите.';

export default function CategoryTree({ initial, canManage }: CategoryTreeProps) {
  const [tree, setTree] = useState<CatNode[]>(initial);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);

  const reload = async () => setTree((await browserCall<{ items: CatNode[] }>('/finance/categories?includeArchived=true')).items);
  const openEdit = (e: Edit) => {
    setEdit(e);
    setName(e.mode === 'rename' ? e.cat.name : '');
    setError('');
    dialog.current?.showModal();
  };
  const close = () => {
    dialog.current?.close();
    setEdit(null);
  };

  const submit = async (ev: Event) => {
    ev.preventDefault();
    if (!edit || busy) return;
    if (edit.mode !== 'status' && !name.trim()) return setError('Введите название.');
    setBusy(true);
    setError('');
    try {
      if (edit.mode === 'create') {
        await browserCall('/finance/categories', { method: 'POST', body: { kind: edit.kind, parentId: edit.parent?.id ?? null, name: name.trim() } });
        setNotice(`Добавлено: «${name.trim()}»${edit.parent ? ` в «${edit.parent.name}»` : ''}.`);
      } else if (edit.mode === 'rename') {
        await browserCall(`/finance/categories/${edit.cat.id}`, { method: 'PATCH', body: { rowVersion: edit.cat.rowVersion, name: name.trim() } });
        setNotice(`Переименовано: «${name.trim()}».`);
      } else {
        const status = edit.cat.status === 'active' ? 'archived' : 'active';
        await browserCall(`/finance/categories/${edit.cat.id}`, { method: 'PATCH', body: { rowVersion: edit.cat.rowVersion, status } });
        setNotice(status === 'archived' ? `«${edit.cat.name}» – в архиве. Старые операции её сохраняют.` : `«${edit.cat.name}» снова доступна.`);
      }
      close();
      await reload();
    } catch (e) {
      setError(errorText(e));
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') await reload().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const row = (c: Cat, parent: CatNode | null) => (
    <div class={`yc-cat__row${c.status === 'archived' ? ' yc-cat__row--archived' : ''}`} data-testid={`cat-${c.name}`}>
      <span class="yc-cat__name">{c.name}{c.status === 'archived' && <span class="yc-badge yc-badge--archived yc-badge--system">В архиве</span>}</span>
      {canManage && (
        <span class="yc-cat__acts">
          {!parent && c.status === 'active' && (
            <button class="yc-link" type="button" onClick={() => openEdit({ mode: 'create', kind: c.kind, parent: c as CatNode })}>+ Подкатегория</button>
          )}
          <button class="yc-link" type="button" onClick={() => openEdit({ mode: 'rename', cat: c })}>Переименовать</button>
          <button class="yc-link" type="button" onClick={() => openEdit({ mode: 'status', cat: c })}>{c.status === 'active' ? 'В архив…' : 'Вернуть…'}</button>
        </span>
      )}
    </div>
  );

  const title = !edit ? '' : edit.mode === 'create' ? (edit.parent ? `Подкатегория в «${edit.parent.name}»` : `Категория: ${KIND_TITLE[edit.kind].toLowerCase()}`)
    : edit.mode === 'rename' ? `Переименовать «${edit.cat.name}»` : edit.cat.status === 'active' ? `Убрать «${edit.cat.name}» в архив?` : `Вернуть «${edit.cat.name}» из архива?`;

  return (
    <>
      {notice && <p class="yc-alert yc-alert--ok" role="status">{notice}</p>}
      {(['expense', 'income'] as const).map((kind) => {
        const tops = tree.filter((c) => c.kind === kind);
        return (
          <section class="yc-panel" aria-labelledby={`cat-${kind}`} key={kind}>
            <div class="yc-tabs">
              <h2 id={`cat-${kind}`}>{KIND_TITLE[kind]}</h2>
              {canManage && <button class="yc-btn yc-btn--ghost yc-tabs__action" type="button" onClick={() => openEdit({ mode: 'create', kind, parent: null })}>+ Категория</button>}
            </div>
            {tops.length === 0 ? <p class="yc-empty">Категорий пока нет{kind === 'income' ? ': доход различается по источнику (сеанс, мероприятие, доп. услуга, прочее).' : '.'}</p> : (
              <ul class="yc-cat">
                {tops.map((c) => (
                  <li key={c.id}>
                    {row(c, null)}
                    {c.children.length > 0 && <ul class="yc-cat yc-cat--sub">{c.children.map((s) => <li key={s.id}>{row(s, c)}</li>)}</ul>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      <dialog ref={dialog} class="yc-dialog" aria-labelledby="cat-dlg" onClose={() => setEdit(null)}>
        {edit && (
          <form class="yc-dialog__body" novalidate onSubmit={submit}>
            <h2 id="cat-dlg">{title}</h2>
            {edit.mode === 'status' ? (
              <p>{edit.cat.status === 'active'
                ? `Новые операции её не выберут; уже внесённые сохранят категорию навсегда.${edit.cat.parentId === null ? ' Подкатегории тоже уйдут в архив.' : ''}`
                : 'Категория снова появится в форме расхода.'}</p>
            ) : (
              <label class="yc-field">
                <span class="yc-field__label">Название</span>
                <input class="yc-input" type="text" maxLength={200} value={name} onInput={(e) => setName(e.currentTarget.value)} aria-invalid={error ? 'true' : undefined} />
              </label>
            )}
            {error && <p class="yc-alert yc-alert--error" role="alert">{error}</p>}
            <div class="yc-dialog__actions">
              <button class="yc-btn yc-btn--ghost" type="button" onClick={close}>Отмена</button>
              <button class={`yc-btn${edit.mode === 'status' && edit.cat.status === 'active' ? ' yc-btn--danger' : ''}`} type="submit" disabled={busy}>
                {edit.mode === 'status' ? (edit.cat.status === 'active' ? 'В архив' : 'Вернуть') : 'Сохранить'}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </>
  );
}
