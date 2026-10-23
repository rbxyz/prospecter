import assert from 'node:assert/strict';
import { test } from 'node:test';
import { phoneKey } from '../src/phone.ts';
import { lidPhoneMap, toWaContacts, toWaMessage, type EvoMessage } from '../src/wa-map.ts';

const lidReply: EvoMessage = {
  key: {
    id: 'AC88F723',
    fromMe: false,
    remoteJid: '160095090512042@lid',
    remoteJidAlt: '555197868713@s.whatsapp.net',
  },
  pushName: 'Tiago Andregieski',
  messageType: 'conversation',
  message: { conversation: 'O que seria?', messageContextInfo: {} },
  messageTimestamp: 1792161050,
};

test('toWaMessage usa o número real de mensagens @lid', () => {
  const row = toWaMessage(lidReply)!;
  assert.equal(row.wa_id, 'AC88F723');
  assert.equal(row.jid, '160095090512042@lid');
  assert.equal(row.phone, '555197868713');
  assert.equal(row.phone_key, phoneKey('555197868713'));
  assert.equal(row.from_me, false);
  assert.equal(row.text, 'O que seria?');
  assert.equal(row.push_name, 'Tiago Andregieski');
  assert.deepEqual(row.sent_at, new Date(1792161050 * 1000));
});

test('toWaMessage não guarda o nosso próprio nome nas mensagens enviadas', () => {
  const row = toWaMessage({
    key: { id: 'X1', fromMe: true, remoteJid: '5551999990000@s.whatsapp.net' },
    pushName: 'Ruan Bueno | Allpines',
    messageType: 'audioMessage',
    message: { audioMessage: {} },
    messageTimestamp: '1792161050',
  })!;
  assert.equal(row.push_name, null);
  assert.equal(row.text, null, 'áudio não tem texto');
  assert.equal(row.type, 'audioMessage');
  assert.equal(row.phone, '5551999990000');
});

test('toWaMessage descarta status e mensagens sem id; grupos ficam sem telefone', () => {
  assert.equal(toWaMessage({ key: { id: 'S', remoteJid: 'status@broadcast' } }), null);
  assert.equal(toWaMessage({ key: { remoteJid: '5551999990000@s.whatsapp.net' } }), null);
  const group = toWaMessage({ key: { id: 'G', remoteJid: '120363408327426623@g.us', senderPn: '5551999990000@s.whatsapp.net' } })!;
  assert.equal(group.phone, null);
});

test('lidPhoneMap e toWaContacts resolvem o número dos contatos @lid', () => {
  const lids = lidPhoneMap([lidReply]);
  assert.equal(lids.get('160095090512042@lid'), '555197868713');

  const messages = [toWaMessage(lidReply, lids)!];
  const contacts = toWaContacts(
    [
      { remoteJid: '160095090512042@lid', pushName: null },
      { remoteJid: '555196614091@s.whatsapp.net', pushName: 'Mt Gestão Contábil' },
      { remoteJid: '120363408327426623@g.us', pushName: 'Grupo', isGroup: true },
    ],
    messages,
    lids,
  );
  const lid = contacts.find((c) => c.jid === '160095090512042@lid')!;
  assert.equal(lid.phone, '555197868713');
  assert.equal(lid.push_name, 'Tiago Andregieski', 'nome vem da mensagem recebida');
  assert.deepEqual(lid.last_message_at, new Date(1792161050 * 1000));

  const pn = contacts.find((c) => c.jid === '555196614091@s.whatsapp.net')!;
  assert.equal(pn.phone, '555196614091');
  assert.equal(pn.last_message_at, null);

  const group = contacts.find((c) => c.is_group)!;
  assert.equal(group.phone, null);
});

test('toWaContacts cria contato para conversa que só aparece nas mensagens', () => {
  const contacts = toWaContacts([], [toWaMessage(lidReply)!]);
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].phone, '555197868713');
});
