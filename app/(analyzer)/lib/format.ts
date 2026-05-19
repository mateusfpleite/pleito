/**
 * PURE presentation mappers for the dashboard (SPEC §8). Kept separate
 * from the JSX because the "which badge / which color" rule is the part
 * with semantics (the one Stefany reads at a glance) — testable without
 * render.
 *
 * `tom` is a semantic token (not a literal color): the CSS maps
 * ok/alerta/perigo/neutro → palette. Keeps the test stable across design
 * changes and the business rule explicit.
 */

export type Tom = 'ok' | 'alerta' | 'perigo' | 'neutro';

export type StatusVerificado =
  | 'vigente'
  | 'revogada'
  | 'contestada'
  | 'inexistente'
  | 'nao-verificado';

export type Severidade = 'alta' | 'media' | 'baixa';

export type Badge = { simbolo: string; rotulo: string; tom: Tom };

/**
 * statusVerificado → badge. Core of the value for Stefany: ✓ vigente
 * (confirmed) / ✗ revogada (do not use) / ⚠ everything NOT confirmed as
 * vigente (contestada, inexistente, não-verificado) — skeptical by
 * default: absence of confirmation is NEVER presented as "ok".
 */
export function badgeStatusVerificado(s: StatusVerificado): Badge {
  switch (s) {
    case 'vigente':
      return { simbolo: '✓', rotulo: 'Vigente', tom: 'ok' };
    case 'revogada':
      return { simbolo: '✗', rotulo: 'Revogada', tom: 'perigo' };
    case 'contestada':
      return { simbolo: '⚠', rotulo: 'Contestada', tom: 'alerta' };
    case 'inexistente':
      return { simbolo: '⚠', rotulo: 'Inexistente', tom: 'alerta' };
    case 'nao-verificado':
      return {
        simbolo: '⚠',
        rotulo: 'Não-verificado',
        tom: 'alerta',
      };
  }
}

/** severidade → color (alta=red / media=amber / baixa=neutral). */
export function corSeveridade(s: Severidade): { tom: Tom; rotulo: string } {
  switch (s) {
    case 'alta':
      return { tom: 'perigo', rotulo: 'Alta' };
    case 'media':
      return { tom: 'alerta', rotulo: 'Média' };
    case 'baixa':
      return { tom: 'neutro', rotulo: 'Baixa' };
  }
}

const TRACO = '—';

const fmtBRL = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

export function fmtMoedaBRL(v: number | null): string {
  return v == null ? TRACO : fmtBRL.format(v);
}

export function fmtMeses(m: number | null): string {
  return m == null ? TRACO : `${m} ${m === 1 ? 'mês' : 'meses'}`;
}

export function fmtDias(d: number | null): string {
  return d == null ? TRACO : `${d} ${d === 1 ? 'dia' : 'dias'}`;
}
