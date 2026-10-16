import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePhoneList } from '../src/phone.ts';
import { prettyName } from '../src/template.ts';
import { parseToolText, prospectToContact, type WtProspect } from '../src/watchtower-map.ts';

test('parsePhoneList separa vários telefones e põe celulares primeiro', () => {
  assert.deepEqual(parsePhoneList('(51) 3714-1234 / (51) 99876-5432'), ['5551998765432', '555137141234']);
  assert.deepEqual(parsePhoneList('(51) 99764-3864 / (51) 99896-7636'), ['5551997643864', '5551998967636']);
  assert.deepEqual(parsePhoneList('(51) 9976-4386 e (51) 99764-3864'), ['5551997643864', '555199764386']);
  assert.deepEqual(parsePhoneList('(51) 99764-3864 / (51) 9764-3864'), ['5551997643864'], 'mesmo número com/sem 9º dígito');
  assert.deepEqual(parsePhoneList('sem telefone válido na Receita'), []);
  assert.deepEqual(parsePhoneList(''), []);
});

test('prettyName só mexe em nomes todos em maiúsculas', () => {
  assert.equal(prettyName('MARIA DA SILVA E SOUZA'), 'Maria da Silva e Souza');
  assert.equal(prettyName('  Lidiane de Assis  '), 'Lidiane de Assis');
  assert.equal(prettyName('DE OLIVEIRA'), 'De Oliveira');
});

const prospect: WtProspect = {
  id: 'f8fed66b-4134-4ea1-b633-057d2c5c40d5',
  nome: 'Contabil Exemplo LTDA',
  contatoNome: 'JOAO DOS SANTOS',
  email: null,
  telefone: '(51) 3714-1234 / (51) 99876-5432',
  documento: '00000000000191',
  etapaId: '915202e6-e57b-4c40-a2d1-fb9366540221',
  etapaNome: 'Novo',
  pastaNome: 'Contabilidades - Santa Cruz do Sul',
  responsavelNome: 'Fulano',
};

test('prospectToContact monta nome, variáveis e vínculo com o prospecto', () => {
  const c = prospectToContact(prospect);
  assert.equal(c.name, 'Joao dos Santos');
  assert.equal(c.wtProspectId, prospect.id);
  assert.equal(c.phonesRaw, prospect.telefone);
  assert.equal(c.vars.empresa, 'Contabil Exemplo LTDA');
  assert.equal(c.vars.cidade, 'Santa Cruz do Sul');
  assert.equal(c.vars.email, '');
});

test('prospectToContact usa a empresa quando não há contato', () => {
  const c = prospectToContact({ ...prospect, contatoNome: null, pastaNome: null });
  assert.equal(c.name, 'Contabil Exemplo LTDA');
  assert.equal(c.vars.cidade, '');
});

test('parseToolText lê o JSON do primeiro bloco e ignora avisos', () => {
  const content = [
    { type: 'text', text: '[{"id":"1"}]' },
    { type: 'text', text: 'Empresa: Allpines' },
  ];
  assert.deepEqual(parseToolText(content), [{ id: '1' }]);
  assert.equal(parseToolText([{ type: 'text', text: 'erro qualquer' }]), 'erro qualquer');
});
