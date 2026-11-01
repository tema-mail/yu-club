// Сотрудник в CRM (S0-15c, staff/routes.staff.ts): создание Администратора/Директора, карточка с правкой
// (имя, телефон, роль, назначения) по rowVersion, блокировка/разблокировка через окно с причиной, история.
// Временный пароль сервер отдаёт один раз – показываем его сразу после создания с «Скопировать» и предупреждением.
// Права здесь лишь прячут лишнее; решает сервер (K1: Директор – только Администраторов своей зоны).
import { useRef, useState } from 'preact/hooks';
import { ApiError, browserCall, type StaffRole } from '../lib/api.ts';
import EntityCard, { type CardField } from './EntityCard.tsx';

export type StaffStatus = 'active' | 'blocked' | 'archived';
export interface StaffItem {
  id: string; firstName: string; lastName: string; email: string; phone: string | null; role: StaffRole; status: StaffStatus;
  mustChangePassword: boolean; lastLoginAt: string | null; rowVersion: number;
  assignments: Array<{ id: string; scopeType: 'city' | 'branch'; cityId: string | null; branchId: string | null; validFrom: string; validTo: string | null }>;
}
export interface ZoneBranch { id: string; name: string; cityId: string; cityName: string }

export interface StaffFormProps {
  staff?: StaffItem;
  branches: ZoneBranch[];
  /** Города, на которые можно назначить целиком (Владелец – все, Директор – свои). */
  cityIds: string[];
  roleOptions: Array<{ value: StaffRole; label: string }>;
  roleLabels: Record<string, string>;
  statusLabels: Record<string, string>;
  canProfile: boolean;
  canRole: boolean;
  canScope: boolean;
  canBlock: boolean;
  timezone: string;
}

const CONFLICT = 'Карточку уже изменил другой сотрудник. Обновите страницу – ваши правки придётся внести заново.';
const errorText = (e: unknown) => (e instanceof ApiError ? e.message.replace(/\.$/, '') : 'Неизвестная ошибка');

/** '+7 (913) 123-45-67', '8913…' → '+79131234567'; пусто – null; не похоже на телефон – undefined (ошибка). */
function phoneOf(raw: string): string | null | undefined {
  const t = raw.replace(/[\s()-]/g, '');
  if (t === '') return null;
  const e = /^8\d{10}$/.test(t) ? `+7${t.slice(1)}` : /^\d{10}$/.test(t) ? `+7${t}` : t;
  return /^\+\d{10,15}$/.test(e) ? e : undefined;
}

function markClean(form: HTMLFormElement) {
  for (const el of Array.from(form.elements)) {
    if (el instanceof HTMLInputElement) {
      el.defaultValue = el.value;
      el.defaultChecked = el.checked;
    } else if (el instanceof HTMLSelectElement) for (const o of Array.from(el.options)) o.defaultSelected = o.selected;
  }
}

const sorted = (x: string[]) => JSON.stringify([...x].sort());

