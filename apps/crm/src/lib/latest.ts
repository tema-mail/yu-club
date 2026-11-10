// Ответ сервера, который пришёл после более нового запроса того же экрана, не должен подменять свежие данные: смена периода, фильтра, дня или
// года запускает новый запрос, а старый ещё в пути (docs/OTCHET-dlya-programmistov.md §10). Страж tests/core/islands-late-response.test.ts.
import { useRef } from 'preact/hooks';

/**
 * Счётчик «последнего запроса». Перед запросом: `const fresh = latest();`, после ответа: `if (!fresh()) return;`.
 * fresh() – false, если с тех пор начат новый запрос этим же latest().
 */
export function useLatest(): () => () => boolean {
  const n = useRef(0);
  return () => {
    const mine = ++n.current;
    return () => mine === n.current;
  };
}
