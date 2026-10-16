import { varKey } from './template.ts';

/**
 * Detecta pedido de descadastro. Só considera mensagens curtas (até 5 palavras)
 * para não confundir frases como "não quero sair perdendo, me liga".
 */
export function isOptOut(text: string, keywords: string[]): boolean {
  const words = varKey(text)
    .replace(/[^a-z0-9_ ]/g, ' ')
    .split(/[\s_]+/)
    .filter(Boolean);
  if (words.length === 0 || words.length > 5) return false;
  const set = new Set(keywords.map(varKey));
  return words.some((w) => set.has(w));
}
