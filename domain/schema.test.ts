import { describe, it, expect } from 'vitest';
import { EditalExtractionSchema } from './schema.ts';

// Minimal yet complete v3 object (new v3 fields included).
const validV3 = () => ({
  municipio: 'Niterói',
  uf: 'RJ',
  ente: {
    tipo: 'empresa-publica' as const,
    razaoSocial: 'EMPRESA DE INFRAESTRUTURA E OBRAS DE NITERÓI - ION',
    cnpj: '32104465/0001-89',
  },
  modalidade: 'pregao-eletronico' as const,
  numero: '90005/2025',
  processoAdministrativo: '9900095380/2024',
  dataPublicacao: null,
  dataSessao: '2025-04-09T11:00:00-03:00',
  uasg: null,
  regimeJuridico: 'lei-13303' as const,
  objetoCorpo: 'Registro de Preços para aquisição de urnas.',
  objetoCapa: 'AQUISIÇÃO',
  objetoSummary: 'Registro de Preços para aquisição de urnas mortuárias.',
  tipoObjeto: ['fornecimento-urnas' as const],
  secretariaDemandante: 'Área Técnica Demandante',
  valor: {
    estimado: null,
    sigiloso: true,
    procedencia: 'preambulo' as const,
  },
  moeda: 'BRL' as const,
  criterioJulgamento: 'menor-preco' as const,
  agrupamento: 'item' as const,
  modoDisputa: 'aberto' as const,
  regimeExecucao: 'preco-unitario' as const,
  vigenciaContrato: { meses: null, prorrogavelAteMeses: null },
  vigenciaAtaRP: { meses: null, prorrogavelAteMeses: 12 },
  validadeProposta: { dias: 60 },
  habilitacao: {
    juridica: [],
    fiscalTrabalhista: [],
    economicoFinanceira: [],
    tecnica: [],
  },
  exigenciasRegulatorias: {
    licencaSanitaria: false,
    alvaraFuncionamento: false,
    vistoria: false,
    amostra: false,
    outros: [],
  },
  itensLicitados: [],
  leisReferenciadas: [
    {
      descricao: 'Lei nº 13.303/2016',
      escopo: 'federal' as const,
      tipoNorma: 'lei' as const,
      numero: '13303',
      ano: 2016,
      contextoNoEdital: 'Regime jurídico aplicável.',
      revogada: false,
      // statusVerificado has default 'nao-verificado' — omitted on purpose
      fonteVerificacao: null,
    },
  ],
  anexos: [],
  incoerencias: [],
  trechosAmbiguos: [],
  // --- Campos novos v3 ---
  plataforma: 'ComprasNet',
  subcontratacaoPermitida: false,
  intervaloMinimoLances: 1,
  prazoRecursosDiasUteis: 3,
  informacoesViabilidade: 'Sem informações de viabilidade no edital.',
  pontosDeAtencao: [
    {
      descricao: 'Valor estimado sigiloso impede análise de margem.',
      categoria: 'financeiro' as const,
      severidade: 'media' as const,
      recomendaManifestacao: false,
    },
  ],
  fonte: { pdfNativo: true, ocr: false, paginas: 42, url: null },
});

describe('EditalExtractionSchema v3', () => {
  it('accepts a valid v3 object with pontosDeAtencao and default statusVerificado', () => {
    const parsed = EditalExtractionSchema.parse(validV3());
    expect(parsed.pontosDeAtencao).toHaveLength(1);
    expect(parsed.pontosDeAtencao[0].categoria).toBe('financeiro');
    // default aplicado em leisReferenciadas[].statusVerificado
    expect(parsed.leisReferenciadas[0].statusVerificado).toBe('nao-verificado');
    expect(parsed.plataforma).toBe('ComprasNet');
    expect(parsed.subcontratacaoPermitida).toBe(false);
  });

  it('accepts explicit statusVerificado and filled fonteVerificacao', () => {
    const obj = validV3();
    const lei = obj.leisReferenciadas[0] as Record<string, unknown>;
    lei.statusVerificado = 'revogada';
    lei.fonteVerificacao = 'norma-baseline.json';
    const parsed = EditalExtractionSchema.parse(obj);
    expect(parsed.leisReferenciadas[0].statusVerificado).toBe('revogada');
    expect(parsed.leisReferenciadas[0].fonteVerificacao).toBe(
      'norma-baseline.json'
    );
  });

  it('rejects an object without pontosDeAtencao', () => {
    const obj = validV3() as Record<string, unknown>;
    delete obj.pontosDeAtencao;
    expect(() => EditalExtractionSchema.parse(obj)).toThrow();
  });

  it('rejects pontoDeAtencao categoria outside the enum', () => {
    const obj = validV3();
    obj.pontosDeAtencao[0].categoria = 'inexistente' as never;
    expect(() => EditalExtractionSchema.parse(obj)).toThrow();
  });

  it('rejects statusVerificado outside the enum', () => {
    const obj = validV3();
    const lei = obj.leisReferenciadas[0] as Record<string, unknown>;
    lei.statusVerificado = 'incerto';
    expect(() => EditalExtractionSchema.parse(obj)).toThrow();
  });
});
