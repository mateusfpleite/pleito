/**
 * Estado PURO da edição human-in-the-loop do ofício (SPEC §8).
 *
 * O Drafter gera `OficioGerado.markdown`; antes do export (Phase 14) a
 * Stefany pode editar. Phase 13 entrega só a textarea EDITÁVEL controlada
 * + este estado local. Guardar `original` torna trivial:
 *  - detectar se foi editado (`foiEditado`) — sinal de diff p/ §11b;
 *  - reverter ao gerado.
 *
 * Sem React aqui de propósito: o componente só fia onChange→editarTexto.
 */

export type EdicaoOficio = {
  /** Texto atual da textarea (estado controlado). */
  texto: string;
  /** Markdown originalmente gerado pelo Drafter (para revert/diff). */
  original: string;
};

export function inicializarEdicao(markdownGerado: string): EdicaoOficio {
  return { texto: markdownGerado, original: markdownGerado };
}

export function editarTexto(e: EdicaoOficio, novo: string): EdicaoOficio {
  return { ...e, texto: novo };
}

export function reverter(e: EdicaoOficio): EdicaoOficio {
  return { ...e, texto: e.original };
}

/** Houve edição humana? (texto difere do gerado). */
export function foiEditado(e: EdicaoOficio): boolean {
  return e.texto !== e.original;
}
