-- Espalha os envios do dia em horários sorteados dentro da janela (em vez de enviar assim que ela abre).
ALTER TABLE campaigns ADD COLUMN random_times boolean NOT NULL DEFAULT true;
