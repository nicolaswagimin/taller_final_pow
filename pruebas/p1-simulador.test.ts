// Persona 1 — plan del simulador de jornada (sección 7). Sin Redis: solo el plan.
import { describe, expect, it } from 'vitest';
import { CANDIDATOS } from '../compartido/contratos.js';
import { DURACION_JORNADA_S, planificar } from '../scripts/simulador.js';

describe('planificar (simulador de jornada)', () => {
  const plan = planificar({ semilla: 7 });
  const envios = plan.envios;
  const originales = envios.filter((e) => e.tipo === 'original');
  const unicos = envios.filter((e) => e.tipo !== 'reenvio');

  it('es determinista para una misma semilla', () => {
    expect(planificar({ semilla: 7 })).toEqual(plan);
    expect(planificar({ semilla: 8 }).envios).not.toEqual(envios);
  });

  it('una versión 1 por mesa (6.400)', () => {
    expect(originales).toHaveLength(6400);
    expect(new Set(originales.map((e) => e.acta.mesa)).size).toBe(6400);
  });

  it('55 % de las actas en el primer tercio de la jornada', () => {
    const primerTercio = originales.filter((e) => e.t < DURACION_JORNADA_S / 3).length / originales.length;
    expect(primerTercio).toBeCloseTo(0.55, 2);
  });

  it('ráfagas de 300 envíos', () => {
    expect(plan.rafagas.every((r) => r.envios.length <= 300)).toBe(true);
    expect(plan.rafagas.slice(0, -1).every((r) => r.envios.length === 300)).toBe(true);
    expect(plan.rafagas.flatMap((r) => r.envios)).toHaveLength(envios.length);
  });

  it('entre 4 % y 11 % de reenvíos con el mismo idem', () => {
    const reenvios = envios.filter((e) => e.tipo === 'reenvio');
    const p = reenvios.length / unicos.length;
    expect(p).toBeGreaterThanOrEqual(0.04);
    expect(p).toBeLessThanOrEqual(0.11);
    const idems = new Set(unicos.map((e) => e.acta.idem));
    expect(reenvios.every((e) => idems.has(e.acta.idem))).toBe(true);
  });

  it('~180 correcciones, con versiones fuera de orden', () => {
    const corr = envios.filter((e) => e.tipo === 'correccion');
    expect(corr.length).toBeGreaterThanOrEqual(170);
    expect(corr.length).toBeLessThanOrEqual(190);
    // fuera de orden: alguna mesa recibe una versión menor después de una mayor
    const porMesa = new Map<number, number[]>();
    for (const e of [...unicos].sort((a, b) => a.t - b.t)) {
      porMesa.set(e.acta.mesa, [...(porMesa.get(e.acta.mesa) ?? []), e.acta.version]);
    }
    const desordenadas = [...porMesa.values()].filter((vs) => vs.some((v, i) => i > 0 && v < vs[i - 1]!));
    expect(desordenadas.length).toBeGreaterThan(30);
  });

  it('entre 6 % y 9 % de dudosas', () => {
    const dud = originales.filter((e) => CANDIDATOS.reduce((a, c) => a + e.acta.votos[c], 0) !== e.acta.sufragantes);
    const p = dud.length / originales.length;
    expect(p).toBeGreaterThanOrEqual(0.06);
    expect(p).toBeLessThanOrEqual(0.09);
  });

  it('el total esperado solo cuenta, por mesa, la versión mayor si cuadra', () => {
    let informadas = 0;
    const tot = Object.fromEntries(CANDIDATOS.map((c) => [c, 0]));
    const mayor = new Map<number, (typeof unicos)[number]['acta']>();
    for (const e of unicos) if ((mayor.get(e.acta.mesa)?.version ?? 0) < e.acta.version) mayor.set(e.acta.mesa, e.acta);
    for (const a of mayor.values()) {
      if (CANDIDATOS.reduce((s, c) => s + a.votos[c], 0) !== a.sufragantes) continue;
      informadas++;
      for (const c of CANDIDATOS) tot[c]! += a.votos[c];
    }
    expect(plan.esperado).toEqual({ ...tot, _informadas: informadas });
  });
});
