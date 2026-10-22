import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bodyPlaceholders,
  classifyCloudError,
  describeTemplate,
  metaTemplateProblems,
  parseCloudWebhook,
  renderCloud,
  validateCloudTemplate,
  type CloudTemplate,
  type MetaTemplate,
} from '../src/cloud-map.ts';
import { phoneKey } from '../src/phone.ts';

const positional: CloudTemplate = {
  waba_id: '111',
  name: 'prospeccao_contabil',
  language: 'pt_BR',
  body: 'Olá {{1}}, tudo bem? Vi que a {{2}} atende em {{3}}.',
  format: 'POSITIONAL',
  params: { '1': '{{primeiro_nome}}', '2': '{{empresa}}', '3': '{{cidade}}' },
};

const vars = { primeiro_nome: 'Maria', empresa: 'Contábil Silva', cidade: 'Lajeado' };

test('bodyPlaceholders ordena as variáveis posicionais e mantém a ordem das nomeadas', () => {
  assert.deepEqual(bodyPlaceholders('{{2}} e {{1}} e {{10}} e {{2}}'), ['1', '2', '10']);
  assert.deepEqual(bodyPlaceholders('{{empresa}} de {{ nome }}', 'NAMED'), ['empresa', 'nome']);
});

test('renderCloud monta o texto final e os parâmetros na ordem', () => {
  const r = renderCloud(positional, vars);
  assert.deepEqual(r.problems, []);
  assert.equal(r.text, 'Olá Maria, tudo bem? Vi que a Contábil Silva atende em Lajeado.');
  assert.deepEqual(r.parameters, [
    { type: 'text', text: 'Maria' },
    { type: 'text', text: 'Contábil Silva' },
    { type: 'text', text: 'Lajeado' },
  ]);
});

test('renderCloud usa parameter_name em templates nomeados e aceita spintax no valor', () => {
  const t: CloudTemplate = { ...positional, body: 'Oi {{nome}}!', format: 'NAMED', params: { nome: '{Dra.|Sra.} {{primeiro_nome}}' } };
  const r = renderCloud(t, vars, () => 0);
  assert.equal(r.text, 'Oi Dra. Maria!');
  assert.deepEqual(r.parameters, [{ type: 'text', parameter_name: 'nome', text: 'Dra. Maria' }]);
});

test('renderCloud bloqueia variável vazia, valor sem definição e quebra de linha', () => {
  const r = renderCloud({ ...positional, params: { '1': '{{primeiro_nome}}', '2': '{{empresa}}' } }, { ...vars, primeiro_nome: '' });
  assert.ok(r.problems.some((p) => p.includes('{{1}}') && p.includes('vazio')));
  assert.ok(r.problems.some((p) => p.includes('{{3}}') && p.includes('sem valor')));

  const multiline = renderCloud({ ...positional, params: { ...positional.params, '2': 'linha 1\nlinha 2' } }, vars);
  assert.ok(multiline.problems.some((p) => p.includes('quebra de linha')));
});

test('validateCloudTemplate exige template e valor para cada variável', () => {
  assert.deepEqual(validateCloudTemplate(null), ['Escolha um template aprovado']);
  assert.deepEqual(validateCloudTemplate(positional), []);
  const errors = validateCloudTemplate({ ...positional, params: { '1': '{{nome}', '2': 'x' } });
  assert.ok(errors.some((e) => e.startsWith('{{1}}:')), 'marcação quebrada no valor de {{1}}');
  assert.ok(errors.includes('Defina o valor de {{3}}'));
  assert.ok(!errors.some((e) => e.startsWith('{{2}}')));
});

test('metaTemplateProblems recusa mídia no cabeçalho, URL variável e template não aprovado', () => {
  const ok: MetaTemplate = {
    name: 'a',
    language: 'pt_BR',
    status: 'APPROVED',
    components: [
      { type: 'HEADER', format: 'TEXT', text: 'Allpines' },
      { type: 'BODY', text: 'Oi {{1}}' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Parar promoções' }] },
    ],
  };
  assert.deepEqual(metaTemplateProblems(ok), []);
  assert.deepEqual(describeTemplate(ok), { body: 'Oi {{1}}', format: 'POSITIONAL', placeholders: ['1'] });

  const bad: MetaTemplate = {
    ...ok,
    status: 'PAUSED',
    components: [
      { type: 'HEADER', format: 'IMAGE' },
      { type: 'BODY', text: 'Oi' },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Site', url: 'https://x.com/{{1}}' }] },
    ],
  };
  assert.equal(metaTemplateProblems(bad).length, 3);
});

test('classifyCloudError separa número inválido, limite do usuário, template e conta', () => {
  assert.equal(classifyCloudError(131026), 'invalid');
  assert.equal(classifyCloudError(131049), 'user-limit');
  assert.equal(classifyCloudError(130429), 'retry');
  assert.equal(classifyCloudError(132001), 'template');
  assert.equal(classifyCloudError(190), 'account');
  assert.equal(classifyCloudError(100), 'other');
  assert.equal(classifyCloudError(null), 'other');
});

const envelope = (field: string, value: unknown) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA1', changes: [{ field, value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550001111', phone_number_id: 'PN1' }, ...(value as object) } }] }],
});

