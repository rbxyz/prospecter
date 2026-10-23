import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationKey, groupByClient, type ExportRow } from '../src/wa-export.ts';

const row = (over: Partial<ExportRow>): ExportRow => ({
  wa_id: 'id',
  instance: 'vendas',
  instance_phone: '5551900000000',
  jid: '5551999998888@s.whatsapp.net',
  phone: '5551999998888',
  phone_key: '555199998888',
  from_me: true,
  type: 'conversation',
  text: 'Oi',
  push_name: null,
  sent_at: new Date('2026-10-01T12:00:00Z'),
  origin: null,
  contact_id: null,
  contact_name: null,
  contact_vars: null,
  wt_prospect_id: null,
  ...over,
});

test('conversationKey usa phone_key ou instância:jid', () => {
  assert.equal(conversationKey(row({})), '555199998888');
  assert.equal(conversationKey(row({ phone_key: null, jid: '123@lid' })), 'vendas:123@lid');
});

test('groupByClient junta os números do mesmo contato e conta enviadas/recebidas', () => {
  const contact = { contact_id: '7', contact_name: 'Ana', contact_vars: { empresa: 'Contábil Ana', cidade: 'Canoas' } };
  const clients = groupByClient([
    row({ wa_id: 'a', ...contact }),
    row({
      wa_id: 'b',
      ...contact,
      from_me: false,
      push_name: 'Ana Souza',
      phone: '5551988887777',
      phone_key: '555188887777',
      instance: 'suporte',
      sent_at: '2026-10-02T09:00:00Z',
    }),
  ]);
  assert.equal(clients.length, 1);
  const [c] = clients;
  assert.equal(c.contact_id, 7);
  assert.equal(c.nome, 'Ana');
  assert.equal(c.empresa, 'Contábil Ana');
  assert.equal(c.nome_whatsapp, 'Ana Souza');
  assert.deepEqual(c.telefones, ['5551999998888', '5551988887777']);
  assert.deepEqual(c.instancias, ['vendas', 'suporte']);
  assert.equal(c.enviadas, 1);
  assert.equal(c.recebidas, 1);
  assert.equal(c.primeira_mensagem_em, '2026-10-01T12:00:00.000Z');
  assert.equal(c.ultima_mensagem_em, '2026-10-02T09:00:00.000Z');
  assert.deepEqual(
    c.mensagens.map((m) => [m.id_whatsapp, m.direcao, m.nome_whatsapp]),
    [
      ['a', 'enviada', null],
      ['b', 'recebida', 'Ana Souza'],
    ],
  );
});

test('groupByClient separa conversas sem contato e ordena pela mais recente', () => {
  const clients = groupByClient([
    row({ wa_id: 'velha', sent_at: '2026-09-01T00:00:00Z' }),
    row({ wa_id: 'nova', phone_key: null, phone: null, jid: '99@lid', sent_at: '2026-10-05T00:00:00Z' }),
    row({ wa_id: 'sem-data', sent_at: null }),
  ]);
  assert.equal(clients.length, 2);
  assert.equal(clients[0].mensagens[0].id_whatsapp, 'nova');
  assert.deepEqual(clients[0].telefones, []);
  assert.equal(clients[0].dados, null);
  assert.deepEqual(
    clients[1].mensagens.map((m) => m.id_whatsapp),
    ['sem-data', 'velha'],
  );
});
