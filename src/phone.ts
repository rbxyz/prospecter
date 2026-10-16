const DEFAULT_COUNTRY = '55';

/**
 * Normaliza um telefone digitado/importado para dígitos com DDI.
 * Com "+" ou "00" na frente, o número já traz o DDI. Sem isso, números de
 * 10 ou 11 dígitos são tratados como brasileiros e recebem o 55.
 * Retorna null quando não parece um telefone válido.
 */
export function normalizePhone(raw: string): string | null {
  const text = String(raw ?? '').trim();
  let digits = text.replace(/\D/g, '');
  if (!digits) return null;
  const international = text.startsWith('+') || digits.startsWith('00');
  if (international) {
    digits = digits.replace(/^00/, '');
  } else {
    // Remove o 0 de discagem nacional (ex.: 011 99999-8888).
    if ((digits.length === 11 || digits.length === 12) && digits.startsWith('0')) digits = digits.slice(1);
    if (digits.length === 10 || digits.length === 11) digits = DEFAULT_COUNTRY + digits;
  }
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
}

/**
 * Chave usada para casar respostas com contatos. No Brasil o WhatsApp pode
 * reportar o celular com ou sem o 9º dígito, então a chave usa DDI + DDD + últimos 8.
 */
export function phoneKey(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    return digits.slice(0, 4) + digits.slice(-8);
  }
  return digits;
}

export function isBrazilianMobile(phone: string): boolean {
  return /^55\d{2}9\d{8}$/.test(phone);
}

/**
 * Lê um campo com um ou mais telefones ("(51) 3714-1234 / (51) 99999-8888").
 * Devolve os válidos sem repetição, com celulares primeiro: o primeiro vira o telefone principal.
 */
export function parsePhoneList(raw: string): string[] {
  const seen = new Set<string>();
  const phones: string[] = [];
  for (const part of String(raw ?? '').split(/\s*(?:\/|\||;|,|\s+e\s+|\s+ou\s+)\s*/i)) {
    const phone = normalizePhone(part);
    if (!phone || seen.has(phoneKey(phone))) continue;
    seen.add(phoneKey(phone));
    phones.push(phone);
  }
  return [...phones.filter(isBrazilianMobile), ...phones.filter((p) => !isBrazilianMobile(p))];
}

/** Extrai os dígitos de um JID do WhatsApp (5511999998888@s.whatsapp.net). */
export function jidToPhone(jid: string | undefined | null): string | null {
  if (!jid || !jid.endsWith('@s.whatsapp.net')) return null;
  const digits = jid.split('@')[0].split(':')[0];
  return /^\d+$/.test(digits) ? digits : null;
}
