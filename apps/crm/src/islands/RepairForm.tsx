// Регистрация неисправности (S3-79, K19 №342, §6; 10 §13.4): оборудование, дата поломки или отметка «неизвестна» (дата не подменяется
// обнаружением, 10 §6.1), обнаружение, описание, приоритет, влияние, автор. При повторе – прошлые ремонты и связь previousRepairId
// (гарантийным случаем система ничего не признаёт). После сохранения – карточка с предложением блокировки; документы прикладываются там.
import { useEffect, useState } from 'preact/hooks';
import { ApiError, browserCall } from '../lib/api.ts';
import { IMPACT, PRIORITY, REPAIR_STATUS, errorText, fmtAt, fromLocalInput, toLocalInput, type RepairDto, type RepairImpact, type RepairPriority } from '../lib/equipment.ts';

export interface RepairFormProps {
  equipment: Array<{ id: string; label: string; branchId: string }>;
  defaultEquipmentId: string;
  timezones: Record<string, string>;
  fallbackTimezone: string;
  me: string;
}

export default function RepairForm(p: RepairFormProps) {
  const known = p.equipment.some((e) => e.id === p.defaultEquipmentId);
  const [equipmentId, setEquipmentId] = useState(known ? p.defaultEquipmentId : '');
  const branchId = p.equipment.find((e) => e.id === equipmentId)?.branchId;
  const tz = (branchId && p.timezones[branchId]) || p.fallbackTimezone;
  const [unknown, setUnknown] = useState(false);
  const [brokenAt, setBrokenAt] = useState('');
  const [detectedAt, setDetectedAt] = useState(toLocalInput(Date.now(), tz));
  const [symptoms, setSymptoms] = useState('');
  const [priority, setPriority] = useState<RepairPriority>('medium');
  const [impact, setImpact] = useState<RepairImpact>('partial');
  const [reporter, setReporter] = useState('');
  const [history, setHistory] = useState<RepairDto[]>([]);
  const [previous, setPrevious] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setHistory([]);
    setPrevious('');
    if (!equipmentId) return;
    let live = true;
    browserCall<{ items: RepairDto[] }>(`/repairs?equipmentId=${equipmentId}`).then((r) => { if (live) setHistory(r.items); }).catch(() => undefined);
    return () => { live = false; };
  }, [equipmentId]);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    if (!equipmentId) return setError('Выберите оборудование.');
    if (!unknown && !brokenAt) return setError('Укажите дату поломки или отметьте, что она неизвестна.');
    if (!detectedAt) return setError('Укажите дату обнаружения.');
    if (!symptoms.trim()) return setError('Опишите неисправность.');
    if (!unknown && brokenAt > detectedAt) return setError('Поломка не может быть позже обнаружения.');
    setBusy(true);
    setError('');
    try {
      const r = await browserCall<{ repair: RepairDto }>('/repairs', {
        method: 'POST',
        body: {
          equipmentId, detectedAt: fromLocalInput(detectedAt, tz), symptoms: symptoms.trim(), priority, impact,
          ...(unknown ? { brokenAtUnknown: true } : { brokenAt: fromLocalInput(brokenAt, tz) }),
          ...(reporter.trim() ? { reportedByName: reporter.trim() } : {}),
          ...(previous ? { previousRepairId: previous } : {}),
        },
      });
      location.assign(`/repairs/${r.repair.id}?registered=1`);
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'EQUIPMENT_WRITTEN_OFF' ? 'Списанное оборудование не ремонтируется.' : errorText(err));
      setBusy(false);
    }
  };

  return (
    <form class="yc-form yc-form--wide" novalidate onSubmit={submit} data-testid="rp-form">
      <label class="yc-field"><span class="yc-field__label">Оборудование *</span>
        <select class="yc-input" value={equipmentId} onChange={(e) => setEquipmentId((e.currentTarget as HTMLSelectElement).value)}>
          <option value="">Выберите…</option>
          {p.equipment.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
        </select>
      </label>
      {history.length > 0 && (
        <div class="yc-eq__warn" data-testid="rp-history">
          <strong>Этот предмет уже ремонтировали</strong>
          <ul class="yc-eq__rows">{history.map((h) => <li key={h.id}><a href={`/repairs/${h.id}`} target="_blank" rel="noopener">{h.number}</a> · {REPAIR_STATUS[h.status]} · {fmtAt(h.detectedAt, tz)} · {h.symptoms}</li>)}</ul>
          <label class="yc-field"><span class="yc-field__label">Это повтор поломки?</span>
            <select class="yc-input" value={previous} onChange={(e) => setPrevious((e.currentTarget as HTMLSelectElement).value)}>
              <option value="">Нет, новая неисправность</option>
              {history.map((h) => <option key={h.id} value={h.id}>Повтор {h.number}</option>)}
            </select>
          </label>
        </div>
      )}
      <div class="yc-eq__pair">
        <label class="yc-field"><span class="yc-field__label">Когда сломалось (время филиала)</span>
          <input class="yc-input" type="datetime-local" disabled={unknown} value={brokenAt} onInput={(e) => setBrokenAt((e.currentTarget as HTMLInputElement).value)} />
        </label>
        <label class="yc-field"><span class="yc-field__label">Когда обнаружено *</span>
          <input class="yc-input" type="datetime-local" value={detectedAt} onInput={(e) => setDetectedAt((e.currentTarget as HTMLInputElement).value)} />
        </label>
      </div>
      <label class="yc-check"><input type="checkbox" checked={unknown} onChange={(e) => { setUnknown((e.currentTarget as HTMLInputElement).checked); setBrokenAt(''); }} />Дата поломки неизвестна</label>
      <label class="yc-field"><span class="yc-field__label">Что случилось *</span>
        <textarea class="yc-input" rows={3} maxLength={4000} value={symptoms} onInput={(e) => setSymptoms((e.currentTarget as HTMLTextAreaElement).value)} />
        <span class="yc-field__hint">Первое описание потом не перезаписывается: диагностика и причина – отдельными полями в карточке.</span>
      </label>
      <div class="yc-eq__pair">
        <label class="yc-field"><span class="yc-field__label">Приоритет</span>
          <select class="yc-input" value={priority} onChange={(e) => setPriority((e.currentTarget as HTMLSelectElement).value as RepairPriority)}>
            {(Object.keys(PRIORITY) as RepairPriority[]).map((k) => <option key={k} value={k}>{PRIORITY[k]}</option>)}
          </select>
        </label>
        <label class="yc-field"><span class="yc-field__label">Влияние на работу</span>
          <select class="yc-input" value={impact} onChange={(e) => setImpact((e.currentTarget as HTMLSelectElement).value as RepairImpact)}>
            {(Object.keys(IMPACT) as RepairImpact[]).map((k) => <option key={k} value={k}>{IMPACT[k]}</option>)}
          </select>
        </label>
      </div>
      <label class="yc-field"><span class="yc-field__label">Кто сообщил</span>
        <input class="yc-input" maxLength={200} placeholder={p.me} value={reporter} onInput={(e) => setReporter((e.currentTarget as HTMLInputElement).value)} />
        <span class="yc-field__hint">Автор записи – вы ({p.me}). Заполните, если сообщил другой человек.</span>
      </label>
      <p class="yc-field__hint">Фото и документы можно приложить в карточке сразу после сохранения.</p>
      <p class="yc-alert yc-alert--error" role="alert">{error}</p>
      <div class="yc-eq__actions">
        <button type="submit" class="yc-btn" disabled={busy}>Зарегистрировать</button>
        <a class="yc-btn yc-btn--ghost" href="/repairs">Отмена</a>
      </div>
    </form>
  );
}
