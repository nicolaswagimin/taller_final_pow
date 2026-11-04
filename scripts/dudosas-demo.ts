/**
 * Actas dudosas de demostración — Persona 3. Sirve para probar la consola de auditores sin
 * depender del módulo de la Persona 1.
 *
 *   npx tsx scripts/dudosas-demo.ts            # 10 actas
 *   npx tsx scripts/dudosas-demo.ts 25         # 25 actas
 *   REDIS_URL=redis://localhost:6379 npx tsx scripts/dudosas-demo.ts
 *
 * Escribe exactamente lo que dejaría aplicar_acta.lua para un acta que no cuadra (4.4/4.5):
 * acta:{acta} con estado=dudosa y ZADD cola:verif {descuadre} {acta}. Si la mesa no está en el
 * catálogo (no se corrió `npm run semilla`) crea cat:mesa:{mesa} para que, al aprobar, el
 * aplicar_acta de la Persona 1 la acepte. Es idempotente: cada corrida primero borra las
 * dudosas de demo anteriores (números de mesa 9001+ dentro del puesto) y sus locks.
 */
import { pathToFileURL } from 'node:url';
import { Redis } from 'ioredis';
import { claves } from '../compartido/claves.js';
import { CANDIDATOS, type Votos } from '../compartido/contratos.js';

const PREFIJO_DEMO = 9000; // número de mesa dentro del puesto: fuera del catálogo real (≤ 4 cifras)

export interface DudosaDemo {
  acta: string;
  mesa: number;
  puesto: number;
  municipio: number;
  votos: Votos;
  sufragantes: number;
  descuadre: number;
}

/** PRNG determinista para que la demo siempre muestre los mismos números. */
function prng(semilla: number): () => number {
  let s = semilla >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

async function borrarDemoAnteriores(redis: Redis): Promise<number> {
  let cursor = '0';
  let borradas = 0;
  do {
    const [sig, ks] = await redis.scan(cursor, 'MATCH', 'acta:E14-*-9???-*', 'COUNT', 1000);
    cursor = sig;
    for (const k of ks) {
      const acta = k.slice('acta:'.length);
      await redis.multi().del(k).zrem(claves.colaVerif(), acta).del(claves.lock(acta)).exec();
      borradas++;
    }
  } while (cursor !== '0');
  return borradas;
}

export async function sembrarDudosas(redis: Redis, n = 10): Promise<DudosaDemo[]> {
  await borrarDemoAnteriores(redis);
  const azar = prng(2026);
  const salida: DudosaDemo[] = [];
  for (let i = 1; i <= n; i++) {
    const mesa = i;
    let [puesto, municipio] = (await redis.hmget(claves.catMesa(mesa), 'puesto', 'municipio')).map(Number);
    if (!puesto || !municipio) {
      puesto = 1;
      municipio = 1;
      await redis.hset(claves.catMesa(mesa), { puesto, municipio });
    }
    const votos = Object.fromEntries(CANDIDATOS.map((c) => [c, 0])) as Votos;
    votos.C1 = 80 + Math.floor(azar() * 220);
    votos.C2 = 60 + Math.floor(azar() * 200);
    votos.C3 = 40 + Math.floor(azar() * 260);
    votos.BLANCO = Math.floor(azar() * 25);
    votos.NULO = Math.floor(azar() * 12);
    votos.NO_MARCADO = Math.floor(azar() * 8);
    const suma = CANDIDATOS.reduce((a, c) => a + votos[c], 0);
    // Descuadres variados (1 a 40 votos, en ambos sentidos) para que la prioridad ordene la cola.
    const descuadre = 1 + Math.floor(azar() * 40);
    const sufragantes = azar() < 0.5 ? suma + descuadre : Math.max(0, suma - descuadre);
    const acta = `E14-${puesto}-${PREFIJO_DEMO + i}-03`;
    const motivo = `descuadre: suma(votos)=${suma} sufragantes=${sufragantes}`;
    const respuesta = { estado: 'dudosa', acta, version: 1, motivo };
    await redis
      .multi()
      .hset(claves.acta(acta), {
        version: 1,
        estado: 'dudosa',
        votos: JSON.stringify(votos),
        mesa,
        puesto,
        municipio,
        jurado: `JUR-DEMO-${String(i).padStart(3, '0')}`,
        motivo,
        sufragantes,
        origen: 'jurado',
        respuesta: JSON.stringify(respuesta),
      })
      .zadd(claves.colaVerif(), Math.abs(suma - sufragantes), acta)
      .exec();
    salida.push({ acta, mesa, puesto, municipio, votos, sufragantes, descuadre: Math.abs(suma - sufragantes) });
  }
  return salida;
}

// Ejecución directa (no al importarlo desde las pruebas).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const n = Number(process.argv[2] ?? 10);
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  sembrarDudosas(redis, Number.isFinite(n) && n > 0 ? n : 10)
    .then((actas) => {
      for (const a of actas) console.log(`${a.acta}  descuadre ${a.descuadre}`);
      console.log(`${actas.length} actas dudosas en ${claves.colaVerif()}`);
    })
    .catch((e: unknown) => {
      console.error('No se pudo sembrar:', (e as Error).message);
      process.exitCode = 1;
    })
    .finally(() => void redis.quit());
}
