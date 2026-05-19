/**
 * /login — form mínimo de auth single-user (SPEC §14, #7). Client
 * component: campo senha → POST /api/login. Sucesso → redireciona p/ `/`.
 * Erro → mensagem genérica ("senha inválida"), sem vazar detalhe.
 */
'use client';

import { useState, type FormEvent } from 'react';

export default function LoginPage() {
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  async function aoEnviar(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    setErro(null);
    setOcupado(true);
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ senha }),
      });
      if (r.ok) {
        // Cookie httpOnly já setado pelo servidor; navega p/ a app.
        window.location.assign('/');
        return;
      }
      setErro('Senha inválida.');
    } catch {
      setErro('Falha de rede. Tente novamente.');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <main
      style={{
        maxWidth: 360,
        margin: '12vh auto 0',
        padding: '0 20px',
        fontFamily:
          'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        color: '#1a1a1a',
      }}
    >
      <h1 style={{ fontSize: 24, marginBottom: 4 }}>Pleito</h1>
      <p style={{ color: '#666', marginTop: 0, marginBottom: 24 }}>
        Acesso restrito.
      </p>

      <form
        onSubmit={aoEnviar}
        style={{
          border: '1px solid #dcdfe4',
          borderRadius: 10,
          padding: 20,
        }}
      >
        <label
          htmlFor="senha"
          style={{ display: 'block', fontSize: 14, marginBottom: 6 }}
        >
          Senha
        </label>
        <input
          id="senha"
          name="senha"
          type="password"
          autoComplete="current-password"
          value={senha}
          onChange={(e) => setSenha(e.target.value)}
          autoFocus
          style={{
            width: '100%',
            padding: 10,
            fontSize: 14,
            border: '1px solid #ccc',
            borderRadius: 6,
            boxSizing: 'border-box',
            marginBottom: 14,
          }}
        />
        <button
          type="submit"
          disabled={ocupado || senha === ''}
          style={{
            padding: '10px 18px',
            fontSize: 14,
            fontWeight: 600,
            cursor: ocupado || senha === '' ? 'default' : 'pointer',
          }}
        >
          {ocupado ? 'Entrando…' : 'Entrar'}
        </button>

        {erro && (
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
            {erro}
          </div>
        )}
      </form>
    </main>
  );
}
