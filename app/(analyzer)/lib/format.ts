/**
 * Mapeadores PUROS de apresentação para o dashboard (SPEC §8). Separados
 * do JSX porque a regra "qual badge / qual cor" é a parte com semântica
 * (e a que a Stefany lê de relance) — testável sem render.
 *
 * `tom` é um token semântico (não uma cor literal): o CSS mapeia
 * ok/alerta/perigo/neutro → paleta. Mantém o teste estável a mudança de
 * design e a regra de negócio explícita.
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
 * statusVerificado → badge. Núcleo do valor pra Stefany: ✓ vigente
 * (confirmada) / ✗ revogada (não use) / ⚠ tudo que NÃO foi confirmado
 * como vigente (contestada, inexistente, não-verificado) — cético por
 * padrão: ausência de confirmação NUNCA é apresentada como "ok".
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

/** severidade → cor (alta=vermelho / média=âmbar / baixa=neutro). */
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
