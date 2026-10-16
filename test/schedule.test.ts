import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentWindowEnd, isWithinWindow, localClock, localDayKey, nextWindowStart, planSlots } from '../src/schedule.ts';

const TZ = 'America/Sao_Paulo'; // UTC-3, sem horário de verão
const weekdays = [1, 2, 3, 4, 5];

test('localClock converte para o fuso', () => {
  // 2026-10-16 é sexta-feira; 12:00 UTC = 09:00 em São Paulo
  assert.deepEqual(localClock(new Date('2026-10-16T12:00:00Z'), TZ), { weekday: 5, minutes: 9 * 60 });
});

test('respeita horário e dias da semana', () => {
  const win = { window_start: '09:00', window_end: '18:00', weekdays };
  assert.equal(isWithinWindow(win, new Date('2026-10-16T12:00:00Z'), TZ), true); // sex 09:00
  assert.equal(isWithinWindow(win, new Date('2026-10-16T11:59:00Z'), TZ), false); // sex 08:59
  assert.equal(isWithinWindow(win, new Date('2026-10-16T21:00:00Z'), TZ), false); // sex 18:00
  assert.equal(isWithinWindow(win, new Date('2026-10-17T15:00:00Z'), TZ), false); // sábado
});

test('janela que atravessa a meia-noite', () => {
  const win = { window_start: '22:00', window_end: '02:00', weekdays: [0, 1, 2, 3, 4, 5, 6] };
  assert.equal(isWithinWindow(win, new Date('2026-10-17T02:00:00Z'), TZ), true); // 23:00
  assert.equal(isWithinWindow(win, new Date('2026-10-17T06:00:00Z'), TZ), false); // 03:00
});

test('nextWindowStart encontra a próxima abertura da janela', () => {
  const win = { window_start: '09:10', window_end: '10:00', weekdays };
  // sex 14:08 em SP → próxima abertura seg 19/10 09:10 (12:10 UTC)
  assert.equal(nextWindowStart(win, new Date('2026-10-16T17:08:00Z'), TZ)?.toISOString(), '2026-10-19T12:10:00.000Z');
  // sex 08:00 → mesmo dia 09:10
  assert.equal(nextWindowStart(win, new Date('2026-10-16T11:00:00Z'), TZ)?.toISOString(), '2026-10-16T12:10:00.000Z');
  // dentro da janela → agora
  const now = new Date('2026-10-16T12:30:00Z');
  assert.equal(nextWindowStart(win, now, TZ), now);
  assert.equal(nextWindowStart({ ...win, weekdays: [] }, now, TZ), null);
});

test('currentWindowEnd e localDayKey no fuso', () => {
  const win = { window_start: '10:00', window_end: '19:00', weekdays };
  // sex 11:10:46 em SP → janela fecha 19:00 (22:00 UTC)
  assert.equal(currentWindowEnd(win, new Date('2026-10-16T14:10:46Z'), TZ).toISOString(), '2026-10-16T22:00:00.000Z');
  // 23:30 UTC de sexta ainda é sexta em SP
  assert.equal(localDayKey(new Date('2026-10-16T23:30:00Z'), TZ), '2026-10-16');
  const night = { window_start: '22:00', window_end: '02:00', weekdays: [0, 1, 2, 3, 4, 5, 6] };
  assert.equal(currentWindowEnd(night, new Date('2026-10-17T02:00:00Z'), TZ).toISOString(), '2026-10-17T05:00:00.000Z');
});

test('planSlots sorteia horários ordenados dentro do intervalo e respeita o espaçamento', () => {
  const from = 0;
  const to = 9 * 3600_000; // janela de 9 h
  const seq = [0.9, 0.1, 0.5];
  let i = 0;
  const slots = planSlots(from, to, 3, 60_000, () => seq[i++]);
  assert.deepEqual(slots, [0.1 * to, 0.5 * to, 0.9 * to].map(Math.round));

  const tight = planSlots(from, 120_000, 5, 60_000, () => 0);
  assert.deepEqual(tight, [0, 60_000], 'horários que estourariam a janela são descartados');

  assert.deepEqual(planSlots(from, to, 0, 60_000), []);
  for (let n = 0; n < 50; n++) {
    const s = planSlots(from, to, 20, 60_000);
    assert.ok(s.every((t, k) => t >= from && t < to && (k === 0 || t - s[k - 1] >= 60_000)));
  }
});
