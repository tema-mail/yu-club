import { describe, expect, it } from 'vitest';
import { AppError } from '../../apps/api/src/core/errors.ts';
import {
  addDays,
  assertSlotAligned,
  bookingWindow,
  branchDay,
  contains,
  durationMinutes,
  fixedClock,
  formatLocal,
  fromPgRange,
  hoursToInterval,
  instantToLocal,
  interval,
  isDateInWindow,
  isValidTimeZone,
  localToInstant,
  overlaps,
  parseLocalDate,
  parseLocalTime,
  reminderBeforeStart,
  reminderDayBefore,
  splitIntoSlots,
  systemClock,
  todayIn,
  toPgRange,
  type Interval,
  type LocalDate,
  type LocalTime,
  type TimeZone,
} from '../../apps/api/src/core/time.ts';

const MSK = 'Europe/Moscow' as TimeZone;
const NSK = 'Asia/Novosibirsk' as TimeZone;
const KGD = 'Europe/Kaliningrad' as TimeZone;
const BER = 'Europe/Berlin' as TimeZone; // тестовая зона с переходом на летнее время

const d = (s: string) => s as LocalDate;
const t = (s: string) => s as LocalTime;
const utc = (s: string) => new Date(s);
const iv = (a: string, b: string): Interval => interval(utc(a), utc(b));
/** Интервал по местному времени филиала; конец – той же датой или toDate. */
const localIv = (date: string, from: string, to: string, tz: TimeZone, toDate = date): Interval =>
  interval(localToInstant(d(date), t(from), tz), localToInstant(d(toDate), t(to), tz));

function reasonOf(fn: () => void): unknown {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError && e.code === 'INVALID_DURATION') return e.details?.reason;
    throw e;
  }
  return 'ok';
}

