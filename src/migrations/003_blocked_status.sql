-- "blocked": a mensagem montada para o contato falhou na validação (variável vazia ou marcação
-- de template sobrando) e não foi enviada. Pode voltar para a fila depois de corrigir os dados.
ALTER TABLE messages DROP CONSTRAINT messages_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'invalid', 'skipped', 'blocked'));
