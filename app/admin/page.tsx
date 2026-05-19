/**
 * Superfície de revisão interna `/admin` (SPEC §11b: "lista de análises +
 * feedback + diffs — sem isso o loop não fecha"). Read-only, simples.
 * Sem auth fancy: a auth global é Phase 16; /admin fica sob a mesma
 * proteção que vier lá (por ora rota simples).
 *
 * Client component: busca `GET /api/admin/list`. Cada linha mostra
 * município/uf, data, feedback (👍/👎+texto), sinal-ouro
 * (foiEditado/distância do diff) + fallback (exportou?), re-upload, e o
 * botão PROMOTE-TO-CORPUS em 1 passo (POST /api/admin/promover/:id →
 * grava em `fixtures/gold/`, vira regressão do Tier 0).
 */
'use client';

import { useEffect, useState } from 'react';
import type { LinhaAdmin } from './handler.ts';

export default function AdminPage() {
  const [linhas, setLinhas] = useState<LinhaAdmin[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [promovendo, setPromovendo] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const r = await fetch('/api/admin/list');
        const b = (await r.json()) as {
          linhas?: LinhaAdmin[];
          erro?: string;
        };
        if (!vivo) return;
        if (!r.ok) {
          setErro(b.erro ?? `falha ao listar (HTTP ${r.status})`);
          return;
        }
        setLinhas(b.linhas ?? []);
      } catch (e) {
        if (vivo) setErro(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      vivo = false;
    };
  }, []);

  async function promover(id: string) {
    setPromovendo(id);
    setMsg(null);
    try {
      const r = await fetch(`/api/admin/promover/${id}`, {
        method: 'POST',
      });
      const b = (await r.json()) as {
        nomeArquivo?: string;
        erro?: string;
      };
      setMsg(
        r.ok
          ? `Promovido → fixtures/gold/${b.nomeArquivo}`
          : `Falha: ${b.erro ?? r.status}`
      );
    } catch (e) {
      setMsg(`Falha: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPromovendo(null);
    }
  }

  return (
    <main
      style={{
        maxWidth: 1100,
        margin: '0 auto',
        padding: '32px 20px',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        color: '#1a1a1a',
      }}
    >
      <h1 style={{ fontSize: 22 }}>Revisão interna (/admin)</h1>
      <p style={{ color: '#666', fontSize: 13, marginTop: 0 }}>
        Análises + feedback + diff ofício (sinal-ouro) + re-upload.
        Promover → vira fixture de regressão do Tier 0.
      </p>

      {erro && (
        <div
          role="alert"
          style={{ color: '#a31515', fontSize: 13, marginBottom: 12 }}
        >
          Erro: {erro}
        </div>
      )}
      {msg && (
        <div style={{ color: '#1a5e1a', fontSize: 13, marginBottom: 12 }}>
          {msg}
        </div>
      )}
      {linhas === null && !erro && (
        <p style={{ fontSize: 13, color: '#666' }}>Carregando…</p>
      )}

      {linhas && linhas.length === 0 && (
        <p style={{ fontSize: 13, color: '#999' }}>
          Nenhuma análise ainda.
        </p>
      )}

      {linhas && linhas.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {[
                'Município/UF',
                'Data',
                'Feedback',
                'Ofício editado? (sinal-ouro)',
                'Exportou? (reserva)',
                'Re-upload',
                '',
              ].map((h) => (
                <th
                  key={h}
                  style={{
                    textAlign: 'left',
                    fontSize: 12,
                    color: '#666',
                    borderBottom: '2px solid #ddd',
                    padding: '6px 8px',
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {linhas.map((l) => (
              <tr key={l.analysisId}>
                <td style={td}>
                  {l.municipio}/{l.uf}
                </td>
                <td style={td}>
                  {l.criadoEm
                    ? new Date(l.criadoEm).toLocaleString('pt-BR')
                    : '—'}
                </td>
                <td style={td}>
                  {l.feedback
                    ? `${l.feedback.util ? '👍' : '👎'}${
                        l.feedback.texto ? ` — ${l.feedback.texto}` : ''
                      }`
                    : '—'}
                </td>
                <td style={td}>
                  {l.oficioFoiEditado
                    ? `sim (Δ ${l.diffDistancia} chars)`
                    : 'não'}
                </td>
                <td style={td}>{l.exportouOficio ? 'sim' : 'não'}</td>
                <td style={td}>{l.reupload ? 'sim' : 'não'}</td>
                <td style={td}>
                  <button
                    type="button"
                    onClick={() => void promover(l.analysisId)}
                    disabled={promovendo === l.analysisId}
                    style={{ fontSize: 12, padding: '4px 8px' }}
                  >
                    {promovendo === l.analysisId
                      ? 'Promovendo…'
                      : 'Promover ao corpus'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

const td: React.CSSProperties = {
  padding: '6px 8px',
  borderBottom: '1px solid #eee',
  fontSize: 13,
};
