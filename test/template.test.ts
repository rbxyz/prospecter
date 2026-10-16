import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contactVars, renderChecked, renderTemplate, validateTemplate } from '../src/template.ts';

const vars = contactVars({ name: 'Maria Silva', phone: '5511999998888', vars: { Empresa: 'Acme', 'Cidade Natal': 'Santos' } });

test('substitui variáveis ignorando maiúsculas, acentos e espaços', () => {
  assert.equal(renderTemplate('Oi {{ Primeiro_Nome }}, da {{empresa}} em {{cidade natal}}', vars), 'Oi Maria, da Acme em Santos');
  assert.equal(renderTemplate('{{nome}} - {{telefone}}', vars), 'Maria Silva - 5511999998888');
});

test('variável ausente vira vazio sem deixar espaços duplos', () => {
  assert.equal(renderTemplate('Oi {{cargo}} {{primeiro_nome}}!', vars), 'Oi Maria!');
});

test('spintax escolhe uma opção, inclusive aninhada', () => {
  assert.equal(renderTemplate('{Oi|Olá} {{primeiro_nome}}', vars, () => 0), 'Oi Maria');
  assert.equal(renderTemplate('{Oi|Olá} {{primeiro_nome}}', vars, () => 0.99), 'Olá Maria');
  assert.equal(renderTemplate('{Bom {dia|ótimo dia}|E aí}', vars, () => 0), 'Bom dia');
});

test('chaves sem "|" são preservadas', () => {
  assert.equal(renderTemplate('Código {ABC}', vars), 'Código {ABC}');
});

test('validateTemplate aceita templates corretos', () => {
  assert.deepEqual(validateTemplate('{Oi|Olá} {{primeiro_nome}}, {tudo bem|como vai}?'), []);
  assert.deepEqual(validateTemplate('{Bom {dia|ótimo dia}|E aí} {{ Nome }}'), []);
});

test('validateTemplate pega marcação que sairia literal', () => {
  assert.equal(validateTemplate('Oi {{nome}').length > 0, true);
  assert.equal(validateTemplate('Oi {nome}')[0], '"{nome}" não é variável nem variação: use {{nome}} para variável ou {opção1|opção2} para variação');
  assert.equal(validateTemplate('{Oi|Olá tudo bem').length > 0, true);
  assert.equal(validateTemplate('Oi }} fim').length > 0, true);
  assert.deepEqual(validateTemplate('   '), ['A mensagem está vazia']);
});

test('renderChecked bloqueia variável vazia e sobra de marcação', () => {
  const ok = renderChecked('Oi {{primeiro_nome}}', vars);
  assert.deepEqual(ok, { text: 'Oi Maria', problems: [] });

  const empty = renderChecked('Consigo falar com {{nome}}?', contactVars({ name: '', phone: '5511999998888', vars: {} }));
  assert.deepEqual(empty.problems, ['{{nome}} vazio para este contato']);

  const typo = renderChecked('Oi {{nmoe}}', vars);
  assert.deepEqual(typo.problems, ['{{nmoe}} vazio para este contato']);

  const leftover = renderChecked('Código {ABC}', vars);
  assert.equal(leftover.problems.length, 1);
});
