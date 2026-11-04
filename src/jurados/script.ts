/**
 * Carga y ejecución de lua/aplicar_acta.lua — DUEÑO: Persona 1.
 * SCRIPT LOAD una vez y EVALSHA; si Redis responde NOSCRIPT (reinicio o SCRIPT FLUSH),
 * se vuelve a cargar y se reintenta una vez.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Redis } from 'ioredis';
import { claves, MAXLEN, TTL } from '../../compartido/claves.js';
import { CANDIDATOS, type Acta, type RespuestaPostActa } from '../../compartido/contratos.js';

export type Origen = 'jurado' | 'auditor';

const RUTA_LUA = path.resolve(process.cwd(), 'lua/aplicar_acta.lua');
let fuente: string | undefined;
let sha: string | undefined;

async function cargar(redis: Redis): Promise<string> {
  fuente ??= readFileSync(RUTA_LUA, 'utf8');
  sha = (await redis.script('LOAD', fuente)) as string;
  return sha;
}

export function clavesDe(a: Pick<Acta, 'idem' | 'acta' | 'mesa' | 'puesto' | 'municipio'>): string[] {
  return [
    claves.idem(a.idem),
    claves.acta(a.acta),
    claves.catMesa(a.mesa),
    claves.totMesa(a.mesa),
    claves.totPue(a.puesto),
    claves.totMun(a.municipio),
    claves.totDep(),
    claves.rankPue(a.puesto),
    claves.rankMun(a.municipio),
    claves.rankDep(),
    claves.evMun(a.municipio),
    claves.evDep(),
    claves.pubMun(a.municipio),
    claves.pubDep(),
    claves.colaVerif(),
  ];
}

export interface OpcionesScript {
  tsRecibido: number;
  origen: Origen;
  /** motivo de la corrección (va al campo `motivo` del evento) */
  motivo?: string;
}

/** Ejecuta aplicar_acta.lua y devuelve la respuesta de la tabla 4.3. Lanza si Redis falla. */
export async function ejecutarAplicarActa(redis: Redis, acta: Acta, op: OpcionesScript): Promise<RespuestaPostActa> {
  const keys = clavesDe(acta);
  const argv = [
    JSON.stringify(acta),
    String(op.tsRecibido),
    op.origen,
    op.motivo ?? '',
    JSON.stringify(CANDIDATOS),
    String(TTL.idemSeg),
    String(MAXLEN.evMun),
    String(MAXLEN.evDep),
  ];
  const correr = async (s: string) => (await redis.evalsha(s, keys.length, ...keys, ...argv)) as string;
  let salida: string;
  try {
    salida = await correr(sha ?? (await cargar(redis)));
  } catch (e) {
    if (!String((e as Error).message).includes('NOSCRIPT')) throw e;
    salida = await correr(await cargar(redis));
  }
  return JSON.parse(salida) as RespuestaPostActa;
}
