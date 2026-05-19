/**
 * PrismaNormaCache — `NormaCache` (domain/ports.ts) sobre Prisma.
 *
 * `chave` é `@unique`/`@id` — `gravar` faz upsert (reuso entre análises;
 * SPEC §9 `norma_cache` reusável). `verificadoEm` é carimbado pelo banco
 * (`@default(now())`) no insert e renovado a cada upsert. `fonte` no
 * domínio é `string` (não nullable); a coluna é nullable para tolerar
 * legados — mapeia `null` → `''`.
 */
import type {
  NormaCache,
  NormaCacheEntry,
  NormaStatus,
} from '../../domain/ports.ts';
import type { PrismaClientLike } from './client.ts';

type NormaCacheRow = {
  chave: string;
  status: string;
  fonte: string | null;
  verificadoEm: Date;
};

function paraEntry(row: NormaCacheRow): NormaCacheEntry {
  return {
    chave: row.chave,
    status: row.status as NormaStatus,
    fonte: row.fonte ?? '',
    verificadoEm: row.verificadoEm,
  };
}

export class PrismaNormaCache implements NormaCache {
  constructor(private readonly prisma: PrismaClientLike) {}

  async obter(chave: string): Promise<NormaCacheEntry | null> {
    const row = (await this.prisma.normaCache.findUnique({
      where: { chave },
    })) as NormaCacheRow | null;
    return row ? paraEntry(row) : null;
  }

  async gravar(
    entry: Omit<NormaCacheEntry, 'verificadoEm'>
  ): Promise<void> {
    const verificadoEm = new Date();
    await this.prisma.normaCache.upsert({
      where: { chave: entry.chave },
      create: {
        chave: entry.chave,
        status: entry.status,
        fonte: entry.fonte,
        verificadoEm,
      },
      update: {
        status: entry.status,
        fonte: entry.fonte,
        verificadoEm,
      },
    });
  }
}
