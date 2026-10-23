import type { ContactInput } from './contacts.ts';
import { prettyName } from './template.ts';

/** Prospecto como vem de `listar_prospectos` do WatchTower (só os campos usados). */
export interface WtProspect {
  id: string;
  nome: string | null;
  contatoNome: string | null;
  email: string | null;
  telefone: string | null;
  documento: string | null;
  etapaId: string | null;
  etapaNome: string | null;
  pastaNome: string | null;
  responsavelNome: string | null;
  origem?: string | null;
}

export type CnaeFilter = 'todos' | 'principal' | 'secundario';

/**
 * As bases da Receita marcam na origem quando o CNAE buscado é só secundário
 * ("Receita Federal - CNAE 6920 secundário (...)"). Nesses casos a empresa costuma ser
 * consultoria/assessoria, não escritório de contabilidade. Sem origem conta como principal.
 */
export function isSecondaryCnae(p: Pick<WtProspect, 'origem'>): boolean {
  return /secund[aá]ri/i.test(p.origem ?? '');
}

export function matchesCnae(p: Pick<WtProspect, 'origem'>, filter: CnaeFilter | undefined): boolean {
  if (!filter || filter === 'todos') return true;
  return filter === 'secundario' ? isSecondaryCnae(p) : !isSecondaryCnae(p);
}

/**
 * Converte um prospecto em contato. Variáveis disponíveis no template:
 * {{nome}}/{{primeiro_nome}} (contato, ou a empresa se não houver contato), {{empresa}}, {{contato}},
 * {{email}}, {{documento}}, {{pasta}}, {{cidade}} (texto após " - " no nome da pasta,
 * ex.: "Contabilidades - Lajeado" → "Lajeado"), {{etapa}} e {{responsavel}}.
 */
export function prospectToContact(p: WtProspect): ContactInput {
  const empresa = (p.nome ?? '').trim();
  const contato = prettyName(p.contatoNome ?? '');
  const pasta = (p.pastaNome ?? '').trim();
  const cidade = pasta.includes(' - ') ? pasta.slice(pasta.lastIndexOf(' - ') + 3).trim() : '';
  return {
    phonesRaw: p.telefone ?? '',
    name: contato || empresa,
    wtProspectId: p.id,
    vars: {
      empresa,
      contato,
      email: p.email ?? '',
      documento: p.documento ?? '',
      pasta,
      cidade,
      etapa: p.etapaNome ?? '',
      responsavel: p.responsavelNome ?? '',
      origem: p.origem ?? '',
    },
  };
}

/** O MCP responde com blocos de texto; o primeiro traz o JSON e os demais, avisos (ex.: "Empresa: ..."). */
export function parseToolText(content: unknown): unknown {
  const blocks = Array.isArray(content) ? content : [];
  const text = blocks.find((b) => b?.type === 'text')?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
