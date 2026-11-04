/**
 * aplicarActa — DUEÑO: Persona 1. Único punto de escritura de acumulados (sección 4.7).
 * La usan POST /api/actas (origen "jurado") y la Persona 3 al aprobar una dudosa (origen "auditor").
 */
import { randomBytes } from 'node:crypto';
import { claves } from '../../compartido/claves.js';
import type { Ctx } from '../../compartido/contexto.js';
import {
  CANDIDATOS,
  HTTP_POR_ESTADO,
  type Acta,
  type RespuestaPostActa,
  type Votos,
} from '../../compartido/contratos.js';
import { ejecutarAplicarActa, type Origen } from './script.js';

export type { Origen } from './script.js';

export interface ResultadoAplicar {
  http: number;
  respuesta: RespuestaPostActa;
}

// --- Métricas: latencia del Lua (últimas 1.000 ejecuciones) y actas por minuto (ventana deslizante 60 s) ---
const NOMBRE_METRICA: Record<RespuestaPostActa['estado'], string> = {
  registrada: 'actas_registradas',
  duplicada: 'actas_duplicadas',
  obsoleta: 'actas_obsoletas',
  dudosa: 'actas_dudosas',
  invalida: 'actas_invalidas',
  limite: 'actas_limite',
  no_disponible: 'actas_no_disponible',
};
const latencias: number[] = [];
const porSegundo = new Map<number, number>();

function registrarMetricas(ctx: Ctx, estado: RespuestaPostActa['estado'], ms: number | null): void {
  ctx.metricas.incrementar(NOMBRE_METRICA[estado]);
  if (ms !== null) {
    latencias.push(ms);
    if (latencias.length > 1000) latencias.shift();
    const s = Math.floor(Date.now() / 1000);
    porSegundo.set(s, (porSegundo.get(s) ?? 0) + 1);
  }
  publicarMetricas(ctx);
}

function percentil(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const orden = [...xs].sort((a, b) => a - b);
  return orden[Math.min(orden.length - 1, Math.floor((p / 100) * orden.length))]!;
}

/** Recalcula actas_por_min y lua_p50/p99_ms. montarJurados lo llama cada 2 s. */
/** Para la ruta: cuenta 400/429 que no llegan a aplicarActa. */
export function contarRechazo(ctx: Ctx, estado: 'invalida' | 'limite' | 'no_disponible'): void {
  ctx.metricas.incrementar(NOMBRE_METRICA[estado]);
}

export function publicarMetricas(ctx: Ctx): void {
  const ahora = Math.floor(Date.now() / 1000);
  let enMinuto = 0;
  for (const [s, n] of porSegundo) {
    if (s <= ahora - 60) porSegundo.delete(s);
    else enMinuto += n;
  }
  ctx.metricas.registrar('actas_por_min', enMinuto);
  ctx.metricas.registrar('lua_p50_ms', percentil(latencias, 50).toFixed(2));
  ctx.metricas.registrar('lua_p99_ms', percentil(latencias, 99).toFixed(2));
}

/**
 * Aplica un acta con lua/aplicar_acta.lua. Nunca lanza por Redis: si no responde devuelve
 * `{ http: 503, respuesta: { estado: 'no_disponible' } }` (RF-10a).
 * @param motivo  motivo de la corrección (va al evento); p. ej. "aprobada por AUD-001".
 */
export async function aplicarActa(ctx: Ctx, acta: Acta, origen: Origen, motivo = ''): Promise<ResultadoAplicar> {
  const t0 = performance.now();
  let respuesta: RespuestaPostActa;
  try {
    respuesta = await ejecutarAplicarActa(ctx.redis, acta, { tsRecibido: Date.now(), origen, motivo });
  } catch {
    respuesta = { estado: 'no_disponible' };
    registrarMetricas(ctx, respuesta.estado, null);
    return { http: HTTP_POR_ESTADO.no_disponible, respuesta };
  }
  registrarMetricas(ctx, respuesta.estado, performance.now() - t0);
  return { http: HTTP_POR_ESTADO[respuesta.estado], respuesta };
}

export function generarIdem(): string {
  return randomBytes(8).toString('hex');
}

/**
 * Para la Persona 3: arma la versión siguiente de un acta ya registrada con los votos corregidos
 * por el auditor y un idem nuevo. `sufragantes` por defecto es el del acta vigente.
 */
export async function nuevaVersionDesde(
  ctx: Ctx,
  actaId: string,
  votos: Votos,
  opciones: { sufragantes?: number; jurado?: string } = {},
): Promise<Acta> {
  const h = await ctx.redis.hgetall(claves.acta(actaId));
  if (!h.version) throw new Error(`el acta ${actaId} no existe`);
  return {
    acta: actaId,
    mesa: Number(h.mesa),
    puesto: Number(h.puesto),
    municipio: Number(h.municipio),
    version: Number(h.version) + 1,
    jurado: opciones.jurado ?? h.jurado ?? '',
    ts_cierre: Math.floor(Date.now() / 1000),
    votos: Object.fromEntries(CANDIDATOS.map((c) => [c, votos[c]])) as Votos,
    sufragantes: opciones.sufragantes ?? Number(h.sufragantes),
    hash_foto: 'auditor',
    idem: generarIdem(),
  };
}