export default function StaffForm(props: StaffFormProps) {
  const { branches, roleOptions, roleLabels, statusLabels, timezone } = props;
  const creating = !props.staff;
  const form = useRef<HTMLFormElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [staff, setStaff] = useState<StaffItem | undefined>(props.staff);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ id: string; name: string; password: string } | null>(null);
  const [copied, setCopied] = useState('');
  const [reason, setReason] = useState('');
  const [blockError, setBlockError] = useState('');
  const [historyKey, setHistoryKey] = useState(0);

  const cities = [...new Map(branches.map((b) => [b.cityId, b.cityName])).entries()];
  const cityName = (id: string) => cities.find(([c]) => c === id)?.[1] ?? id;
  const branchName = (id: string) => branches.find((b) => b.id === id)?.name ?? id;
  const curBranches = staff?.assignments.flatMap((a) => (a.branchId ? [a.branchId] : [])) ?? [];
  const curCities = staff?.assignments.flatMap((a) => (a.cityId ? [a.cityId] : [])) ?? [];
  const editable = creating || props.canProfile;
  const fmt = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: timezone });

  const onSubmit = async (e: Event) => {
    e.preventDefault();
    const f = form.current;
    if (!f) return;
    setStatus(null);
    const fd = new FormData(f);
    const text = (k: string) => String(fd.get(k) ?? '').trim();
    const local: Record<string, string> = {};
    if (editable && !text('firstName')) local.firstName = 'Заполните поле';
    if (editable && !text('lastName')) local.lastName = 'Заполните поле';
    if (creating && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text('email'))) local.email = 'Укажите почту';
    const phone = phoneOf(text('phone'));
    if (editable && phone === undefined) local.phone = 'Номер в формате +7 913 123-45-67';
    const branchIds = fd.getAll('branchIds').map(String);
    const cityIds = fd.getAll('cityIds').map(String);
    const scopeOn = creating || props.canScope;
    if (scopeOn && branchIds.length + cityIds.length === 0) local.assignments = 'Отметьте хотя бы один филиал или город';
    setErrors(local);
    if (Object.keys(local).length) {
      setStatus({ ok: false, text: 'Проверьте отмеченные поля.' });
      return;
    }
    let body: Record<string, unknown>;
    if (creating) {
      body = { firstName: text('firstName'), lastName: text('lastName'), email: text('email'), role: text('role'), branchIds, cityIds };
      if (phone) body.phone = phone;
    } else {
      body = {};
      if (editable && text('firstName') !== staff!.firstName) body.firstName = text('firstName');
      if (editable && text('lastName') !== staff!.lastName) body.lastName = text('lastName');
      if (editable && phone !== staff!.phone) body.phone = phone;
      if (props.canRole && text('role') && text('role') !== staff!.role) body.role = text('role');
      if (scopeOn && (sorted(branchIds) !== sorted(curBranches) || sorted(cityIds) !== sorted(curCities))) Object.assign(body, { branchIds, cityIds });
      if (Object.keys(body).length === 0) {
        setStatus({ ok: true, text: 'Изменений нет.' });
        return;
      }
      body.rowVersion = staff!.rowVersion;
    }
    setBusy(true);
    try {
      if (creating) {
        const r = await browserCall<{ staff: StaffItem; temporaryPassword: string }>('/staff', { method: 'POST', body });
        markClean(f);
        setCreated({ id: r.staff.id, name: `${r.staff.firstName} ${r.staff.lastName}`, password: r.temporaryPassword });
      } else {
        const saved = await browserCall<StaffItem>(`/staff/${encodeURIComponent(staff!.id)}`, { method: 'PATCH', body });
        markClean(f);
        setStaff(saved);
        setStatus({ ok: true, text: 'Сохранено.' });
        setHistoryKey((k) => k + 1);
      }
    } catch (err) {
      const issues = err instanceof ApiError ? (err.details?.issues as Array<{ path: string; message: string }> | undefined) : undefined;
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') setStatus({ ok: false, text: CONFLICT });
      else if (issues?.length) {
        setErrors(Object.fromEntries(issues.map((i) => [i.path.startsWith('branchIds') || i.path.startsWith('cityIds') ? 'assignments' : i.path.split('.')[0]!, err instanceof ApiError && issues.length === 1 ? err.message : i.message])));
        setStatus({ ok: false, text: `Не сохранено: ${errorText(err)}.` });
      } else setStatus({ ok: false, text: `Не сохранено: ${errorText(err)}.` });
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created!.password);
      setCopied('Скопировано.');
    } catch {
      setCopied('Не удалось скопировать – выделите пароль и скопируйте вручную.');
    }
  };

  const blockOp = async () => {
    if (!staff) return;
    if (!reason.trim()) {
      setBlockError('Укажите причину.');
      return;
    }
    const op = staff.status === 'blocked' ? 'unblock' : 'block';
    setBusy(true);
    setBlockError('');
    try {
      const saved = await browserCall<StaffItem>(`/staff/${encodeURIComponent(staff.id)}/${op}`, {
        method: 'POST', body: { rowVersion: staff.rowVersion, reason: reason.trim() },
      });
      setStaff(saved);
      setReason('');
      dialog.current?.close();
      setStatus({ ok: true, text: op === 'block' ? 'Сотрудник заблокирован.' : 'Сотрудник разблокирован.' });
      setHistoryKey((k) => k + 1);
    } catch (err) {
      setBlockError(err instanceof ApiError && err.code === 'VERSION_CONFLICT' ? CONFLICT : `Не получилось: ${errorText(err)}.`);
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <section class="yc-panel" aria-labelledby="created-title" data-testid="staff-created">
        <h2 id="created-title">Сотрудник создан: {created.name}</h2>
        <p>Временный пароль для первого входа:</p>
        <p><code data-testid="temp-password" style={{ fontSize: "1.25rem", wordBreak: "break-all" }}>{created.password}</code></p>
        <div><button type="button" class="yc-btn" onClick={() => void copy()}>Скопировать</button></div>
        <p role="status" aria-live="polite">{copied}</p>
        <p class="yc-alert yc-alert--error" role="alert">
          Пароль показан один раз: после ухода со страницы его не увидеть. Передайте его сотруднику лично – при первом входе он
          сменит пароль на свой.
        </p>
        <p><a href={`/staff/${encodeURIComponent(created.id)}`}>Открыть карточку</a> · <a href="/staff/new">Добавить ещё</a></p>
      </section>
    );
  }

  const field = (name: string, label: string, value: string, opts: { required?: boolean; readOnly?: boolean; type?: 'text' | 'email' | 'tel'; hint?: string } = {}) => {
    const id = `staff-${name}`;
    const err = errors[name];
    return (
      <div class="yc-field">
        <label class="yc-field__label" for={id}>{label}{opts.required && !opts.readOnly ? ' *' : ''}</label>
        <input id={id} name={name} class="yc-input" type={(opts.type ?? 'text') as 'text'} defaultValue={value} readOnly={opts.readOnly}
          aria-invalid={err ? 'true' : undefined} aria-describedby={err || opts.hint ? `${id}-note` : undefined} />
        {(err || opts.hint) && <p id={`${id}-note`} class={err ? 'yc-field__error' : 'yc-field__hint'}>{err ?? opts.hint}</p>}
      </div>
    );
  };
  const scopeOn = creating || props.canScope;
  const historyFields: CardField[] = [
    { kind: 'text', name: 'firstName', label: 'Имя' }, { kind: 'text', name: 'lastName', label: 'Фамилия' },
    { kind: 'text', name: 'email', label: 'Почта' }, { kind: 'text', name: 'phone', label: 'Телефон' },
    { kind: 'select', name: 'role', label: 'Роль', labels: roleLabels },
    { kind: 'select', name: 'status', label: 'Статус', labels: statusLabels },
    { kind: 'text', name: 'branchIds', label: 'Филиалы', labels: Object.fromEntries(branches.map((b) => [b.id, b.name])) },
    { kind: 'text', name: 'cityIds', label: 'Города', labels: Object.fromEntries(cities) },
    { kind: 'text', name: 'sessionsEnded', label: 'Завершено сессий' },
  ];

  return (
    <>
      <section class="yc-panel" aria-label="Карточка сотрудника">
        <form class="yc-form yc-form--wide" ref={form} data-guard="" novalidate onSubmit={onSubmit}>
          {field('lastName', 'Фамилия', staff?.lastName ?? '', { required: true, readOnly: !editable })}
          {field('firstName', 'Имя', staff?.firstName ?? '', { required: true, readOnly: !editable })}
          {field('email', 'Почта (логин)', staff?.email ?? '', { required: creating, readOnly: !creating, type: 'email' })}
          {field('phone', 'Телефон', staff?.phone ?? '', { readOnly: !editable, type: 'tel', hint: 'Необязательно. +7 913 123-45-67' })}
          <div class="yc-field">
            <label class="yc-field__label" for="staff-role">Роль{creating ? ' *' : ''}</label>
            <select id="staff-role" name="role" class="yc-input" disabled={!creating && !props.canRole}>
              {(creating || props.canRole ? roleOptions : [{ value: staff!.role, label: roleLabels[staff!.role] ?? staff!.role }]).map((o) => (
                <option key={o.value} value={o.value} selected={o.value === staff?.role}>{o.label}</option>
              ))}
            </select>
          </div>
          <fieldset class="yc-week" aria-describedby={errors.assignments ? 'staff-assign-note' : undefined}>
            <legend class="yc-field__label">Назначения{scopeOn ? ' *' : ''}</legend>
            {staff && !scopeOn && staff.assignments.length === 0 && <p class="yc-empty">Вся сеть</p>}
            {cities.map(([cid, cname]) => (
              <div key={cid}>
                {props.cityIds.includes(cid) || curCities.includes(cid) ? (
                  <label class="yc-check">
                    <input type="checkbox" name="cityIds" value={cid} defaultChecked={curCities.includes(cid)} disabled={!scopeOn} />
                    {cname} – весь город
                  </label>
                ) : (
                  <p class="yc-field__hint">{cname}</p>
                )}
                {branches.filter((b) => b.cityId === cid).map((b) => (
                  <label class="yc-check" key={b.id}>
                    <input type="checkbox" name="branchIds" value={b.id} defaultChecked={curBranches.includes(b.id)} disabled={!scopeOn} />
                    {b.name}
                  </label>
                ))}
              </div>
            ))}
            {[...curBranches.filter((b) => !branches.some((x) => x.id === b)), ...curCities.filter((c) => !cities.some(([x]) => x === c))].map((id) => (
              <p class="yc-field__hint" key={id}>{branchName(id) === id ? cityName(id) : branchName(id)} (вне списка филиалов)</p>
            ))}
            {errors.assignments && <p id="staff-assign-note" class="yc-field__error">{errors.assignments}</p>}
          </fieldset>
          {staff && (
            <p class="yc-field__hint">
              Последний вход: {staff.lastLoginAt ? fmt.format(new Date(staff.lastLoginAt)) : 'не входил'}
              {staff.mustChangePassword ? ' · при входе сменит временный пароль' : ''}
            </p>
          )}
          <p class={`yc-alert ${status ? (status.ok ? 'yc-alert--ok' : 'yc-alert--error') : ''}`} role="status" aria-live="polite">
            {status?.text ?? ''}
          </p>
          {(creating || props.canProfile || props.canRole || props.canScope) && (
            <div>
              <button class="yc-btn" type="submit" disabled={busy}>{busy ? 'Сохранение…' : creating ? 'Создать сотрудника' : 'Сохранить'}</button>
            </div>
          )}
        </form>
      </section>

      {staff && props.canBlock && staff.status !== 'archived' && (
        <section class="yc-panel" aria-labelledby="access-title">
          <h2 id="access-title">Доступ в CRM</h2>
          <p>
            Статус: <span class={`yc-badge yc-badge--${staff.status}`} data-testid="staff-status">{statusLabels[staff.status]}</span>
          </p>
          <div>
            <button type="button" class={`yc-btn yc-btn--ghost${staff.status === 'active' ? ' yc-btn--danger-text' : ''}`}
              onClick={() => { setBlockError(''); dialog.current?.showModal(); }}>
              {staff.status === 'blocked' ? 'Разблокировать…' : 'Заблокировать…'}
            </button>
          </div>
        </section>
      )}

      {staff && props.canBlock && (
        <dialog ref={dialog} class="yc-dialog" aria-labelledby="block-title">
          <div class="yc-dialog__body">
            <h2 id="block-title">{staff.status === 'blocked' ? 'Разблокировать сотрудника?' : 'Заблокировать сотрудника?'}</h2>
            <p>
              {staff.status === 'blocked'
                ? `${staff.firstName} ${staff.lastName} снова сможет войти в CRM со своим паролем.`
                : `${staff.firstName} ${staff.lastName} сразу выйдет из CRM на всех устройствах и не сможет войти, пока его не разблокируют. История сохранится.`}
            </p>
            <div class="yc-field">
              <label class="yc-field__label" for="block-reason">Причина *</label>
              <input id="block-reason" class="yc-input" value={reason} maxLength={500}
                onInput={(e) => setReason((e.currentTarget as HTMLInputElement).value)} />
            </div>
            <p class="yc-alert yc-alert--error" role="alert">{blockError}</p>
            <div class="yc-dialog__actions">
              <button type="button" class="yc-btn yc-btn--ghost" autofocus onClick={() => dialog.current?.close()}>Отмена</button>
              <button type="button" class={staff.status === 'blocked' ? 'yc-btn' : 'yc-btn yc-btn--danger'} disabled={busy} onClick={() => void blockOp()}>
                {staff.status === 'blocked' ? 'Разблокировать' : 'Заблокировать'}
              </button>
            </div>
          </div>
        </dialog>
      )}

      {staff && (
        <EntityCard key={historyKey} historyOnly fields={historyFields} values={{}}
          history={{ objectType: 'staff', objectId: staff.id, timezone }} />
      )}
    </>
  );
}
