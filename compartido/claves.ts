/**
 * Claves de Redis — tabla 4.4 de docs/DISEÑO.md.
 * Toda clave se construye aquí; nadie escribe strings de clave a mano.
 */
export const claves = {
  // Catálogo (P1)
  catMesa: (mesa: number | string) => `cat:mesa:${mesa}`,
  catTotalDep: () => 'cat:total:dep',
  catTotalMun: (m: number | string) => `cat:total:mun:${m}`,
  catTotalPue: (p: number | string) => `cat:total:pue:${p}`,

  // Idempotencia y actas (P1)
  idem: (idem: string) => `idem:${idem}`,
  acta: (acta: string) => `acta:${acta}`,

  // Acumulados HASH (P1 escribe, P2 lee)
  totDep: () => 'tot:dep',
  totMun: (m: number | string) => `tot:mun:${m}`,
  totPue: (p: number | string) => `tot:pue:${p}`,
  totMesa: (mesa: number | string) => `tot:mesa:${mesa}`,

  // Ranking ZSET (P1 escribe, P2 lee)
  rankDep: () => 'rank:dep',
  rankMun: (m: number | string) => `rank:mun:${m}`,
  rankPue: (p: number | string) => `rank:pue:${p}`,

  // Streams de eventos (P1 escribe en el Lua, P2 lee)
  evDep: () => 'ev:dep',
  evMun: (m: number | string) => `ev:mun:${m}`,

  // Canales pub/sub de avisos (P1 publica, P2 suscribe)
  pubDep: () => 'pub:dep',
  pubMun: (m: number | string) => `pub:mun:${m}`,

  // Verificación (P1 agrega, P3 consume)
  colaVerif: () => 'cola:verif',
  lock: (acta: string) => `lock:acta:${acta}`,
  pubVerif: () => 'pub:verif',
  pres: (auditor: string) => `pres:${auditor}`,
  presIdx: () => 'pres:idx',

  // Límite de tasa (P1)
  rl: (jurado: string, minuto: number | string) => `rl:${jurado}:${minuto}`,

  // Métricas (P3, todos reportan)
  met: (instancia: string) => `met:${instancia}`,
  metIdx: () => 'met:idx',
} as const;

/** Constantes de expiración/retención de la tabla 4.4 y 4.5. */
export const TTL = {
  idemSeg: 86_400,
  lockMs: 30_000,
  presSeg: 30,
  rlSeg: 60,
  metSeg: 10,
} as const;

export const MAXLEN = {
  evMun: 2_000,
  evDep: 10_000,
} as const;
