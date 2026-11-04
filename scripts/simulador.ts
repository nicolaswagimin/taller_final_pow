/**
 * Simulador de jornada — DUEÑO: Persona 1 (lo usa la Persona 2 en la prueba de carga, sección 7).
 *
 *   npx tsx scripts/simulador.ts [--url http://localhost] [--factor 12] [--semilla 1]
 *                                [--redis redis://localhost:6379] [--json]
 *
 * Jornada de 2 h comprimida por `factor` (12 → 10 min): 55 % de las actas en el primer tercio,
 * ráfagas de 300 envíos concurrentes, 4–11 % de reenvíos con el mismo idem, ~180 correcciones con
 * versiones fuera de orden y 6–9 % de dudosas. Cada envío se reintenta como lo haría el jurado
 * (mismo idem, full jitter) hasta obtener una respuesta definitiva.
 *
 * Al final imprime el total esperado por candidato, calculado localmente: por mesa gana la versión
 * mayor, y solo suma si cuadra. Con --redis compara contra tot:dep.
 */
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CANDIDATOS, type Acta, type Candidato, type EstadoPostActa, type Votos } from '../compartido/contratos.js';
import { generarCatalogo, prng, type MesaCatalogo } from './catalogo.js';

export const DURACION_JORNADA_S = 2 * 60 * 60;
const TAM_RAFAGA = 300;
const MESAS_CON_V3 = 60; // v1 + v2 + v3 → 120 correcciones
const MESAS_SOLO_V2 = 60; // v1 + v2       →  60 correcciones (total 180)

export type TipoEnvio = 'original' | 'correccion' | 'reenvio';
export interface Envio {
  /** segundo de la jornada (0..7200) */
  t: number;
  tipo: TipoEnvio;
  acta: Acta;
}
export interface Rafaga {
  t: number;
  envios: Envio[];
}
export type Totales = Record<Candidato | '_informadas', number>;
export interface Plan {
  envios: Envio[];
  rafagas: Rafaga[];
  esperado: Totales;
  resumen: { mesas: number; dudosas: number; correcciones: number; reenvios: number };
}

const suma = (v: Votos) => CANDIDATOS.reduce((a, c) => a + v[c], 0);

