import type { ReactNode } from "react";

export const metadata = {
  title: "Pleito",
  description:
    "Vertical AI para análise de licitações B2G municipais brasileiras.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
