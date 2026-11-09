// График отчёта (S4-91; 14 §15): SVG без библиотеки. Точные значения и период – по наведению, фокусу с клавиатуры и касанию
// (касание не открывает записи сразу: сначала значения, переход – отдельной кнопкой). Цвет ряда всегда подписан текстом в легенде
// и в подсказке; рядом – таблица с теми же числами: график не заменяет таблицу.
import { useState } from 'preact/hooks';
import { fmtValue, type MetricUnit } from '../lib/reports.ts';

export interface ChartSeries { key: string; label: string; color: string; colorName: string; values: number[] }
export interface ReportChartProps {
  title: string;
  buckets: Array<{ key: string; label: string; period: string }>;
  series: ChartSeries[];
  unit: MetricUnit;
  /** Переход к записям сегмента; нет – кнопки нет. */
  onPick?: (bucket: string, label: string) => void;
  pickLabel?: string;
}

const H = 160;
const GAP = 6;

export default function ReportChart({ title, buckets, series, unit, onPick, pickLabel = 'Показать записи' }: ReportChartProps) {
  const [active, setActive] = useState<number | null>(null);
  /** Выбранный касанием, щелчком или с клавиатуры столбец остаётся показанным, когда мышь уходит к кнопке. */
  const [pinned, setPinned] = useState<number | null>(null);
  const pin = (i: number) => { setActive(i); setPinned(i); };
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const barW = 10;
  const groupW = series.length * barW + GAP;
  const width = Math.max(groupW * buckets.length, 1);
  const at = active === null ? null : buckets[active];

  return (
    <figure class="rp-chart" data-testid="chart" style="margin:0;display:grid;gap:var(--yc-sp-2xs);min-width:0">
      <figcaption style="font-weight:600">{title}</figcaption>
      <ul class="rp-chart__legend" data-testid="legend" style="list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:var(--yc-sp-s);font-size:var(--yc-fs-xs)">
        {series.map((s) => (
          <li key={s.key} style="display:flex;align-items:center;gap:var(--yc-sp-3xs)">
            <svg width="12" height="12" aria-hidden="true"><rect width="12" height="12" rx="2" fill={s.color} /></svg>
            {s.colorName} – {s.label}
          </li>
        ))}
      </ul>
      <svg viewBox={`0 0 ${width} ${H}`} preserveAspectRatio="none" width="100%" height={H} role="group" aria-label={`${title}: столбцы по дням, значения – по наведению или касанию`}
        style="display:block;background:var(--yc-surface);border:1px solid var(--yc-line);border-radius:var(--yc-r-s)" onMouseLeave={() => setActive(pinned)}>
        {buckets.map((b, i) => (
          <g key={b.key} role="button" tabIndex={0} aria-label={`${b.period}: ${series.map((s) => `${s.label} ${fmtValue(s.values[i] ?? 0, unit)}`).join(', ')}`}
            data-testid={`bar-${b.key}`} aria-pressed={active === i} style="cursor:pointer;outline:none"
            onMouseEnter={() => setActive(i)} onFocus={() => pin(i)} onClick={() => pin(i)}
            onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && onPick) { e.preventDefault(); onPick(b.key, b.period); } }}>
            <rect x={i * groupW} y={0} width={groupW} height={H} fill={active === i ? 'var(--yc-accent-bg)' : 'transparent'} />
            {series.map((s, j) => {
              const v = s.values[i] ?? 0;
              const h = Math.round((v / max) * (H - 8));
              return <rect key={s.key} x={i * groupW + GAP / 2 + j * barW} y={H - h} width={barW - 1} height={h} fill={s.color} />;
            })}
          </g>
        ))}
      </svg>
      <div class="rp-chart__tip" role="status" aria-live="polite" data-testid="chart-tip" style="min-height:2.5rem;font-size:var(--yc-fs-s)">
        {at ? (
          <span style="display:flex;flex-wrap:wrap;gap:var(--yc-sp-2xs) var(--yc-sp-s);align-items:center">
            <strong>{at.period}</strong>
            {series.map((s) => <span key={s.key}>{s.colorName} – {s.label}: {fmtValue(s.values[active!] ?? 0, unit)}</span>)}
            {onPick && <button class="yc-btn yc-btn--ghost" type="button" onClick={() => onPick(at.key, at.period)}>{pickLabel}</button>}
          </span>
        ) : <span style="color:var(--yc-muted)">Наведите или нажмите на столбец – покажем точные значения.</span>}
      </div>
      <details>
        <summary>Таблица графика</summary>
        <div class="rp-scroll">
          <table class="rp-table" data-testid="chart-table">
            <thead><tr><th scope="col">Период</th>{series.map((s) => <th scope="col" key={s.key}>{s.label}</th>)}</tr></thead>
            <tbody>{buckets.map((b, i) => <tr key={b.key}><th scope="row">{b.period}</th>{series.map((s) => <td key={s.key}>{fmtValue(s.values[i] ?? 0, unit)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