test('parseCloudWebhook: mensagem recebida com nome do contato e status de entrega', () => {
  const events = parseCloudWebhook(
    envelope('messages', {
      contacts: [{ wa_id: '555197868713', profile: { name: 'Tiago' } }],
      messages: [{ from: '555197868713', id: 'wamid.IN1', timestamp: '1792161050', type: 'text', text: { body: 'Quero saber mais' } }],
      statuses: [{ id: 'wamid.OUT1', status: 'failed', timestamp: '1792161060', errors: [{ code: 131049, title: 'x', error_data: { details: 'limite' } }] }],
    }),
  );
  const [msg, status] = events;
  assert.equal(msg.kind, 'message');
  if (msg.kind !== 'message') return;
  assert.equal(msg.phoneNumberId, 'PN1');
  assert.equal(msg.pushName, 'Tiago');
  assert.equal(msg.row.from_me, false);
  assert.equal(msg.row.origin, 'contact');
  assert.equal(msg.row.text, 'Quero saber mais');
  assert.equal(msg.row.phone_key, phoneKey('555197868713'));
  assert.deepEqual(msg.row.sent_at, new Date(1792161050 * 1000));

  assert.equal(status.kind, 'status');
  if (status.kind !== 'status') return;
  assert.equal(status.waId, 'wamid.OUT1');
  assert.deepEqual(status.error, { code: 131049, message: 'limite' });
});

test('parseCloudWebhook: eco do celular sai como enviada pelo app', () => {
  const [e] = parseCloudWebhook(
    envelope('smb_message_echoes', {
      message_echoes: [{ from: '15550001111', to: '5551999990000', id: 'wamid.E1', timestamp: '1792161000', type: 'text', text: { body: 'Te ligo já' } }],
    }),
  );
  assert.equal(e.kind, 'echo');
  if (e.kind !== 'echo') return;
  assert.equal(e.row.from_me, true);
  assert.equal(e.row.origin, 'app');
  assert.equal(e.row.phone, '5551999990000');
  assert.equal(e.row.jid, '5551999990000@s.whatsapp.net');
});

test('parseCloudWebhook: histórico nos dois sentidos, progresso e recusa (2593109)', () => {
  const [h] = parseCloudWebhook(
    envelope('history', {
      history: [
        {
          metadata: { phase: 0, chunk_order: 1, progress: 55 },
          threads: [
            {
              id: '5551999990000',
              messages: [
                { from: '5551999990000', id: 'wamid.H1', timestamp: '1780000000', type: 'text', text: { body: 'Oi' }, history_context: { status: 'READ' } },
                { from: '15550001111', to: '5551999990000', id: 'wamid.H2', timestamp: '1780000100', type: 'image', image: { caption: 'Proposta' } },
              ],
            },
          ],
        },
      ],
    }),
  );
  assert.equal(h.kind, 'history');
  if (h.kind !== 'history') return;
  assert.equal(h.progress, 55);
  assert.equal(h.error, null);
  assert.deepEqual(h.rows.map((r) => [r.wa_id, r.from_me, r.text, r.origin]), [
    ['wamid.H1', false, 'Oi', 'history'],
    ['wamid.H2', true, 'Proposta', 'history'],
  ]);

  const [declined] = parseCloudWebhook(envelope('history', { history: [{ errors: [{ code: 2593109, message: 'History sync is turned off' }] }] }));
  assert.equal(declined.kind, 'history');
  if (declined.kind !== 'history') return;
  assert.deepEqual(declined.rows, []);
  assert.match(declined.error ?? '', /2593109/);
});

test('parseCloudWebhook: contatos do celular, desconexão, qualidade e template pausado', () => {
  const [contact] = parseCloudWebhook(
    envelope('smb_app_state_sync', {
      state_sync: [
        { type: 'contact', contact: { full_name: 'Maria Silva', first_name: 'Maria', phone_number: '5551999990000' }, action: 'add', metadata: { timestamp: '1' } },
        { type: 'contact', contact: { full_name: 'Removido', phone_number: '5551888880000' }, action: 'remove', metadata: { timestamp: '1' } },
      ],
    }),
  );
  assert.equal(contact.kind, 'contact');
  if (contact.kind === 'contact') assert.equal(contact.contact.push_name, 'Maria Silva');
  assert.equal(parseCloudWebhook(envelope('smb_app_state_sync', { state_sync: [{ type: 'contact', contact: { phone_number: '1' }, action: 'remove' }] })).length, 0);

  assert.deepEqual(parseCloudWebhook(envelope('account_update', { phone_number: '+1 555-000-1111', event: 'PARTNER_REMOVED' })), [
    { kind: 'account', wabaId: 'WABA1', event: 'PARTNER_REMOVED', phone: '15550001111' },
  ]);
  const [quality] = parseCloudWebhook(envelope('phone_number_quality_update', { display_phone_number: '15550001111', event: 'FLAGGED', current_limit: 'TIER_250' }));
  assert.equal(quality.kind === 'quality' && quality.event, 'FLAGGED');
  const [tpl] = parseCloudWebhook(
    envelope('message_template_status_update', { event: 'PAUSED', message_template_name: 'prospeccao_contabil', message_template_language: 'pt_BR', reason: 'NONE' }),
  );
  assert.deepEqual(tpl, { kind: 'template', wabaId: 'WABA1', name: 'prospeccao_contabil', language: 'pt_BR', event: 'PAUSED', reason: null });
});
