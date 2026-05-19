/**
 * Tela de resultado single-edital (SPEC §8). Client component:
 *  1. Upload (arquivo OU texto colado) → POST /api/job → { jobId }.
 *  2. Polling de GET /api/status/:id a cada POLL_MS; para em done/erro
 *     (máquina de estado pura em lib/polling.ts — testada).
 *  3. done → <Dashboard> em painéis seccionados.
 *
 * O processamento real leva ~70-160s (pipeline no worker). A fase
 * `aguardando` é longa e ESPERADA — a UI deixa explícito que está
 * processando (status do job + tempo decorrido), não travado.
 */
'use client';

import {
  useReducer,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  reducirPolling,
  estadoInicial,
  ehTerminal,
} from './lib/polling.ts';
import type { StatusResponse } from './lib/types.ts';
import { Dashboard } from './components/Dashboard.tsx';

const POLL_MS = 2500;

export default function AnalyzerPage() {
  const [state, dispatch] = useReducer(reducirPolling, estadoInicial);
  const [modo, setModo] = useState<'arquivo' | 'texto'>('arquivo');
  const [decorridoS, setDecorridoS] = useState(0);
  const inicioRef = useRef<number>(0);

  // Polling: enquanto aguardando, busca /api/status a cada POLL_MS.
  // Para assim que o estado vira terminal (ehTerminal) ou desmonta.
  useEffect(() => {
    if (state.fase !== 'aguardando' || !state.jobId) return;
    let vivo = true;
    const id = state.jobId;

    async function tick() {
      try {
        const r = await fetch(`/api/status/${id}`);
        if (!vivo) return;
        if (!r.ok && r.status === 404) {
          dispatch({ tipo: 'falha', mensagem: `job ${id} não encontrado` });
          return;
        }
        const resposta = (await r.json()) as StatusResponse;
        if (!vivo) return;
        dispatch({ tipo: 'status', resposta });
      } catch (err) {
        if (!vivo) return;
        const msg = err instanceof Error ? err.message : String(err);
        dispatch({ tipo: 'falha', mensagem: `falha ao consultar status: ${msg}` });
      }
    }

    void tick();
    const timer = setInterval(() => {
      void tick();
    }, POLL_MS);
    return () => {
      vivo = false;
      clearInterval(timer);
    };
  }, [state.fase, state.jobId]);

  // Cronômetro do "processando" — feedback de que NÃO travou.
  useEffect(() => {
    if (state.fase !== 'aguardando') return;
    inicioRef.current = Date.now();
    setDecorridoS(0);
    const t = setInterval(() => {
      setDecorridoS(Math.round((Date.now() - inicioRef.current) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [state.fase]);

  async function aoEnviar(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const form = new FormData(ev.currentTarget);
    // Mantém só o campo do modo ativo (file vazio + texto vazio = 400).
    if (modo === 'arquivo') form.delete('texto');
    else form.delete('file');
    dispatch({ tipo: 'submeter' });
    try {
      const r = await fetch('/api/job', { method: 'POST', body: form });
      const b = (await r.json()) as { jobId?: string; erro?: string };
      if (!r.ok || !b.jobId) {
        dispatch({
          tipo: 'falha',
          mensagem: b.erro ?? `falha no upload (HTTP ${r.status})`,
        });
        return;
      }
      dispatch({ tipo: 'job-criado', jobId: b.jobId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dispatch({ tipo: 'falha', mensagem: `falha de rede no upload: ${msg}` });
    }
  }

  const ocupado =
    state.fase === 'submetendo' || state.fase === 'aguardando';

  return (
    <main
      style={{
        maxWidth: 980,
        margin: '0 auto',
        padding: '32px 20px',
        fontFamily:
          'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        color: '#1a1a1a',
      }}
    >
      <h1 style={{ fontSize: 24, marginBottom: 4 }}>Pleito</h1>
      <p style={{ color: '#666', marginTop: 0 }}>
        Análise de edital — suba o arquivo ou cole o texto.
      </p>

      {(state.fase === 'idle' || state.fase === 'erro') && (
        <form
          onSubmit={aoEnviar}
          style={{
            border: '1px solid #dcdfe4',
            borderRadius: 10,
            padding: 20,
            marginBottom: 20,
          }}
        >
          <div style={{ marginBottom: 12, display: 'flex', gap: 16 }}>
            <label style={{ fontSize: 14 }}>
              <input
                type="radio"
                name="modo"
                checked={modo === 'arquivo'}
                onChange={() => setModo('arquivo')}
              />{' '}
              Arquivo
            </label>
            <label style={{ fontSize: 14 }}>
              <input
                type="radio"
                name="modo"
                checked={modo === 'texto'}
                onChange={() => setModo('texto')}
              />{' '}
              Colar texto
            </label>
          </div>

          {modo === 'arquivo' ? (
            <input
              type="file"
              name="file"
              accept=".pdf,.txt,.zip,.gz"
              style={{ display: 'block', marginBottom: 12 }}
            />
          ) : (
            <textarea
              name="texto"
              placeholder="Cole aqui o texto integral do edital…"
              style={{
                width: '100%',
                minHeight: 200,
                padding: 12,
                fontSize: 13,
                border: '1px solid #ccc',
                borderRadius: 6,
                boxSizing: 'border-box',
                marginBottom: 12,
              }}
            />
          )}

          <button
            type="submit"
            disabled={ocupado}
            style={{
              padding: '10px 18px',
              fontSize: 14,
              fontWeight: 600,
              cursor: ocupado ? 'default' : 'pointer',
            }}
          >
            Analisar edital
          </button>

          {state.fase === 'erro' && (
            <div
              role="alert"
              style={{
                marginTop: 14,
                padding: 12,
                background: '#fdeceb',
                border: '1px solid #e69b96',
                borderRadius: 8,
                color: '#a31515',
                fontSize: 14,
              }}
            >
              <strong>Erro:</strong> {state.erro}
            </div>
          )}
        </form>
      )}

      {ocupado && (
        <div
          style={{
            border: '1px solid #dcdfe4',
            borderRadius: 10,
            padding: 24,
            textAlign: 'center',
            marginBottom: 20,
          }}
        >
          <div
            style={{
              width: 28,
              height: 28,
              margin: '0 auto 12px',
              border: '3px solid #dcdfe4',
              borderTopColor: '#555',
              borderRadius: '50%',
              animation: 'pleito-spin 0.9s linear infinite',
            }}
          />
          <p style={{ fontWeight: 600, margin: '0 0 4px' }}>
            {state.fase === 'submetendo'
              ? 'Enviando edital…'
              : state.statusJob === 'pending'
                ? 'Na fila — acordando o processador…'
                : 'Processando o edital…'}
          </p>
          <p style={{ color: '#666', fontSize: 13, margin: 0 }}>
            A análise completa leva de 1 a 3 minutos (extração, verificação
            de normas, redação). Decorrido: {decorridoS}s.
          </p>
          <style>{`@keyframes pleito-spin{to{transform:rotate(360deg)}}`}</style>
        </div>
      )}

      {state.fase === 'concluido' && state.resultado && (
        <>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 16,
            }}
          >
            <h2 style={{ fontSize: 18, margin: 0 }}>
              {state.resultado.municipio}/{state.resultado.uf}
            </h2>
            <button
              type="button"
              onClick={() => dispatch({ tipo: 'reiniciar' })}
              style={{ padding: '6px 12px', fontSize: 13 }}
            >
              Analisar outro
            </button>
          </div>
          <Dashboard
            extracao={state.resultado.extracao}
            oficio={state.resultado.oficioGerado}
          />
        </>
      )}
    </main>
  );
}
