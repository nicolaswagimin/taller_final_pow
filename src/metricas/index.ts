/**
 * Métricas por instancia (sección 7) — Persona 3.
 *
 * Cada módulo reporta con:
 *   metricas.registrar('nombre', valor)   // valor instantáneo (gauge)
 *   metricas.incrementar('nombre', n?)    // contador acumulado
 *   metricas.conexionAbierta('sse') / metricas.conexionCerrada('sse')
 *
 * Cada 2 s se escribe HASH met:{instancia} (EX 10) y se agrega la instancia a met:idx.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Express } from 'express';
import type { Redis } from 'ioredis';
import { claves, TTL } from '../../compartido/claves.js';

export type TipoConexion = 'sse' | 'ws' | 'polling';

const INTERVALO_MS = 2_000;
/** Resolución del muestreo del Event Loop; el histograma la incluye, así que se resta. */
const ELD_RESOLUCION_MS = 10;

export interface Metricas {
  registrar(nombre: string, valor: number | string): void;
  incrementar(nombre: string, n?: number): void;
  conexionAbierta(tipo: TipoConexion): void;
  conexionCerrada(tipo: TipoConexion): void;
  /** Foto actual de esta instancia (lo que se escribe en met:{instancia}). */
  foto(): Record<string, string>;
  iniciar(redis: Redis, instancia: string): void;
  detener(): void;
}

function crearMetricas(): Metricas {
  const valores = new Map<string, number | string>();
  const contadores = new Map<string, number>();
  const conexiones: Record<TipoConexion, number> = { sse: 0, ws: 0, polling: 0 };
  const eld = monitorEventLoopDelay({ resolution: ELD_RESOLUCION_MS });
  let temporizador: NodeJS.Timeout | undefined;
  let redisRef: Redis | undefined;
  let instanciaRef = 'desconocida';
  const nsAms = (ns: number) =>
    Number.isFinite(ns) ? Math.max(0, ns / 1e6 - ELD_RESOLUCION_MS).toFixed(2) : '0';

  const m: Metricas = {
    registrar(nombre, valor) {
      valores.set(nombre, valor);
    },
    incrementar(nombre, n = 1) {
      contadores.set(nombre, (contadores.get(nombre) ?? 0) + n);
    },
    conexionAbierta(tipo) {
      conexiones[tipo]++;
    },
    conexionCerrada(tipo) {
      conexiones[tipo] = Math.max(0, conexiones[tipo] - 1);
    },
    foto() {
      const rss = process.memoryUsage().rss;
      const totalCon = conexiones.sse + conexiones.ws + conexiones.polling;
      const salida: Record<string, string> = {
        instancia: instanciaRef,
        ts: String(Date.now()),
        uptime_s: process.uptime().toFixed(0),
        con_sse: String(conexiones.sse),
        con_ws: String(conexiones.ws),
        con_polling: String(conexiones.polling),
        con_total: String(totalCon),
        rss_mb: (rss / 1_048_576).toFixed(1),
        rss_por_conexion_kb: totalCon > 0 ? (rss / totalCon / 1024).toFixed(1) : '0',
        eld_p50_ms: nsAms(eld.percentile(50)),
        eld_p99_ms: nsAms(eld.percentile(99)),
        eld_max_ms: nsAms(eld.max),
      };
      for (const [k, v] of contadores) salida[k] = String(v);
      for (const [k, v] of valores) salida[k] = String(v);
      return salida;
    },
    iniciar(redis, instancia) {
      redisRef = redis;
      instanciaRef = instancia;
      eld.enable();
      temporizador = setInterval(() => void escribir(), INTERVALO_MS);
      temporizador.unref();
    },
    detener() {
      if (temporizador) clearInterval(temporizador);
      eld.disable();
    },
  };

  async function escribir(): Promise<void> {
    if (!redisRef || redisRef.status !== 'ready') return;
    const datos = m.foto();
    eld.reset(); // cada ventana de 2 s mide su propio p50/p99/máx
    const clave = claves.met(instanciaRef);
    try {
      await redisRef
        .multi()
        .del(clave)
        .hset(clave, datos)
        .expire(clave, TTL.metSeg)
        .sadd(claves.metIdx(), instanciaRef)
        .exec();
    } catch {
      // Redis caído: se reintenta en el próximo tick.
    }
  }

  return m;
}

export const metricas: Metricas = crearMetricas();

/** GET /api/metricas → métricas de todas las instancias vivas (leídas de Redis). */
export function montarMetricas(app: Express, redis: Redis): void {
  app.get('/api/metricas', async (_req, res) => {
    try {
      const instancias = (await redis.smembers(claves.metIdx())).sort();
      const pipe = redis.pipeline();
      for (const i of instancias) pipe.hgetall(claves.met(i));
      const resultados = (await pipe.exec()) ?? [];
      const vivas: Record<string, Record<string, string>> = {};
      const muertas: string[] = [];
      instancias.forEach((inst, idx) => {
        const [err, h] = resultados[idx] ?? [];
        const hash = h as Record<string, string> | undefined;
        if (!err && hash && Object.keys(hash).length > 0) vivas[inst] = hash;
        else muertas.push(inst);
      });
      // Las instancias cuyo met:{i} expiró (EX 10) se limpian del índice.
      if (muertas.length > 0) await redis.srem(claves.metIdx(), ...muertas);
      res.json({ ts: Date.now(), instancias: vivas });
    } catch {
      res.status(503).json({ estado: 'no_disponible' });
    }
  });
}
