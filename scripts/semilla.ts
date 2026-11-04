/**
 * semilla.ts — DUEÑO: Persona 1.  `npm run semilla`
 * Carga el catálogo sintético en Redis: cat:mesa:{mesa} (HASH puesto, municipio) y
 * cat:total:dep | cat:total:mun:{m} | cat:total:pue:{p} (número de mesas del nivel).
 * Idempotente: solo sobrescribe el catálogo con los mismos valores; no toca acumulados.
 */
import { pathToFileURL } from 'node:url';
import { Redis } from 'ioredis';
import { claves } from '../compartido/claves.js';
import { generarCatalogo } from './catalogo.js';

const LOTE = 1000;

export async function sembrar(redis: Redis): Promise<{ mesas: number; puestos: number; municipios: number }> {
  const cat = generarCatalogo();
  const ops: Array<(p: ReturnType<Redis['pipeline']>) => void> = [];

  for (const m of cat.mesas) {
    ops.push((p) => p.del(claves.catMesa(m.mesa)).hset(claves.catMesa(m.mesa), { puesto: m.puesto, municipio: m.municipio }));
  }
  let puestos = 0;
  for (const mun of cat.municipios) {
    ops.push((p) => p.set(claves.catTotalMun(mun.id), mun.mesas));
    for (const pue of mun.puestos) {
      puestos++;
      ops.push((p) => p.set(claves.catTotalPue(pue.id), pue.mesas.length));
    }
  }
  ops.push((p) => p.set(claves.catTotalDep(), cat.mesas.length));

  for (let i = 0; i < ops.length; i += LOTE) {
    const pipe = redis.pipeline();
    for (const op of ops.slice(i, i + LOTE)) op(pipe);
    const res = await pipe.exec();
    const err = res?.find(([e]) => e);
    if (err) throw err[0];
  }
  return { mesas: cat.mesas.length, puestos, municipios: cat.municipios.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const redis = new Redis(url, { maxRetriesPerRequest: 2 });
  try {
    const r = await sembrar(redis);
    console.log(`semilla OK en ${url}: ${r.municipios} municipios, ${r.puestos} puestos, ${r.mesas} mesas`);
  } catch (e) {
    console.error('semilla falló:', (e as Error).message);
    process.exitCode = 1;
  } finally {
    redis.disconnect();
  }
}
