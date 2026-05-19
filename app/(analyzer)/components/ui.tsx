/**
 * Primitivas visuais do dashboard. Sem estado — só apresentação.
 * `Painel` é colapsável (painéis informativos podem recolher; SPEC §8).
 * `Badge` mapeia o token `Tom` (de lib/format) → paleta.
 */
'use client';

import { useState, type ReactNode } from 'react';
import type { Tom } from '../lib/format.ts';

const PALETA: Record<Tom, { bg: string; fg: string; bd: string }> = {
  ok: { bg: '#e6f4ea', fg: '#11643a', bd: '#9ad3b0' },
  alerta: { bg: '#fef6e0', fg: '#8a5a00', bd: '#f0c674' },
  perigo: { bg: '#fdeceb', fg: '#a31515', bd: '#e69b96' },
  neutro: { bg: '#f0f1f3', fg: '#444', bd: '#cdd0d6' },
};

export function Badge({
  tom,
  children,
}: {
  tom: Tom;
  children: ReactNode;
}) {
  const c = PALETA[tom];
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        background: c.bg,
        color: c.fg,
        border: `1px solid ${c.bd}`,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

export function Painel({
  titulo,
  destaque = false,
  colapsavel = true,
  inicialAberto = true,
  children,
}: {
  titulo: string;
  destaque?: boolean;
  colapsavel?: boolean;
  inicialAberto?: boolean;
  children: ReactNode;
}) {
  const [aberto, setAberto] = useState(inicialAberto);
  return (
    <section
      style={{
        border: `1px solid ${destaque ? '#e69b96' : '#dcdfe4'}`,
        borderRadius: 10,
        marginBottom: 16,
        background: destaque ? '#fffafa' : '#fff',
        overflow: 'hidden',
      }}
    >
      <header
        onClick={colapsavel ? () => setAberto((v) => !v) : undefined}
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '12px 16px',
          cursor: colapsavel ? 'pointer' : 'default',
          background: destaque ? '#fdeceb' : '#f7f8fa',
          fontWeight: 700,
          fontSize: 15,
          borderBottom: aberto ? '1px solid #e7e9ee' : 'none',
        }}
      >
        <span>{titulo}</span>
        {colapsavel && (
          <span style={{ fontSize: 12, color: '#888' }}>
            {aberto ? '▾' : '▸'}
          </span>
        )}
      </header>
      {aberto && <div style={{ padding: 16 }}>{children}</div>}
    </section>
  );
}

export function Campo({
  rotulo,
  children,
}: {
  rotulo: string;
  children: ReactNode;
}) {
  return (
    <div style={{ marginBottom: 8 }}>
      <span
        style={{
          display: 'block',
          fontSize: 12,
          color: '#777',
          marginBottom: 2,
        }}
      >
        {rotulo}
      </span>
      <span style={{ fontSize: 14 }}>{children}</span>
    </div>
  );
}

export function Grade({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: 12,
      }}
    >
      {children}
    </div>
  );
}
