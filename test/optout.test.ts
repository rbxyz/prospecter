import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isOptOut } from '../src/optout.ts';

const keywords = ['sair', 'parar', 'pare', 'stop', 'cancelar', 'descadastrar', 'remover'];

test('reconhece pedidos curtos de descadastro', () => {
  for (const text of ['SAIR', 'Sair.', 'pare por favor', 'Quero descadastrar', 'STOP!!', 'pode remover meu número']) {
    assert.equal(isOptOut(text, keywords), true, text);
  }
});

test('não confunde mensagens normais', () => {
  for (const text of ['Oi, tudo bem?', 'Tenho interesse, me liga amanhã', '', 'não quero sair perdendo essa oportunidade, me manda o preço']) {
    assert.equal(isOptOut(text, keywords), false, text);
  }
});
