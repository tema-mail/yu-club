// Постановка на учёт и правка карточки оборудования (S3-76, K19 №332). Инвентарный номер выдаёт система. Размещение при правке не
// меняется – только перемещением (10 §4.2). Серийный, прежний номер и стоимость правит Владелец (equipment.financial.edit): у Директора
// поля только для чтения, сервер всё равно отвечает 403. Дубль серийного номера – предупреждение, а не отказ (K19 §3). Паролей и кодов
// в карточке нет: поля для них не существует, комментарий – свободный текст с подписью (10 §5.3).
import { useState } from 'preact/hooks';
import { browserCall } from '../lib/api.ts';
import { errorText, type CategoryDto, type EquipmentDto, type PlaceOption } from '../lib/equipment.ts';
import { parseRub } from './OperationForm.tsx';

export interface EquipmentFormProps {
  /** Нет – постановка на учёт; есть – правка. */
  initial?: EquipmentDto;
  categories: CategoryDto[];
  branches: Array<{ id: string; name: string }>;
  defaultBranchId: string;
  roomsByBranch: Record<string, PlaceOption[]>;
  unitsByBranch: Record<string, PlaceOption[]>;
  canFinancial: boolean;
  onSaved?: (e: EquipmentDto, notice: string) => void;
  onCancel?: () => void;
}
type Saved = EquipmentDto & { details?: { duplicateOf?: string[] } };
const rubInput = (kop: number | null) => (kop === null ? '' : String(kop / 100).replace('.', ','));

