import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseContactsInput, parseCsv } from '../src/csv.ts';

test('parseCsv detecta ";" e trata aspas', () => {
  const rows = parseCsv('﻿Telefone;Nome;Empresa\r\n11999998888;"Silva; Maria";"Acme ""SA"""\r\n');
  assert.deepEqual(rows, [{ telefone: '11999998888', nome: 'Silva; Maria', empresa: 'Acme "SA"' }]);
});

test('parseCsv com vírgula e linhas em branco', () => {
  const rows = parseCsv('phone,name\n5511999998888,João\n\n21988887777,Ana\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].name, 'Ana');
});

test('parseContactsInput separa telefone/nome e mantém o resto como variáveis', () => {
  const [c] = parseContactsInput('Celular;Nome;Empresa\n11999998888;Maria;Acme');
  assert.deepEqual(c, { phoneRaw: '11999998888', name: 'Maria', vars: { empresa: 'Acme' } });
});

test('parseContactsInput aceita um telefone por linha (com nome opcional)', () => {
  const list = parseContactsInput('11999998888\n21988887777;Ana Souza\n');
  assert.deepEqual(list, [
    { phoneRaw: '11999998888', name: '', vars: {} },
    { phoneRaw: '21988887777', name: 'Ana Souza', vars: {} },
  ]);
});
