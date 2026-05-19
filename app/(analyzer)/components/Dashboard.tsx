/**
 * Dashboard single-edital (SPEC §8): painéis seccionados a partir de
 * `EditalExtraction` + `OficioGerado?`. Informativos colapsáveis;
 * pontos de atenção / inconsistências / ambíguos em DESTAQUE; leis com
 * badge de `statusVerificado`; ofício em textarea EDITÁVEL (estado local
 * controlado — o export é Phase 14).
 */
'use client';

import { useState } from 'react';
import type { EditalExtraction } from '../../../domain/schema.ts';
import type { OficioGerado } from '../../../domain/ports.ts';
import {
  badgeStatusVerificado,
  corSeveridade,
  fmtMoedaBRL,
  fmtMeses,
  fmtDias,
} from '../lib/format.ts';
import {
  inicializarEdicao,
  editarTexto,
  reverter,
  foiEditado,
  type EdicaoOficio,
} from '../lib/oficio-edicao.ts';
import { Badge, Painel, Campo, Grade } from './ui.tsx';

function ListaHabilitacao({
  titulo,
  itens,
}: {
  titulo: string;
  itens: EditalExtraction['habilitacao']['juridica'];
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <strong style={{ fontSize: 13 }}>{titulo}</strong>
      {itens.length === 0 ? (
        <p style={{ color: '#999', fontSize: 13, margin: '4px 0' }}>
          Nenhuma exigência registrada.
        </p>
      ) : (
        <ul style={{ margin: '4px 0', paddingLeft: 18, fontSize: 13 }}>
          {itens.map((x, i) => (
            <li key={i} style={{ marginBottom: 4 }}>
              {x.exigencia}
              {x.baseLegal && (
                <em style={{ color: '#777' }}> ({x.baseLegal})</em>
              )}
              {x.observacao && (
                <span style={{ color: '#a31515' }}> — {x.observacao}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td
      style={{
        padding: '6px 10px',
        borderBottom: '1px solid #eee',
        fontSize: 13,
      }}
    >
      {children}
    </td>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      style={{
        padding: '6px 10px',
        textAlign: 'left',
        fontSize: 12,
        color: '#666',
        borderBottom: '2px solid #ddd',
      }}
    >
      {children}
    </th>
  );
}

/**
 * Dispara o export PDF on-demand (Phase 14, §9). O PDF é projeção
 * derivada — baixado, NUNCA persistido. Para `oficio`, manda o TEXTO
 * EDITADO da textarea: o servidor persiste esse texto em
 * `oficioExportado` e renderiza o PDF a partir dele (não do JSON).
 */
async function baixarPdf(
  jobId: string,
  tipo: 'relatorio' | 'oficio',
  textoOficio?: string
): Promise<void> {
  const res = await fetch(`/api/export/${jobId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tipo, textoOficio }),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { erro?: string };
    throw new Error(b.erro ?? `falha no export (HTTP ${res.status})`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${tipo}-${jobId}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function OficioEditavel({
  oficio,
  jobId,
}: {
  oficio: OficioGerado;
  jobId: string;
}) {
  const [ed, setEd] = useState<EdicaoOficio>(() =>
    inicializarEdicao(oficio.markdown)
  );
  const [exportando, setExportando] = useState(false);
  const [erroExport, setErroExport] = useState<string | null>(null);

  async function exportarOficio() {
    setExportando(true);
    setErroExport(null);
    try {
      // Envia o texto ATUAL da textarea — o que a Stefany vê e aprovou.
      await baixarPdf(jobId, 'oficio', ed.texto);
    } catch (e) {
      setErroExport(e instanceof Error ? e.message : String(e));
    } finally {
      setExportando(false);
    }
  }

  return (
    <div>
      <p style={{ fontSize: 13, color: '#555', marginTop: 0 }}>
        Rascunho de <strong>{oficio.tipo}</strong>. Revise e ajuste; ao
        exportar, o PDF é gerado sob demanda a partir do texto abaixo.
      </p>
      <textarea
        value={ed.texto}
        onChange={(e) => setEd(editarTexto(ed, e.target.value))}
        spellCheck
        style={{
          width: '100%',
          minHeight: 320,
          fontFamily: 'ui-monospace, Menlo, monospace',
          fontSize: 13,
          lineHeight: 1.5,
          padding: 12,
          border: '1px solid #ccc',
          borderRadius: 6,
          boxSizing: 'border-box',
          resize: 'vertical',
        }}
      />
      <div
        style={{
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          marginTop: 8,
        }}
      >
        <button
          type="button"
          onClick={() => setEd(reverter(ed))}
          disabled={!foiEditado(ed)}
          style={{
            padding: '6px 12px',
            fontSize: 13,
            cursor: foiEditado(ed) ? 'pointer' : 'default',
          }}
        >
          Reverter ao gerado
        </button>
        <button
          type="button"
          onClick={() => void exportarOficio()}
          disabled={exportando}
          style={{
            padding: '6px 12px',
            fontSize: 13,
            fontWeight: 600,
            cursor: exportando ? 'default' : 'pointer',
          }}
        >
          {exportando ? 'Exportando…' : 'Exportar ofício (PDF)'}
        </button>
        {foiEditado(ed) && (
          <span style={{ fontSize: 12, color: '#8a5a00' }}>
            Editado (será o texto exportado)
          </span>
        )}
      </div>
      {erroExport && (
        <div
          role="alert"
          style={{
            marginTop: 8,
            fontSize: 12,
            color: '#a31515',
          }}
        >
          Falha ao exportar: {erroExport}
        </div>
      )}
    </div>
  );
}

function ExportarRelatorio({ jobId }: { jobId: string }) {
  const [exportando, setExportando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  async function exportar() {
    setExportando(true);
    setErro(null);
    try {
      await baixarPdf(jobId, 'relatorio');
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    } finally {
      setExportando(false);
    }
  }
  return (
    <div style={{ marginBottom: 16 }}>
      <button
        type="button"
        onClick={() => void exportar()}
        disabled={exportando}
        style={{
          padding: '8px 14px',
          fontSize: 13,
          fontWeight: 600,
          cursor: exportando ? 'default' : 'pointer',
        }}
      >
        {exportando
          ? 'Gerando relatório…'
          : 'Exportar relatório (PDF)'}
      </button>
      {erro && (
        <span
          role="alert"
          style={{ marginLeft: 10, fontSize: 12, color: '#a31515' }}
        >
          Falha: {erro}
        </span>
      )}
    </div>
  );
}

export function Dashboard({
  extracao,
  oficio,
  jobId,
}: {
  extracao: EditalExtraction;
  oficio: OficioGerado | null;
  jobId: string;
}) {
  const e = extracao;
  return (
    <div>
      <ExportarRelatorio jobId={jobId} />
      <Painel titulo="Cabeçalho" colapsavel={false}>
        <Grade>
          <Campo rotulo="Município/UF">
            {e.municipio}/{e.uf}
          </Campo>
          <Campo rotulo="Órgão/Ente">
            {e.ente.razaoSocial} ({e.ente.tipo})
          </Campo>
          <Campo rotulo="Modalidade">
            {e.modalidade} nº {e.numero}
          </Campo>
          <Campo rotulo="Regime jurídico">{e.regimeJuridico}</Campo>
          <Campo rotulo="Data da sessão">{e.dataSessao ?? '—'}</Campo>
          <Campo rotulo="Plataforma">{e.plataforma ?? '—'}</Campo>
        </Grade>
      </Painel>

      <Painel titulo="Objeto">
        <Campo rotulo="Objeto (corpo)">{e.objetoCorpo}</Campo>
        {e.objetoCapa && e.objetoCapa !== e.objetoCorpo && (
          <Campo rotulo="Objeto (capa) — divergente">
            {e.objetoCapa}
          </Campo>
        )}
        <Grade>
          <Campo rotulo="Tipo de objeto">
            {e.tipoObjeto.join(', ')}
          </Campo>
          <Campo rotulo="Valor estimado">
            {e.valor.sigiloso ? (
              <Badge tom="alerta">SIGILOSO</Badge>
            ) : (
              fmtMoedaBRL(e.valor.estimado)
            )}
          </Campo>
          <Campo rotulo="Critério / agrupamento">
            {e.criterioJulgamento} · {e.agrupamento}
          </Campo>
        </Grade>
      </Painel>

      <Painel titulo="Prazos">
        <Grade>
          <Campo rotulo="Vigência do contrato">
            {fmtMeses(e.vigenciaContrato.meses)}
            {e.vigenciaContrato.prorrogavelAteMeses != null &&
              ` (prorr. até ${e.vigenciaContrato.prorrogavelAteMeses})`}
          </Campo>
          <Campo rotulo="Validade da proposta">
            {fmtDias(e.validadeProposta?.dias ?? null)}
          </Campo>
          <Campo rotulo="Prazo de recursos">
            {e.prazoRecursosDiasUteis == null
              ? '—'
              : `${e.prazoRecursosDiasUteis} dias úteis`}
          </Campo>
          <Campo rotulo="Intervalo mínimo de lances">
            {e.intervaloMinimoLances == null
              ? '—'
              : `${e.intervaloMinimoLances} s`}
          </Campo>
        </Grade>
      </Painel>

      <Painel titulo="Habilitação">
        <ListaHabilitacao
          titulo="Jurídica"
          itens={e.habilitacao.juridica}
        />
        <ListaHabilitacao
          titulo="Fiscal e trabalhista"
          itens={e.habilitacao.fiscalTrabalhista}
        />
        <ListaHabilitacao
          titulo="Econômico-financeira"
          itens={e.habilitacao.economicoFinanceira}
        />
        <ListaHabilitacao
          titulo="Técnica"
          itens={e.habilitacao.tecnica}
        />
      </Painel>

      <Painel titulo={`Itens licitados (${e.itensLicitados.length})`}>
        {e.itensLicitados.length === 0 ? (
          <p style={{ color: '#999', fontSize: 13 }}>
            Nenhum item itemizado.
          </p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <Th>Nº</Th>
                <Th>Descrição</Th>
                <Th>Tipo</Th>
                <Th>Público-alvo</Th>
                <Th>Qtd</Th>
                <Th>Valor unit. ref.</Th>
              </tr>
            </thead>
            <tbody>
              {e.itensLicitados.map((it, i) => (
                <tr key={i}>
                  <Td>{it.numero}</Td>
                  <Td>{it.descricao}</Td>
                  <Td>{it.tipo}</Td>
                  <Td>{it.publicoAlvo ?? '—'}</Td>
                  <Td>
                    {it.quantidade} {it.unidade}
                  </Td>
                  <Td>{fmtMoedaBRL(it.valorUnitarioReferencial)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Painel>

      <Painel
        titulo={`Pontos de atenção (${e.pontosDeAtencao.length})`}
        destaque
        inicialAberto
      >
        {e.pontosDeAtencao.length === 0 ? (
          <p style={{ color: '#999', fontSize: 13 }}>
            Nenhum ponto de atenção sinalizado.
          </p>
        ) : (
          e.pontosDeAtencao.map((p, i) => {
            const c = corSeveridade(p.severidade);
            return (
              <div
                key={i}
                style={{
                  padding: 12,
                  marginBottom: 8,
                  borderRadius: 8,
                  borderLeft: `4px solid ${
                    c.tom === 'perigo'
                      ? '#a31515'
                      : c.tom === 'alerta'
                        ? '#8a5a00'
                        : '#888'
                  }`,
                  background: '#fff',
                  border: '1px solid #eee',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    gap: 8,
                    marginBottom: 4,
                  }}
                >
                  <Badge tom={c.tom}>{c.rotulo}</Badge>
                  <Badge tom="neutro">{p.categoria}</Badge>
                  {p.recomendaManifestacao && (
                    <Badge tom="alerta">recomenda manifestação</Badge>
                  )}
                </div>
                <p style={{ margin: 0, fontSize: 14 }}>{p.descricao}</p>
              </div>
            );
          })
        )}
      </Painel>

      <Painel
        titulo={`Inconsistências (${e.incoerencias.length})`}
        destaque
        inicialAberto
      >
        {e.incoerencias.length === 0 ? (
          <p style={{ color: '#999', fontSize: 13 }}>
            Nenhuma inconsistência factual detectada.
          </p>
        ) : (
          e.incoerencias.map((inc, i) => {
            const c = corSeveridade(inc.severidade);
            return (
              <div
                key={i}
                style={{ marginBottom: 8, fontSize: 14 }}
              >
                <Badge tom={c.tom}>{c.rotulo}</Badge>{' '}
                <Badge tom="neutro">{inc.tipo}</Badge>{' '}
                {inc.descricao}
              </div>
            );
          })
        )}
      </Painel>

      <Painel
        titulo={`Trechos ambíguos (${e.trechosAmbiguos.length})`}
        destaque
        inicialAberto
      >
        {e.trechosAmbiguos.length === 0 ? (
          <p style={{ color: '#999', fontSize: 13 }}>
            Nenhum trecho ambíguo sinalizado.
          </p>
        ) : (
          e.trechosAmbiguos.map((t, i) => (
            <div
              key={i}
              style={{
                padding: 12,
                marginBottom: 8,
                background: '#fff',
                border: '1px solid #eee',
                borderRadius: 8,
              }}
            >
              <blockquote
                style={{
                  margin: 0,
                  paddingLeft: 10,
                  borderLeft: '3px solid #f0c674',
                  fontStyle: 'italic',
                  fontSize: 13,
                }}
              >
                “{t.trechoLiteral}”
              </blockquote>
              <p style={{ margin: '6px 0 0', fontSize: 13 }}>
                <strong>Brecha:</strong> {t.porQueAmbiguo}
              </p>
              <p
                style={{
                  margin: '2px 0 0',
                  fontSize: 12,
                  color: '#777',
                }}
              >
                Seção: {t.secaoOndeAparece}
              </p>
            </div>
          ))
        )}
      </Painel>

      <Painel titulo={`Leis referenciadas (${e.leisReferenciadas.length})`}>
        {e.leisReferenciadas.length === 0 ? (
          <p style={{ color: '#999', fontSize: 13 }}>
            Nenhuma norma referenciada.
          </p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <Th>Norma</Th>
                <Th>Tipo / escopo</Th>
                <Th>Contexto</Th>
                <Th>Status verificado</Th>
              </tr>
            </thead>
            <tbody>
              {e.leisReferenciadas.map((l, i) => {
                const b = badgeStatusVerificado(l.statusVerificado);
                return (
                  <tr key={i}>
                    <Td>{l.descricao}</Td>
                    <Td>
                      {l.tipoNorma} · {l.escopo}
                    </Td>
                    <Td>{l.contextoNoEdital}</Td>
                    <Td>
                      <Badge tom={b.tom}>
                        {b.simbolo} {b.rotulo}
                      </Badge>
                      {l.fonteVerificacao && (
                        <div
                          style={{
                            fontSize: 11,
                            color: '#888',
                            marginTop: 2,
                          }}
                        >
                          {l.fonteVerificacao}
                        </div>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Painel>

      {oficio && (
        <Painel
          titulo="Ofício (rascunho editável)"
          destaque
          colapsavel={false}
        >
          <OficioEditavel oficio={oficio} jobId={jobId} />
        </Painel>
      )}
    </div>
  );
}