describe('разбор и проверка', () => {
  it('parseLocalDate: верная дата проходит, неверная – VALIDATION_FAILED', () => {
    expect(parseLocalDate('2026-11-15')).toBe('2026-11-15');
    expect(parseLocalDate('2028-02-29')).toBe('2028-02-29');
    for (const bad of ['2026-02-30', '2026-13-01', '2026-1-1', '15.11.2026', '', '2026-11-15T00:00']) {
      expect(() => parseLocalDate(bad), bad).toThrow(AppError);
    }
    try {
      parseLocalDate('2027-02-29');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('VALIDATION_FAILED');
      expect((e as AppError).httpStatus).toBe(400);
    }
  });

  it('parseLocalTime: HH:mm в пределах суток', () => {
    expect(parseLocalTime('00:00')).toBe('00:00');
    expect(parseLocalTime('23:59')).toBe('23:59');
    for (const bad of ['24:00', '9:00', '12:60', '12:00:00', '']) {
      expect(() => parseLocalTime(bad), bad).toThrow(AppError);
    }
  });

  it('isValidTimeZone', () => {
    expect(isValidTimeZone('Europe/Moscow')).toBe(true);
    expect(isValidTimeZone('Asia/Novosibirsk')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('interval: start >= end – ошибка', () => {
    expect(() => iv('2026-11-15T10:00:00Z', '2026-11-15T10:00:00Z')).toThrow();
    expect(() => iv('2026-11-15T11:00:00Z', '2026-11-15T10:00:00Z')).toThrow();
  });
});

describe('перевод по зонам РФ', () => {
  const cases: Array<[TimeZone, string, string]> = [
    [MSK, '2026-11-15 14:00', '2026-11-15T11:00:00.000Z'],
    [NSK, '2026-11-15 14:00', '2026-11-15T07:00:00.000Z'],
    [KGD, '2026-11-15 14:00', '2026-11-15T12:00:00.000Z'],
    [NSK, '2026-11-15 00:30', '2026-11-14T17:30:00.000Z'],
  ];
  it.each(cases)('%s %s → %s', (tz, local, expected) => {
    const [date, time] = local.split(' ') as [string, string];
    const at = localToInstant(d(date), t(time), tz);
    expect(at.toISOString()).toBe(expected);
    expect(instantToLocal(at, tz)).toMatchObject({ date, time });
  });

  it('Новосибирск = Москва + 4 часа', () => {
    const at = utc('2026-11-15T10:00:00Z');
    expect(instantToLocal(at, MSK).time).toBe('13:00');
    expect(instantToLocal(at, NSK).time).toBe('17:00');
  });

  it('один момент – разные даты в разных филиалах; день недели ISO', () => {
    const at = utc('2026-11-15T19:30:00Z'); // вс 22:30 МСК, пн 02:30 НСК
    expect(instantToLocal(at, MSK)).toEqual({ date: '2026-11-15', time: '22:30', weekday: 7 });
    expect(instantToLocal(at, NSK)).toEqual({ date: '2026-11-16', time: '02:30', weekday: 1 });
    expect(instantToLocal(at, KGD)).toEqual({ date: '2026-11-15', time: '21:30', weekday: 7 });
  });

  it('todayIn и addDays', () => {
    const clock = fixedClock('2026-11-15T18:00:00Z');
    expect(todayIn(clock, MSK)).toBe('2026-11-15');
    expect(todayIn(clock, NSK)).toBe('2026-11-16');
    expect(addDays(d('2026-12-31'), 1)).toBe('2027-01-01');
    expect(addDays(d('2026-03-01'), -1)).toBe('2026-02-28');
  });

  it('сутки в зонах РФ – ровно 24 часа', () => {
    for (const tz of [MSK, NSK, KGD]) expect(durationMinutes(branchDay(d('2026-03-29'), tz))).toBe(24 * 60);
    expect(branchDay(d('2026-11-15'), NSK)).toEqual(iv('2026-11-14T17:00:00Z', '2026-11-15T17:00:00Z'));
  });
});

describe('зона с переходом на летнее время (Europe/Berlin)', () => {
  it('29.03.2026 02:30 не существует – сдвиг вперёд (compatible)', () => {
    expect(localToInstant(d('2026-03-29'), t('02:30'), BER).toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(instantToLocal(utc('2026-03-29T01:30:00Z'), BER).time).toBe('03:30');
  });

  it('25.10.2026 02:30 дважды – берётся раньшее', () => {
    expect(localToInstant(d('2026-10-25'), t('02:30'), BER).toISOString()).toBe('2026-10-25T00:30:00.000Z');
    expect(instantToLocal(utc('2026-10-25T01:30:00Z'), BER).time).toBe('02:30'); // второе 02:30
  });

  it('branchDay в день перехода – 23 и 25 часов', () => {
    expect(durationMinutes(branchDay(d('2026-03-29'), BER))).toBe(23 * 60);
    expect(durationMinutes(branchDay(d('2026-10-25'), BER))).toBe(25 * 60);
    expect(durationMinutes(branchDay(d('2026-10-26'), BER))).toBe(24 * 60);
  });

  it('часы работы 10:00–22:00 в день перехода – 12 ч по стене, по UTC тоже 12', () => {
    expect(durationMinutes(hoursToInterval(d('2026-03-29'), t('10:00'), t('22:00'), BER))).toBe(12 * 60);
    expect(durationMinutes(hoursToInterval(d('2026-03-29'), t('01:00'), t('04:00'), BER))).toBe(2 * 60);
  });
});

describe('полуоткрытые интервалы [начало, конец)', () => {
  const a = iv('2026-11-15T14:00:00Z', '2026-11-15T14:30:00Z');
  it('соседние слоты не пересекаются', () => {
    const b = iv('2026-11-15T14:30:00Z', '2026-11-15T15:00:00Z');
    expect(overlaps(a, b)).toBe(false);
    expect(overlaps(b, a)).toBe(false);
  });
  it('[14:00,14:30) и [14:15,15:15) пересекаются', () => {
    const b = iv('2026-11-15T14:15:00Z', '2026-11-15T15:15:00Z');
    expect(overlaps(a, b)).toBe(true);
    expect(overlaps(b, a)).toBe(true);
  });
  it('contains: границы включительно с начала, конец открыт', () => {
    const day = iv('2026-11-15T00:00:00Z', '2026-11-16T00:00:00Z');
    expect(contains(day, a)).toBe(true);
    expect(contains(day, day)).toBe(true);
    expect(contains(a, day)).toBe(false);
  });
  it('durationMinutes', () => expect(durationMinutes(a)).toBe(30));
});

describe('Postgres tstzrange', () => {
  it('toPgRange → формат [)', () => {
    expect(toPgRange(iv('2026-11-15T07:00:00Z', '2026-11-15T07:30:00Z'))).toBe(
      '[2026-11-15 07:00:00+00,2026-11-15 07:30:00+00)',
    );
    expect(toPgRange(iv('2026-11-15T07:00:00.250Z', '2026-11-15T07:30:00Z'))).toBe(
      '[2026-11-15 07:00:00.250+00,2026-11-15 07:30:00+00)',
    );
  });
  it('fromPgRange: свой формат, кавычки и смещение сессии', () => {
    const exp = iv('2026-11-15T07:00:00Z', '2026-11-15T07:30:00Z');
    expect(fromPgRange('[2026-11-15 07:00:00+00,2026-11-15 07:30:00+00)')).toEqual(exp);
    expect(fromPgRange('["2026-11-15 10:00:00+03","2026-11-15 10:30:00+03")')).toEqual(exp);
    expect(fromPgRange('["2026-11-15 12:30:00+05:30","2026-11-15 13:00:00+05:30")')).toEqual(exp);
    const round = iv('2026-11-15T07:00:00.123Z', '2026-11-15T08:00:00Z');
    expect(fromPgRange(toPgRange(round))).toEqual(round);
  });
  it('fromPgRange: не [) или бесконечность – ошибка', () => {
    for (const bad of [
      '(2026-11-15 07:00:00+00,2026-11-15 07:30:00+00)',
      '[2026-11-15 07:00:00+00,2026-11-15 07:30:00+00]',
      '[2026-11-15 07:00:00+00,)',
      '[2026-11-15 07:00:00+00,infinity)',
      '[-infinity,2026-11-15 07:30:00+00)',
      'empty',
      '[2026-11-15 07:30:00+00,2026-11-15 07:00:00+00)',
    ]) {
      expect(() => fromPgRange(bad), bad).toThrow();
    }
  });
});

describe('окно записи', () => {
  it('bookingWindow(days=7) 01.11 → [01.11, 08.11)', () => {
    const clock = fixedClock('2026-11-01T09:00:00Z');
    expect(bookingWindow(clock, MSK, 7)).toEqual({ from: '2026-11-01', toExclusive: '2026-11-08' });
    expect(isDateInWindow(d('2026-11-01'), clock, MSK, 7)).toBe(true);
    expect(isDateInWindow(d('2026-11-07'), clock, MSK, 7)).toBe(true);
    expect(isDateInWindow(d('2026-11-08'), clock, MSK, 7)).toBe(false);
    expect(isDateInWindow(d('2026-10-31'), clock, MSK, 7)).toBe(false);
  });
  it('«сегодня» у филиалов разное: 31.10 20:00Z – в НСК уже 01.11', () => {
    const clock = fixedClock('2026-10-31T20:00:00Z');
    expect(bookingWindow(clock, MSK, 7).from).toBe('2026-10-31');
    expect(bookingWindow(clock, NSK, 7)).toEqual({ from: '2026-11-01', toExclusive: '2026-11-08' });
    expect(bookingWindow(clock, KGD, 30)).toEqual({ from: '2026-10-31', toExclusive: '2026-11-30' });
  });
  it('fixedClock двигается, systemClock – текущее время', () => {
    const clock = fixedClock(utc('2026-11-01T20:59:00Z'));
    clock.advance(60_000);
    expect(clock.now().toISOString()).toBe('2026-11-01T21:00:00.000Z');
    clock.set('2026-11-02T00:00:00Z');
    expect(clock.now().toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(Math.abs(systemClock.now().getTime() - Date.now())).toBeLessThan(1000);
  });
});

describe('выравнивание слотов', () => {
  it('VR 14:10–14:25 → misaligned', () => {
    expect(reasonOf(() => assertSlotAligned(localIv('2026-11-15', '14:10', '14:25', NSK), 15, NSK))).toBe('misaligned');
  });
  it('ПК 14:00–14:15 → too_short', () => {
    expect(reasonOf(() => assertSlotAligned(localIv('2026-11-15', '14:00', '14:15', NSK), 30, NSK))).toBe('too_short');
  });
  it('21:30–00:30 → crosses_midnight', () => {
    expect(reasonOf(() => assertSlotAligned(localIv('2026-11-15', '21:30', '00:30', MSK, '2026-11-16'), 30, MSK))).toBe(
      'crosses_midnight',
    );
  });
  it('ПК 14:00–15:15 → not_multiple', () => {
    expect(reasonOf(() => assertSlotAligned(localIv('2026-11-15', '14:00', '15:15', NSK), 30, NSK))).toBe('not_multiple');
  });
  it('пустой интервал → empty', () => {
    const at = utc('2026-11-15T07:00:00Z');
    expect(reasonOf(() => assertSlotAligned({ start: at, end: at }, 30, NSK))).toBe('empty');
  });
  it('верные слоты проходят, в том числе до полуночи ровно', () => {
    for (const tz of [MSK, NSK, KGD]) {
      expect(reasonOf(() => assertSlotAligned(localIv('2026-11-15', '14:00', '15:00', tz), 30, tz))).toBe('ok');
      expect(reasonOf(() => assertSlotAligned(localIv('2026-11-15', '23:30', '00:00', tz, '2026-11-16'), 30, tz))).toBe('ok');
      expect(reasonOf(() => assertSlotAligned(localIv('2026-11-15', '14:15', '14:45', tz), 15, tz))).toBe('ok');
    }
  });
  it('выравнивание – от локальной полуночи филиала, не от UTC', () => {
    const IST = 'Asia/Kolkata' as TimeZone; // +05:30: местный час не совпадает с часом UTC
    expect(reasonOf(() => assertSlotAligned(localIv('2026-11-15', '14:00', '15:00', IST), 60, IST))).toBe('ok'); // 08:30Z
    expect(reasonOf(() => assertSlotAligned(localIv('2026-11-15', '14:30', '15:30', IST), 60, IST))).toBe('misaligned'); // 09:00Z
  });
  it('splitIntoSlots', () => {
    const slots = splitIntoSlots(iv('2026-11-15T07:00:00Z', '2026-11-15T08:30:00Z'), 30);
    expect(slots.map(toPgRange)).toEqual([
      '[2026-11-15 07:00:00+00,2026-11-15 07:30:00+00)',
      '[2026-11-15 07:30:00+00,2026-11-15 08:00:00+00)',
      '[2026-11-15 08:00:00+00,2026-11-15 08:30:00+00)',
    ]);
    expect(reasonOf(() => splitIntoSlots(iv('2026-11-15T07:00:00Z', '2026-11-15T07:45:00Z'), 30))).toBe('not_multiple');
  });
  it('hoursToInterval: 10:00–22:00 НСК', () => {
    expect(hoursToInterval(d('2026-11-15'), t('10:00'), t('22:00'), NSK)).toEqual(
      iv('2026-11-15T03:00:00Z', '2026-11-15T15:00:00Z'),
    );
    expect(() => hoursToInterval(d('2026-11-15'), t('22:00'), t('10:00'), NSK)).toThrow();
  });
  it('hoursToInterval: close 24:00 – конец суток (00:00 следующей даты), в том числе в день перехода', () => {
    expect(hoursToInterval(d('2026-11-15'), t('10:00'), '24:00', NSK)).toEqual(iv('2026-11-15T03:00:00Z', '2026-11-15T17:00:00Z'));
    expect(durationMinutes(hoursToInterval(d('2026-10-25'), t('00:00'), '24:00', BER))).toBe(25 * 60);
  });
});

describe('напоминания', () => {
  const session = localToInstant(d('2026-11-15'), t('10:00'), NSK);
  it('сеанс 15.11 10:00 НСК, бронь 14.11 12:00 → 14.11 21:00 НСК = 14:00Z', () => {
    const created = localToInstant(d('2026-11-14'), t('12:00'), NSK);
    expect(reminderDayBefore(session, NSK, t('21:00'), created)?.toISOString()).toBe('2026-11-14T14:00:00.000Z');
  });
  it('бронь 14.11 21:30 → null; ровно в 21:00 → null', () => {
    expect(reminderDayBefore(session, NSK, t('21:00'), localToInstant(d('2026-11-14'), t('21:30'), NSK))).toBeNull();
    expect(reminderDayBefore(session, NSK, t('21:00'), localToInstant(d('2026-11-14'), t('21:00'), NSK))).toBeNull();
  });
  it('бронь в день сеанса → null', () => {
    expect(reminderDayBefore(session, NSK, t('21:00'), localToInstant(d('2026-11-15'), t('08:00'), NSK))).toBeNull();
  });
  it('сеанс 15.11 00:30 → 14.11 21:00 (менее суток – всё равно шлём, правило 5 K8)', () => {
    const early = localToInstant(d('2026-11-15'), t('00:30'), NSK);
    const created = localToInstant(d('2026-11-14'), t('20:00'), NSK);
    expect(reminderDayBefore(early, NSK, t('21:00'), created)?.toISOString()).toBe('2026-11-14T14:00:00.000Z');
  });
  it('«накануне» – по зоне филиала, не по UTC', () => {
    // 15.11 00:30 НСК = 14.11 17:30Z: по UTC «накануне» было бы 13.11, по филиалу – 14.11.
    const early = localToInstant(d('2026-11-15'), t('00:30'), NSK);
    const r = reminderDayBefore(early, NSK, t('21:00'), utc('2026-11-01T00:00:00Z'));
    expect(r && instantToLocal(r, NSK)).toMatchObject({ date: '2026-11-14', time: '21:00' });
    const msk = reminderDayBefore(localToInstant(d('2026-11-15'), t('10:00'), MSK), MSK, t('21:00'), utc('2026-11-01T00:00:00Z'));
    expect(msk?.toISOString()).toBe('2026-11-14T18:00:00.000Z');
    const kgd = reminderDayBefore(localToInstant(d('2026-11-15'), t('10:00'), KGD), KGD, t('21:00'), utc('2026-11-01T00:00:00Z'));
    expect(kgd?.toISOString()).toBe('2026-11-14T19:00:00.000Z');
  });
  it('reminderBeforeStart: за 15 мин; бронь за 10 мин до начала → null', () => {
    const created = new Date(session.getTime() - 60 * 60_000);
    expect(reminderBeforeStart(session, 15, created)?.toISOString()).toBe('2026-11-15T02:45:00.000Z');
    expect(reminderBeforeStart(session, 15, new Date(session.getTime() - 10 * 60_000))).toBeNull();
    expect(reminderBeforeStart(session, 15, new Date(session.getTime() - 15 * 60_000))).toBeNull();
  });
});

describe('показ', () => {
  it('formatLocal в зоне филиала', () => {
    const at = utc('2026-11-15T07:00:00Z');
    expect(formatLocal(at, NSK, 'datetime')).toBe('15 ноября, 14:00');
    expect(formatLocal(at, MSK, 'datetime')).toBe('15 ноября, 10:00');
    expect(formatLocal(at, KGD, 'time')).toBe('09:00');
    expect(formatLocal(utc('2026-11-15T19:30:00Z'), NSK, 'date')).toBe('16 ноября');
  });
});
