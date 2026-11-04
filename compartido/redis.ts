import { Redis, type RedisOptions } from 'ioredis';

/**
 * Clientes Redis compartidos (RF-10a): sin cola offline y con timeout de 500 ms,
 * para que una caída de Redis se traduzca en error inmediato (503) y no en peticiones colgadas.
 */
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

const opciones: RedisOptions = {
  enableOfflineQueue: false,
  commandTimeout: 500,
  maxRetriesPerRequest: 1,
  // Reconexión automática con backoff acotado (máx. 2 s).
  retryStrategy: (intento) => Math.min(100 * 2 ** intento, 2_000),
  lazyConnect: false,
};

let listo = false;

function crear(nombre: string, seguirEstado: boolean): Redis {
  const cliente = new Redis(REDIS_URL, { ...opciones, connectionName: nombre });
  if (seguirEstado) {
    cliente.on('ready', () => {
      listo = true;
    });
    cliente.on('close', () => {
      listo = false;
    });
    cliente.on('end', () => {
      listo = false;
    });
  }
  // Sin listener 'error' ioredis imprime "Unhandled error event" en cada reintento.
  let ultimoAviso = 0;
  cliente.on('error', (err) => {
    const ahora = Date.now();
    if (ahora - ultimoAviso > 5_000) {
      ultimoAviso = ahora;
      console.warn(`[redis:${nombre}] ${err.message}`);
    }
  });
  return cliente;
}

/** Cliente para comandos normales. */
export const redis = crear('principal', true);
/** Cliente dedicado a SUBSCRIBE (un cliente suscrito no puede ejecutar otros comandos). */
export const redisSub = crear('suscripcion', false);

/** true si el cliente principal está conectado y listo. */
export function redisDisponible(): boolean {
  return listo && redis.status === 'ready';
}

export async function cerrarRedis(): Promise<void> {
  await Promise.allSettled([redis.quit(), redisSub.quit()]);
}
