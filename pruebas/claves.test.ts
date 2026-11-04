import { describe, expect, it } from 'vitest';
import { claves } from '../compartido/claves.js';

// Claves exactas de la tabla 4.4 de docs/DISEÑO.md.
describe('claves de Redis (tabla 4.4)', () => {
  const casos: Array<[string, string]> = [
    [claves.catMesa(4201), 'cat:mesa:4201'],
    [claves.catTotalDep(), 'cat:total:dep'],
    [claves.catTotalMun(11), 'cat:total:mun:11'],
    [claves.catTotalPue(176), 'cat:total:pue:176'],
    [claves.idem('8f14e45fceea167a'), 'idem:8f14e45fceea167a'],
    [claves.acta('E14-176-0042-03'), 'acta:E14-176-0042-03'],
    [claves.totDep(), 'tot:dep'],
    [claves.totMun(11), 'tot:mun:11'],
    [claves.totPue(176), 'tot:pue:176'],
    [claves.totMesa(4201), 'tot:mesa:4201'],
    [claves.rankDep(), 'rank:dep'],
    [claves.rankMun(11), 'rank:mun:11'],
    [claves.rankPue(176), 'rank:pue:176'],
    [claves.evDep(), 'ev:dep'],
    [claves.evMun(11), 'ev:mun:11'],
    [claves.pubMun(11), 'pub:mun:11'],
    [claves.pubDep(), 'pub:dep'],
    [claves.colaVerif(), 'cola:verif'],
    [claves.lock('E14-176-0042-03'), 'lock:acta:E14-176-0042-03'],
    [claves.pubVerif(), 'pub:verif'],
    [claves.pres('AUD-001'), 'pres:AUD-001'],
    [claves.presIdx(), 'pres:idx'],
    [claves.rl('JUR-88134', 29893000), 'rl:JUR-88134:29893000'],
    [claves.met('app-1'), 'met:app-1'],
    [claves.metIdx(), 'met:idx'],
  ];

  it.each(casos)('%s', (obtenida, esperada) => {
    expect(obtenida).toBe(esperada);
  });

  it('cubre todas las funciones de claves', () => {
    expect(casos.length).toBe(Object.keys(claves).length);
  });
});
