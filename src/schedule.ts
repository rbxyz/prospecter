export interface SendWindow {
  window_start: string; // "HH:MM"
  window_end: string; // "HH:MM"
  weekdays: number[]; // 0 = domingo ... 6 = sábado
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Dia da semana e minutos desde a meia-noite no fuso informado. */
export function localClock(date: Date, timeZone: string): { weekday: number; minutes: number } {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(timeZone, fmt);
  }
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return { weekday: WEEKDAYS[parts.weekday] ?? 0, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** Indica se o horário está dentro da janela de envio. Janela que vira a noite (22:00–06:00) é suportada. */
export function isWithinWindow(win: SendWindow, date: Date, timeZone: string): boolean {
  const { weekday, minutes } = localClock(date, timeZone);
  if (!win.weekdays.includes(weekday)) return false;
  const start = toMinutes(win.window_start);
  const end = toMinutes(win.window_end);
  if (start === end) return true;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** Próximo instante (a partir de `date`) em que a janela abre; null se nenhum dia da semana estiver marcado. */
export function nextWindowStart(win: SendWindow, date: Date, timeZone: string): Date | null {
  if (isWithinWindow(win, date, timeZone)) return date;
  if (win.weekdays.length === 0) return null;
  const minute = 60_000;
  const start = Math.ceil(date.getTime() / minute) * minute;
  // Avança de 15 em 15 minutos e refina minuto a minuto (cobre janelas como 09:10).
  for (let t = start; t <= start + 8 * 24 * 60 * minute; t += 15 * minute) {
    if (!isWithinWindow(win, new Date(t), timeZone)) continue;
    let exact = t;
    while (exact - minute >= start && isWithinWindow(win, new Date(exact - minute), timeZone)) exact -= minute;
    return new Date(exact);
  }
  return null;
}

/** Data local (AAAA-MM-DD) no fuso, para separar os planos de envio por dia. */
export function localDayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** Instante em que a janela atual fecha. Supõe que `date` está dentro da janela. */
export function currentWindowEnd(win: SendWindow, date: Date, timeZone: string): Date {
  const { minutes } = localClock(date, timeZone);
  const end = toMinutes(win.window_end);
  const left = (end - minutes + 1440) % 1440 || 1440;
  const startOfMinute = Math.floor(date.getTime() / 60_000) * 60_000;
  return new Date(startOfMinute + left * 60_000);
}

/**
 * Sorteia `count` horários entre `from` e `to` (epoch ms), em ordem, com pelo menos `minGapMs`
 * entre eles. Horários que passariam de `to` por causa do intervalo mínimo são descartados.
 */
export function planSlots(from: number, to: number, count: number, minGapMs: number, random: () => number = Math.random): number[] {
  if (count <= 0 || to <= from) return [];
  const slots = Array.from({ length: count }, () => from + random() * (to - from)).sort((a, b) => a - b);
  for (let i = 1; i < slots.length; i++) slots[i] = Math.max(slots[i], slots[i - 1] + minGapMs);
  return slots.filter((t) => t < to).map(Math.round);
}

export function randomBetween(min: number, max: number, random: () => number = Math.random): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + random() * (hi - lo);
}
