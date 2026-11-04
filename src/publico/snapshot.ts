import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import { claves } from '../../compartido/claves.js';
import {
  CANDIDATOS,
  type Candidato,
  type Snapshot,
  type Topico,
  type Votos,
} from '../../compartido/contratos.js';
import { deserializarCamposStream } from '../../carga/eventos-falsos.js';

export function esTopicoValido(topico: string): topico is Topico {
  if (topico === 'dep') return true;
  if (/^mun:\d+$/.test(topico)) return true;
  if (/^pue:\d+$/.test(topico)) return true;
  return false;
}

/**
 * Obtiene el último id (seq) del stream para un tópico dado.
 */
export async function obtenerUltimoSeq(redis: Redis, topico: Topico): Promise<string> {
  if (topico === 'dep') {
    const res = await redis.xrevrange(claves.evDep(), '+', '-', 'COUNT', 1);
    return res.length > 0 ? res[0][0] : '0-0';
  }

  if (topico.startsWith('mun:')) {
    const m = topico.slice(4);
    const res = await redis.xrevrange(claves.evMun(m), '+', '-', 'COUNT', 1);
    return res.length > 0 ? res[0][0] : '0-0';
  }

  // pue:{p}
  const p = Number(topico.slice(4));
  // Consultar si tenemos mapeado el municipio del puesto
  let munId = await redis.get(`cat:pue:${p}:mun`);
  if (!munId) {
    // Si no está el atajo, buscar en cat:mesa:* o en el catálogo
    const mesaEjemplo = await redis.get(`cat:pue:${p}:mesa_ejemplo`);
    if (mesaEjemplo) {
      const datosMesa = await redis.hgetall(claves.catMesa(mesaEjemplo));
      if (datosMesa.municipio) munId = datosMesa.municipio;
    }
  }

  if (munId) {
    // Buscar el último evento del municipio que coincida con este puesto
    const entradas = await redis.xrevrange(claves.evMun(munId), '+', '-', 'COUNT', 50);
    for (const [id, campos] of entradas) {
      const ev = deserializarCamposStream(campos);
      if (ev.puesto === p) {
        return id;
      }
    }
    // Si no hay evento en la ventana para este puesto, devuelve '0-0'
    return '0-0';
  }

  return '0-0';
}

/**
 * Construye el Snapshot para un tópico a partir de Redis.
 */
export async function obtenerSnapshot(redis: Redis, topico: Topico): Promise<Snapshot> {
  let claveTot = claves.totDep();
  let claveRank = claves.rankDep();
  let claveCatTotal = claves.catTotalDep();

  if (topico.startsWith('mun:')) {
    const m = topico.slice(4);
    claveTot = claves.totMun(m);
    claveRank = claves.rankMun(m);
    claveCatTotal = claves.catTotalMun(m);
  } else if (topico.startsWith('pue:')) {
    const p = topico.slice(4);
    claveTot = claves.totPue(p);
    claveRank = claves.rankPue(p);
    claveCatTotal = claves.catTotalPue(p);
  }

  const [totHash, rawRank, totalMesasStr, seq] = await Promise.all([
    redis.hgetall(claveTot),
    redis.zrevrange(claveRank, 0, -1, 'WITHSCORES'),
    redis.get(claveCatTotal),
    obtenerUltimoSeq(redis, topico),
  ]);

  // Construir totales con todos los candidatos (por defecto 0)
  const totales: Votos = {
    C1: Number(totHash.C1 ?? 0),
    C2: Number(totHash.C2 ?? 0),
    C3: Number(totHash.C3 ?? 0),
    BLANCO: Number(totHash.BLANCO ?? 0),
    NULO: Number(totHash.NULO ?? 0),
    NO_MARCADO: Number(totHash.NO_MARCADO ?? 0),
  };

  // Construir ranking ordenado de mayor a menor
  const ranking: Array<{ candidato: Candidato; votos: number }> = [];
  const candidatosEnRank = new Set<string>();

  for (let i = 0; i < rawRank.length; i += 2) {
    const cand = rawRank[i] as Candidato;
    const votos = Number(rawRank[i + 1] ?? 0);
    ranking.push({ candidato: cand, votos });
    candidatosEnRank.add(cand);
  }

  // Asegurar que todos los candidatos aparezcan en ranking si aún no estaban en el ZSET
  for (const c of CANDIDATOS) {
    if (!candidatosEnRank.has(c)) {
      ranking.push({ candidato: c, votos: totales[c] ?? 0 });
    }
  }
  ranking.sort((a, b) => b.votos - a.votos);

  const informadas = Number(totHash._informadas ?? 0);
  const total_mesas = Number(totalMesasStr ?? 0);

  return {
    topico,
    seq,
    totales,
    ranking,
    informadas,
    total_mesas,
  };
}

/**
 * Handler HTTP para GET /api/snapshot
 */
export async function manejarSnapshot(
  req: Request,
  res: Response,
  redis: Redis,
): Promise<void> {
  const topicoParam = req.query.topico;
  if (typeof topicoParam !== 'string' || !esTopicoValido(topicoParam)) {
    res.status(400).json({ error: 'Parámetro "topico" requerido y debe ser dep, mun:{m} o pue:{p}' });
    return;
  }

  const topico: Topico = topicoParam;

  try {
    const snapshot = await obtenerSnapshot(redis, topico);
    const seq = snapshot.seq;
    const etag = `"${seq}"`;

    res.setHeader('ETag', etag);

    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch) {
      if (ifNoneMatch === etag || ifNoneMatch === seq || ifNoneMatch.replace(/^W\//, '') === etag) {
        res.status(304).end();
        return;
      }
    }

    res.json(snapshot);
  } catch (err: any) {
    res.status(503).json({ error: 'Redis no disponible', detalle: err?.message });
  }
}
