/**
 * Envoltorio de lua/bloqueos.lua — DUEÑO: Persona 3 (RF-7).
 * SCRIPT LOAD una vez por cliente y EVALSHA; si Redis responde NOSCRIPT (reinicio o
 * SCRIPT FLUSH) se vuelve a cargar y se reintenta una vez. Todas las funciones lanzan si
 * Redis falla: quien llama decide (el WebSocket responde "redis_caido").
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Redis } from 'ioredis';
import { claves } from '../../compartido/claves.js';
import type { Presencia } from '../../compartido/contratos.js';

const RUTA_LUA = path.resolve(process.cwd(), 'lua/bloqueos.lua');
let fuente: string | undefined;
const shaPorCliente = new WeakMap<Redis, string>();

async function cargar(redis: Redis): Promise<string> {
  fuente ??= readFileSync(RUTA_LUA, 'utf8');
  const sha = (await redis.script('LOAD', fuente)) as string;
  shaPorCliente.set(redis, sha);
  return sha;
}

async function ejecutar(redis: Redis, keys: string[], argv: Array<string | number>): Promise<unknown> {
  const correr = (sha: string) => redis.evalsha(sha, keys.length, ...keys, ...argv.map(String));
  try {
    return await correr(shaPorCliente.get(redis) ?? (await cargar(redis)));
  } catch (e) {
    if (!String((e as Error).message).includes('NOSCRIPT')) throw e;
    return correr(await cargar(redis));
  }
}

/** Valor del lock: "{auditor}:{token}". */
export function valorLock(auditor: string, token: string): string {
  return `${auditor}:${token}`;
}

/** Auditor dueño de un valor de lock (los ids de auditor no llevan ":"). */
export function duenoDe(valor: string | null | undefined): string | null {
  if (!valor) return null;
  const i = valor.indexOf(':');
  return i < 0 ? valor : valor.slice(0, i);
}

export type ResultadoTomar =
  | { ok: true }
  | { ok: false; motivo: 'ya_tomado'; dueno: string | null }
  | { ok: false; motivo: 'no_en_cola'; dueno: null };

export interface OpcionesTomar {
  acta: string;
  auditor: string;
  valor: string;
  /** Lo que queda en pres:{auditor} si se logra el lock. */
  presencia: Presencia;
  ttlMs: number;
  presSeg: number;
  ahora?: number;
}

/** SET lock NX PX ttl; si lo logra, pres:{auditor} = presencia (EX presSeg) y ZADD pres:idx. */
export async function tomarLock(redis: Redis, o: OpcionesTomar): Promise<ResultadoTomar> {
  const ahora = o.ahora ?? Date.now();
  const [codigo, valor] = (await ejecutar(
    redis,
    [claves.lock(o.acta), claves.pres(o.auditor), claves.presIdx(), claves.colaVerif()],
    ['tomar', o.valor, o.ttlMs, JSON.stringify(o.presencia), o.presSeg, ahora, o.auditor, o.acta],
  )) as [number, string];
  if (codigo === 1) return { ok: true };
  if (codigo === -1) return { ok: false, motivo: 'no_en_cola', dueno: null };
  return { ok: false, motivo: 'ya_tomado', dueno: duenoDe(valor) };
}

/** PEXPIRE ttl solo si el lock sigue siendo de `valor`. */
export async function renovarLock(redis: Redis, acta: string, valor: string, ttlMs: number): Promise<boolean> {
  return (await ejecutar(redis, [claves.lock(acta)], ['renovar', valor, ttlMs])) === 1;
}

/** DEL solo si el lock sigue siendo de `valor`. */
export async function liberarLock(redis: Redis, acta: string, valor: string): Promise<'ok' | 'no_eres_dueno'> {
  return (await ejecutar(redis, [claves.lock(acta)], ['liberar', valor])) as 'ok' | 'no_eres_dueno';
}