export function planificar({ semilla = 1 }: { semilla?: number } = {}): Plan {
  const azar = prng(semilla);
  const entre = (a: number, b: number) => a + azar() * (b - a);
  const entero = (a: number, b: number) => Math.floor(entre(a, b + 1));
  const barajar = <T>(xs: T[]) => {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(azar() * (i + 1));
      [xs[i], xs[j]] = [xs[j]!, xs[i]!];
    }
    return xs;
  };
  const { mesas, municipios } = generarCatalogo();
  let nIdem = 0;
  const idem = () => `sim${semilla}-${(++nIdem).toString(36).padStart(6, '0')}`;

  // Preferencias por municipio, para que los resultados locales difieran.
  const pref = new Map(municipios.map((m) => [m.id, CANDIDATOS.map((c) => (c.startsWith('C') ? entre(0.5, 1.5) : entre(0.05, 0.15)))]));

  const votosDe = (m: MesaCatalogo): Votos => {
    const pesos = pref.get(m.municipio)!.map((p) => p * entre(0.7, 1.3));
    const total = entero(150, 700);
    const sp = pesos.reduce((a, b) => a + b, 0);
    const v = pesos.map((p) => Math.floor((total * p) / sp));
    v[0]! += total - v.reduce((a, b) => a + b, 0);
    return Object.fromEntries(CANDIDATOS.map((c, i) => [c, v[i]])) as Votos;
  };
  const acta = (m: MesaCatalogo, version: number, votos: Votos, sufragantes = suma(votos)): Acta => ({
    acta: m.acta, mesa: m.mesa, puesto: m.puesto, municipio: m.municipio, version,
    jurado: `JUR-${m.mesa}`, ts_cierre: 1793577600 + entero(0, DURACION_JORNADA_S),
    votos, sufragantes, hash_foto: `sim-${m.mesa}-${version}`, idem: idem(),
  });
  const corregir = (v: Votos): Votos => {
    const c = { ...v };
    const mover = entero(1, 12);
    const de = CANDIDATOS[entero(0, 2)]!;
    const a = CANDIDATOS[(CANDIDATOS.indexOf(de) + 1) % 3]!;
    const n = Math.min(mover, c[de]);
    c[de] -= n;
    c[a] += n;
    return c;
  };

  // --- Tiempos de la versión 1: exactamente 55 % en el primer tercio ---
  const tercio = DURACION_JORNADA_S / 3;
  const enPrimerTercio = Math.round(mesas.length * 0.55);
  const orden = barajar(mesas.map((_, i) => i));
  const tV1 = new Array<number>(mesas.length);
  orden.forEach((idx, k) => (tV1[idx] = k < enPrimerTercio ? entre(0, tercio) : entre(tercio, DURACION_JORNADA_S - 600)));

  // --- Quién es dudosa y quién se corrige (conjuntos disjuntos) ---
  const pDudosa = entre(0.06, 0.09);
  const nDudosas = Math.round(mesas.length * pDudosa);
  const elegidas = barajar(mesas.map((_, i) => i));
  const dudosas = new Set(elegidas.slice(0, nDudosas));
  const conV3 = new Set(elegidas.slice(nDudosas, nDudosas + MESAS_CON_V3));
  const soloV2 = new Set(elegidas.slice(nDudosas + MESAS_CON_V3, nDudosas + MESAS_CON_V3 + MESAS_SOLO_V2));

  const envios: Envio[] = [];
  mesas.forEach((m, i) => {
    const v1 = votosDe(m);
    const t1 = tV1[i]!;
    if (dudosas.has(i)) {
      const desfase = entero(1, 15) * (azar() < 0.5 ? -1 : 1);
      envios.push({ t: t1, tipo: 'original', acta: acta(m, 1, v1, Math.max(0, suma(v1) + desfase)) });
    } else if (conV3.has(i)) {
      // Fuera de orden: v3 llega ANTES que v2 (v2 → obsoleta)
      const v2 = corregir(v1);
      const v3 = corregir(v2);
      envios.push({ t: t1, tipo: 'original', acta: acta(m, 1, v1) });
      envios.push({ t: t1 + entre(60, 300), tipo: 'correccion', acta: acta(m, 3, v3) });
      envios.push({ t: t1 + entre(300, 600), tipo: 'correccion', acta: acta(m, 2, v2) });
    } else if (soloV2.has(i)) {
      const v2 = corregir(v1);
      if (azar() < 0.5) {
        // Fuera de orden: la corrección v2 llega antes que la v1 (v1 → obsoleta)
        envios.push({ t: t1, tipo: 'correccion', acta: acta(m, 2, v2) });
        envios.push({ t: t1 + entre(60, 600), tipo: 'original', acta: acta(m, 1, v1) });
      } else {
        envios.push({ t: t1, tipo: 'original', acta: acta(m, 1, v1) });
        envios.push({ t: t1 + entre(60, 600), tipo: 'correccion', acta: acta(m, 2, v2) });
      }
    } else {
      envios.push({ t: t1, tipo: 'original', acta: acta(m, 1, v1) });
    }
  });

  // --- Reenvíos con el mismo idem (el jurado no supo si llegó) ---
  const unicos = envios.slice();
  const pReenvio = entre(0.04, 0.11);
  const nReenvios = Math.round(unicos.length * pReenvio);
  for (const e of barajar(unicos.slice()).slice(0, nReenvios)) {
    envios.push({ t: Math.min(DURACION_JORNADA_S, e.t + entre(0, 120)), tipo: 'reenvio', acta: { ...e.acta } });
  }
  envios.sort((a, b) => a.t - b.t);

  // --- Ráfagas de 300 ---
  const rafagas: Rafaga[] = [];
  for (let i = 0; i < envios.length; i += TAM_RAFAGA) {
    const lote = envios.slice(i, i + TAM_RAFAGA);
    rafagas.push({ t: lote[0]!.t, envios: lote });
  }

  return {
    envios,
    rafagas,
    esperado: totalEsperado(unicos.map((e) => e.acta)),
    resumen: { mesas: mesas.length, dudosas: nDudosas, correcciones: unicos.filter((e) => e.tipo === 'correccion').length, reenvios: nReenvios },
  };
}

/** Por mesa gana la versión mayor; suma solo si cuadra. */
export function totalEsperado(actas: Acta[]): Totales {
  const mayor = new Map<number, Acta>();
  for (const a of actas) if ((mayor.get(a.mesa)?.version ?? 0) < a.version) mayor.set(a.mesa, a);
  const tot = Object.fromEntries([...CANDIDATOS, '_informadas'].map((c) => [c, 0])) as Totales;
  for (const a of mayor.values()) {
    if (suma(a.votos) !== a.sufragantes) continue;
    tot._informadas++;
    for (const c of CANDIDATOS) tot[c] += a.votos[c];
  }
  return tot;
}

// ---------------------------------------------------------------------------
// Ejecución
// ---------------------------------------------------------------------------

