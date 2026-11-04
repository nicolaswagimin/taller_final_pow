/**
 * Catálogo sintético determinista — DUEÑO: Persona 1.
 * 40 municipios, 1.842 puestos y 6.400 mesas, repartidos de forma desigual (ley de potencia:
 * unos pocos municipios grandes concentran la mayoría). Lo usan semilla.ts, simulador.ts y las pruebas.
 *
 * Numeración: municipios 1..40, puestos 1..1842 y mesas 1..6400 (globales y consecutivos).
 * Id de acta: E14-{puesto}-{número de mesa dentro del puesto, 4 dígitos}-{corporación}.
 */
export const TOTAL_MUNICIPIOS = 40;
export const TOTAL_PUESTOS = 1842;
export const TOTAL_MESAS = 6400;
export const CORPORACION = '03';
const EXPONENTE = 1.3;
const SEMILLA = 20261103;

export interface MesaCatalogo {
  mesa: number;
  /** número de la mesa dentro de su puesto (1..n) */
  numero: number;
  puesto: number;
  municipio: number;
  acta: string;
}
export interface PuestoCatalogo {
  id: number;
  municipio: number;
  mesas: MesaCatalogo[];
}
export interface MunicipioCatalogo {
  id: number;
  /** número de mesas del municipio */
  mesas: number;
  puestos: PuestoCatalogo[];
}
export interface Catalogo {
  municipios: MunicipioCatalogo[];
  mesas: MesaCatalogo[];
}

export function idActa(puesto: number, numero: number): string {
  return `E14-${puesto}-${String(numero).padStart(4, '0')}-${CORPORACION}`;
}

/** PRNG determinista (mulberry32). */
export function prng(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Reparte `total` en partes proporcionales a `pesos`, con un mínimo por parte (resto mayor). */
function repartir(total: number, pesos: number[], minimo: number[]): number[] {
  const base = minimo.slice();
  const resto = total - base.reduce((a, b) => a + b, 0);
  if (resto < 0) throw new Error('mínimos mayores que el total');
  const sumaPesos = pesos.reduce((a, b) => a + b, 0);
  const ideal = pesos.map((p) => (resto * p) / sumaPesos);
  const piso = ideal.map(Math.floor);
  let faltan = resto - piso.reduce((a, b) => a + b, 0);
  const orden = ideal.map((v, i) => [v - piso[i]!, i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of orden) {
    if (faltan-- <= 0) break;
    piso[i]!++;
  }
  return base.map((b, i) => b + piso[i]!);
}

let cache: Catalogo | undefined;

export function generarCatalogo(): Catalogo {
  if (cache) return structuredClone(cache);
  const azar = prng(SEMILLA);
  const pesos = Array.from({ length: TOTAL_MUNICIPIOS }, (_, i) => 1 / (i + 1) ** EXPONENTE);
  const puestosPorMun = repartir(TOTAL_PUESTOS, pesos, pesos.map(() => 1));
  const mesasPorMun = repartir(TOTAL_MESAS, pesos, puestosPorMun);

  const municipios: MunicipioCatalogo[] = [];
  const mesas: MesaCatalogo[] = [];
  let siguientePuesto = 1;
  let siguienteMesa = 1;
  for (let i = 0; i < TOTAL_MUNICIPIOS; i++) {
    const municipio = i + 1;
    const nPuestos = puestosPorMun[i]!;
    // Dentro del municipio, puestos de tamaño variable (pesos aleatorios deterministas).
    const pesosPuesto = Array.from({ length: nPuestos }, () => 0.3 + azar());
    const mesasPorPuesto = repartir(mesasPorMun[i]!, pesosPuesto, pesosPuesto.map(() => 1));
    const puestos: PuestoCatalogo[] = [];
    for (let j = 0; j < nPuestos; j++) {
      const puesto = siguientePuesto++;
      const lista: MesaCatalogo[] = [];
      for (let n = 1; n <= mesasPorPuesto[j]!; n++) {
        const m: MesaCatalogo = { mesa: siguienteMesa++, numero: n, puesto, municipio, acta: idActa(puesto, n) };
        lista.push(m);
        mesas.push(m);
      }
      puestos.push({ id: puesto, municipio, mesas: lista });
    }
    municipios.push({ id: municipio, mesas: mesasPorMun[i]!, puestos });
  }
  cache = { municipios, mesas };
  return structuredClone(cache);
}
