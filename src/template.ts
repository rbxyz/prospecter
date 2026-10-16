export type TemplateVars = Record<string, string>;

/** Remove acentos e padroniza para casar {{Nome}}, {{nome}}, {{NOME}}... */
export function varKey(key: string): string {
  return key
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

const NAME_PARTICLES = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);

/** "MARIA DA SILVA" → "Maria da Silva" (bases como a da Receita vêm em maiúsculas). Nomes já com minúsculas ficam como estão. */
export function prettyName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (!trimmed || trimmed !== trimmed.toUpperCase()) return trimmed;
  return trimmed
    .toLowerCase()
    .split(' ')
    .map((w, i) => (i > 0 && NAME_PARTICLES.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** Variáveis disponíveis para um contato: colunas do CSV + nome/primeiro_nome/telefone. */
export function contactVars(contact: { name: string; phone: string; vars: Record<string, unknown> }): TemplateVars {
  const vars: TemplateVars = {};
  for (const [k, v] of Object.entries(contact.vars ?? {})) vars[varKey(k)] = v == null ? '' : String(v);
  const name = prettyName(contact.name);
  vars.nome = name;
  vars.primeiro_nome = name.split(/\s+/)[0] ?? '';
  vars.telefone = contact.phone;
  return vars;
}

/**
 * Renderiza a mensagem:
 *  - {{variavel}} → valor do contato (vazio se não existir)
 *  - {Oi|Olá|E aí} → escolhe uma opção aleatória (spintax), pode ser aninhado
 */
export function renderTemplate(template: string, vars: TemplateVars, random: () => number = Math.random): string {
  let text = template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key: string) => vars[varKey(key)] ?? '');

  // Resolve do grupo mais interno para fora.
  const spin = /\{([^{}]*\|[^{}]*)\}/;
  let match: RegExpExecArray | null;
  while ((match = spin.exec(text))) {
    const options = match[1].split('|');
    const choice = options[Math.floor(random() * options.length)] ?? '';
    text = text.slice(0, match.index) + choice + text.slice(match.index + match[0].length);
  }

  return text.replace(/[ \t]+\n/g, '\n').replace(/ {2,}/g, ' ').trim();
}

const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Variáveis ({{x}}) usadas no template, já normalizadas e sem repetição. */
export function templateVars(template: string): string[] {
  return [...new Set([...template.matchAll(VAR_RE)].map((m) => varKey(m[1])))];
}

/**
 * Erros de sintaxe que fariam a marcação sair literal na mensagem
 * ("{{nome}", "{nome}", "{Oi|Olá" ...). Lista vazia = template válido.
 */
export function validateTemplate(template: string): string[] {
  const errors: string[] = [];
  if (!template.trim()) return ['A mensagem está vazia'];

  let rest = template.replace(VAR_RE, '');
  if (/\{\{|\}\}/.test(rest)) errors.push('Há uma variável com chaves incompletas: use {{nome}}, com duas chaves de cada lado');

  // Remove as variações {a|b} de dentro para fora; o que sobrar de chave não tem par.
  const spin = /\{[^{}]*\|[^{}]*\}/;
  while (spin.test(rest)) rest = rest.replace(spin, '');
  for (const m of rest.matchAll(/\{\s*([^{}|]*?)\s*\}/g)) {
    errors.push(m[1] ? `"{${m[1]}}" não é variável nem variação: use {{${m[1]}}} para variável ou {opção1|opção2} para variação` : 'Há um "{}" vazio');
  }
  rest = rest.replace(/\{[^{}|]*\}/g, '');
  if (/[{}]/.test(rest) && !errors.length) errors.push('Há uma chave "{" ou "}" sem par');
  return errors;
}

export interface CheckedMessage {
  text: string;
  /** Problemas que impedem o envio (variável vazia, marcação que sobrou no texto). */
  problems: string[];
}

/** Renderiza e confere a mensagem de um contato. Só envie se `problems` estiver vazio. */
export function renderChecked(template: string, vars: TemplateVars, random: () => number = Math.random): CheckedMessage {
  const problems = templateVars(template)
    .filter((k) => !vars[k]?.trim())
    .map((k) => `{{${k}}} vazio para este contato`);
  const text = renderTemplate(template, vars, random);
  if (/[{}]/.test(text)) problems.push('sobrou marcação de template ({ ou }) no texto final');
  if (!text) problems.push('mensagem vazia após aplicar o template');
  return { text, problems };
}
