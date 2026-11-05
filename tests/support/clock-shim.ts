// Сдвиг «сейчас» для e2e: Date идёт как обычно, но от другого момента. Функция самодостаточна: её же получает браузер (addInitScript), замыканий в ней нет.
export function shiftDate(offsetMs: number): void {
  const g = globalThis as unknown as { Date: DateConstructor; __e2eClockShifted?: boolean };
  if (g.__e2eClockShifted) return;
  g.__e2eClockShifted = true;
  const Real = g.Date;
  const now = () => Real.now() + offsetMs;
  g.Date = new Proxy(Real, {
    construct: (target, args, newTarget) => Reflect.construct(target, args.length === 0 ? [now()] : args, newTarget) as object,
    apply: () => new Real(now()).toString(),
    get: (target, key) => (key === 'now' ? now : Reflect.get(target, key) as unknown),
  });
}