export default function EquipmentForm(p: EquipmentFormProps) {
  const i = p.initial;
  const [name, setName] = useState(i?.name ?? '');
  const [categoryId, setCategoryId] = useState(i?.categoryId ?? p.categories.find((c) => c.status === 'active')?.id ?? '');
  const [branchId, setBranchId] = useState(p.defaultBranchId);
  const [roomId, setRoomId] = useState('');
  const [unitId, setUnitId] = useState('');
  const [reserve, setReserve] = useState(false);
  const [manufacturer, setManufacturer] = useState(i?.manufacturer ?? '');
  const [model, setModel] = useState(i?.model ?? '');
  const [serial, setSerial] = useState(i?.serialNumber ?? '');
  const [legacy, setLegacy] = useState(i?.legacyNumber ?? '');
  const [purchaseDate, setPurchaseDate] = useState(i?.purchaseDate ?? '');
  const [cost, setCost] = useState(rubInput(i?.purchaseCostKop ?? null));
  const [commissioned, setCommissioned] = useState(i?.commissionedOn ?? '');
  const [comment, setComment] = useState(i?.comment ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ id: string; number: string; duplicates: number } | null>(null);
  const rooms = p.roomsByBranch[branchId] ?? [];
  const units = (p.unitsByBranch[branchId] ?? []).filter((u) => !roomId || u.roomId === roomId);
  const canFin = !i || p.canFinancial;
  const inputValue = (set: (v: string) => void) => (e: Event) => set((e.currentTarget as HTMLInputElement).value);
  const orNull = (v: string) => v.trim() || null;

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    if (!name.trim()) return setError('Укажите наименование.');
    if (!categoryId) return setError('Выберите категорию.');
    const costKop = cost.trim() ? parseRub(cost) : null;
    if (cost.trim() && costKop === null) return setError('Стоимость – в рублях, например 25000 или 25000,50.');
    setBusy(true);
    setError('');
    const common = { name: name.trim(), categoryId, manufacturer: orNull(manufacturer), model: orNull(model), purchaseDate: purchaseDate || null, commissionedOn: commissioned || null, comment: orNull(comment) };
    const money = canFin ? { serialNumber: orNull(serial), legacyNumber: orNull(legacy), purchaseCostKop: costKop } : {};
    try {
      if (i) {
        const r = await browserCall<Saved>(`/equipment/${i.id}`, { method: 'PATCH', body: { rowVersion: i.rowVersion, ...common, ...money } });
        p.onSaved?.(r, r.details?.duplicateOf?.length ? 'Сохранено. Такой серийный номер уже есть у другой карточки – проверьте.' : 'Карточка сохранена.');
      } else {
        const place = reserve ? {} : { ...(roomId ? { roomId } : {}), ...(unitId ? { unitId } : {}) };
        const r = await browserCall<Saved>('/equipment', { method: 'POST', body: { branchId, status: reserve ? 'reserve' : 'in_service', ...place, ...common, ...money } });
        setCreated({ id: r.id, number: r.inventoryNumber, duplicates: r.details?.duplicateOf?.length ?? 0 });
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <section class="yc-panel" data-testid="eq-created">
        <h2>Поставлено на учёт: {created.number}</h2>
        {created.duplicates > 0 && <p class="yc-eq__warn" data-testid="eq-duplicate">Такой серийный номер уже есть у другой карточки той же модели. Сохранение не запрещено – проверьте, не задвоили ли оборудование.</p>}
        <div class="yc-eq__actions"><a class="yc-btn" href={`/equipment/${created.id}`}>Открыть карточку</a><a class="yc-btn yc-btn--ghost" href="/equipment">К списку</a></div>
      </section>
    );
  }
  return (
    <form class="yc-form yc-form--wide" novalidate onSubmit={submit} data-testid="eq-form">
      <label class="yc-field"><span class="yc-field__label">Наименование *</span><input class="yc-input" maxLength={300} value={name} onInput={inputValue(setName)} /></label>
      <label class="yc-field"><span class="yc-field__label">Категория *</span>
        <select class="yc-input" value={categoryId} onChange={inputValue(setCategoryId)}>
          {p.categories.filter((c) => c.status === 'active' || c.id === i?.categoryId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      {!i && (
        <>
          <label class="yc-field"><span class="yc-field__label">Филиал *</span>
            <select class="yc-input" value={branchId} onChange={(e) => { setBranchId((e.currentTarget as HTMLSelectElement).value); setRoomId(''); setUnitId(''); }}>
              {p.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          <label class="yc-check"><input type="checkbox" checked={reserve} onChange={(e) => setReserve((e.currentTarget as HTMLInputElement).checked)} />В резерве, на складе филиала</label>
          {!reserve && (
            <div class="yc-eq__pair">
              <label class="yc-field"><span class="yc-field__label">Комната</span>
                <select class="yc-input" value={roomId} onChange={(e) => { setRoomId((e.currentTarget as HTMLSelectElement).value); setUnitId(''); }}>
                  <option value="">Без комнаты</option>{rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </label>
              <label class="yc-field"><span class="yc-field__label">Место (единица)</span>
                <select class="yc-input" value={unitId} onChange={inputValue(setUnitId)}>
                  <option value="">Без места</option>{units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </label>
            </div>
          )}
        </>
      )}
      <div class="yc-eq__pair">
        <label class="yc-field"><span class="yc-field__label">Производитель</span><input class="yc-input" maxLength={300} value={manufacturer} onInput={inputValue(setManufacturer)} /></label>
        <label class="yc-field"><span class="yc-field__label">Модель</span><input class="yc-input" maxLength={300} value={model} onInput={inputValue(setModel)} /></label>
        <label class="yc-field"><span class="yc-field__label">Серийный номер</span><input class="yc-input" maxLength={300} readOnly={!canFin} value={serial} onInput={inputValue(setSerial)} /></label>
        <label class="yc-field"><span class="yc-field__label">Прежний номер клуба</span><input class="yc-input" maxLength={300} readOnly={!canFin} value={legacy} onInput={inputValue(setLegacy)} /></label>
        <label class="yc-field"><span class="yc-field__label">Дата покупки</span><input class="yc-input" type="date" value={purchaseDate} onInput={inputValue(setPurchaseDate)} /></label>
        <label class="yc-field"><span class="yc-field__label">Стоимость, ₽</span><input class="yc-input" inputMode="decimal" readOnly={!canFin} value={cost} onInput={inputValue(setCost)} /></label>
        <label class="yc-field"><span class="yc-field__label">Введено в работу</span><input class="yc-input" type="date" value={commissioned} onInput={inputValue(setCommissioned)} /></label>
      </div>
      {!canFin && <p class="yc-field__hint">Серийный номер, прежний номер и стоимость меняет только Владелец.</p>}
      <label class="yc-field"><span class="yc-field__label">Комментарий</span>
        <textarea class="yc-input" rows={2} maxLength={2000} value={comment} onInput={inputValue(setComment)} />
        <span class="yc-field__hint">Не пишите сюда пароли и коды доступа.</span>
      </label>
      <p class="yc-alert yc-alert--error" role="alert">{error}</p>
      <div class="yc-eq__actions">
        <button type="submit" class="yc-btn" disabled={busy}>{i ? 'Сохранить' : 'Поставить на учёт'}</button>
        {p.onCancel ? <button type="button" class="yc-btn yc-btn--ghost" onClick={p.onCancel}>Не менять</button> : <a class="yc-btn yc-btn--ghost" href="/equipment">Отмена</a>}
      </div>
    </form>
  );
}
