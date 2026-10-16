import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jidToPhone, normalizePhone, phoneKey } from '../src/phone.ts';

test('normalizePhone adiciona DDI 55 em números brasileiros', () => {
  assert.equal(normalizePhone('(11) 99999-8888'), '5511999998888');
  assert.equal(normalizePhone('11 3333-4444'), '551133334444');
  assert.equal(normalizePhone('011 99999-8888'), '5511999998888');
  assert.equal(normalizePhone('+55 11 99999-8888'), '5511999998888');
  assert.equal(normalizePhone('+1 415 555 2671'), '14155552671');
});

test('normalizePhone rejeita lixo', () => {
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone('abc'), null);
  assert.equal(normalizePhone('12345'), null);
});

test('phoneKey ignora o 9º dígito no Brasil', () => {
  assert.equal(phoneKey('5511999998888'), phoneKey('551199998888'));
  assert.notEqual(phoneKey('5511999998888'), phoneKey('5521999998888'));
  assert.equal(phoneKey('14155552671'), '14155552671');
});

test('jidToPhone só aceita JIDs de usuário', () => {
  assert.equal(jidToPhone('5511999998888@s.whatsapp.net'), '5511999998888');
  assert.equal(jidToPhone('5511999998888:12@s.whatsapp.net'), '5511999998888');
  assert.equal(jidToPhone('123456789@lid'), null);
  assert.equal(jidToPhone('1203630@g.us'), null);
  assert.equal(jidToPhone(undefined), null);
});