const DEFINITIVOS: EstadoPostActa[] = ['registrada', 'duplicada', 'obsoleta', 'dudosa', 'invalida'];
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function enviar(url: string, a: Acta, intentosMax = 12): Promise<{ estado: EstadoPostActa | 'fallo'; intentos: number }> {
  for (let intento = 0; intento < intentosMax; intento++) {
    try {
      const r = await fetch(`${url}/api/actas`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(a),
        signal: AbortSignal.timeout(15_000),
      });
      const cuerpo = (await r.json().catch(() => ({}))) as { estado?: EstadoPostActa };
      if (cuerpo.estado && DEFINITIVOS.includes(cuerpo.estado)) return { estado: cuerpo.estado, intentos: intento + 1 };
      if (r.status === 429) {
        await dormir(Number(r.headers.get('retry-after') ?? 5) * 1000);
        continue;
      }
    } catch {
      /* red / timeout: no se sabe si llegó → reintento con el mismo idem */
    }
    await dormir(Math.random() * Math.min(30_000, 1000 * 2 ** intento)); // full jitter
  }
  return { estado: 'fallo', intentos: intentosMax };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      url: { type: 'string', default: process.env.URL_BASE ?? 'http://localhost' },
      factor: { type: 'string', default: '12' },
      semilla: { type: 'string', default: '1' },
      redis: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });
  const url = values.url!.replace(/\/$/, '');
  const factor = Number(values.factor);
  if (!(factor > 0)) throw new Error('--factor debe ser > 0');
  const plan = planificar({ semilla: Number(values.semilla) });
  const log = (...xs: unknown[]) => !values.json && console.log(...xs);

  let redis: import('ioredis').Redis | undefined;
  if (values.redis) {
    const { Redis } = await import('ioredis');
    redis = new Redis(values.redis, { maxRetriesPerRequest: 2 });
    if (await redis.exists('tot:dep')) {
      console.warn('AVISO: tot:dep ya tiene datos; la comparación solo vale si la jornada empieza en cero.');
    }
  }

  log(`Simulador → ${url} · factor ×${factor} (jornada de ${(DURACION_JORNADA_S / factor / 60).toFixed(1)} min) · semilla ${values.semilla}`);
  log(`Plan: ${plan.envios.length} envíos en ${plan.rafagas.length} ráfagas de ≤300 · ${plan.resumen.dudosas} dudosas · ` +
      `${plan.resumen.correcciones} correcciones · ${plan.resumen.reenvios} reenvíos`);

  const conteo: Record<string, number> = {};
  const inicio = Date.now();
  const pendientes: Promise<void>[] = [];
  for (const [i, raf] of plan.rafagas.entries()) {
    const espera = inicio + (raf.t / factor) * 1000 - Date.now();
    if (espera > 0) await dormir(espera);
    pendientes.push(
      Promise.all(raf.envios.map(async (e) => {
        const r = await enviar(url, e.acta);
        conteo[r.estado] = (conteo[r.estado] ?? 0) + 1;
      })).then(() => {
        log(`  ráfaga ${String(i + 1).padStart(3)}/${plan.rafagas.length} · t=${(raf.t / 60).toFixed(1).padStart(5)} min de jornada · ${raf.envios.length} envíos`);
      }),
    );
  }
  await Promise.all(pendientes);
  const seg = (Date.now() - inicio) / 1000;

  log(`\nRespuestas (${seg.toFixed(1)} s):`, JSON.stringify(conteo));
  log('\nTotal esperado por candidato (calculado localmente):');
  for (const [c, v] of Object.entries(plan.esperado)) log(`  ${c.padEnd(12)} ${v}`);

  let iguales: boolean | undefined;
  let real: Record<string, number> | undefined;
  if (redis) {
    const h = await redis.hgetall('tot:dep');
    real = Object.fromEntries(Object.keys(plan.esperado).map((k) => [k, Number(h[k] ?? 0)]));
    iguales = Object.keys(plan.esperado).every((k) => real![k] === plan.esperado[k as keyof Totales]);
    log(`\nComparación con tot:dep en ${values.redis}:`);
    for (const k of Object.keys(plan.esperado)) {
      const esp = plan.esperado[k as keyof Totales];
      log(`  ${k.padEnd(12)} esperado ${String(esp).padStart(8)}  redis ${String(real[k]).padStart(8)}  ${esp === real[k] ? 'OK' : 'DIFERENTE'}`);
    }
    log(iguales ? '\nRESULTADO: idénticos' : '\nRESULTADO: DIFERENCIAS');
    redis.disconnect();
  }
  if (values.json) console.log(JSON.stringify({ segundos: seg, respuestas: conteo, esperado: plan.esperado, tot_dep: real, iguales }));
  if (conteo.fallo || iguales === false) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
