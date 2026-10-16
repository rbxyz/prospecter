import { varKey } from './template.ts';

/** Parser de CSV com suporte a aspas e detecção de separador (`,` ou `;`, comum no Excel BR). */
export function parseCsv(input: string): Record<string, string>[] {
  const text = input.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }

  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (nonEmpty.length === 0) return [];
  const headers = nonEmpty[0].map((h) => varKey(h));
  return nonEmpty.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    headers.forEach((h, idx) => {
      if (h) record[h] = (cells[idx] ?? '').trim();
    });
    return record;
  });
}

const PHONE_COLUMNS = ['telefone', 'phone', 'celular', 'whatsapp', 'numero', 'fone', 'tel'];
const NAME_COLUMNS = ['nome', 'name', 'contato', 'cliente'];

export interface ImportedContact {
  phoneRaw: string;
  name: string;
  vars: Record<string, string>;
}

/** Separa telefone e nome das demais colunas (que viram variáveis do template). */
export function toContacts(records: Record<string, string>[]): ImportedContact[] {
  return records.map((r) => {
    const phoneCol = PHONE_COLUMNS.find((c) => c in r);
    const nameCol = NAME_COLUMNS.find((c) => c in r);
    const vars = { ...r };
    if (phoneCol) delete vars[phoneCol];
    if (nameCol) delete vars[nameCol];
    return {
      phoneRaw: phoneCol ? r[phoneCol] : '',
      name: nameCol ? r[nameCol] : '',
      vars,
    };
  });
}

/** Aceita CSV com cabeçalho (telefone, nome, ...) ou uma lista simples com um telefone por linha. */
export function parseContactsInput(input: string): ImportedContact[] {
  const firstLine = input.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  const hasHeader = firstLine
    .split(/[;,\t]/)
    .some((cell) => PHONE_COLUMNS.includes(varKey(cell.replace(/"/g, ''))));
  if (hasHeader) return toContacts(parseCsv(input));
  return input
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [phoneRaw, ...rest] = line.split(/[;,\t]/);
      return { phoneRaw, name: rest.join(' ').trim(), vars: {} };
    });
}
