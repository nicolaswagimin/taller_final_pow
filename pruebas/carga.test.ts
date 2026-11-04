import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  calcularTiempoReconexion,
  ejecutarComparacionJitter,
  guardarResultadosJitter,
  seleccionarTopicoDesigual,
} from '../carga/carga.js';

describe('Paso 9: Herramientas de Carga y Simulación', () => {
  it('seleccionarTopicoDesigual genera tópicos válidos con distribución desigual', () => {
    const topicos: string[] = [];
    for (let i = 0; i < 500; i++) {
      topicos.push(seleccionarTopicoDesigual());
    }

    expect(topicos.every((t) => t === 'dep' || t.startsWith('mun:'))).toBe(true);

    // Debe contener dep y municipios principales
    expect(topicos.some((t) => t === 'dep')).toBe(true);
    expect(topicos.some((t) => t === 'mun:11' || t === 'mun:12' || t === 'mun:13')).toBe(true);
  });

  it('calcularTiempoReconexion respeta los límites de backoff con y sin jitter', () => {
    // Sin jitter: intento 1 = 2000 ms, intento 2 = 4000 ms, intento 5 = 30000 ms (tope)
    expect(calcularTiempoReconexion(1, false)).toBe(2000);
    expect(calcularTiempoReconexion(2, false)).toBe(4000);
    expect(calcularTiempoReconexion(5, false)).toBe(30000);
    expect(calcularTiempoReconexion(10, false)).toBe(30000);

    // Con full jitter: debe estar acotado entre 0 y el máximo correspondiente
    for (let i = 0; i < 50; i++) {
      const conJitter = calcularTiempoReconexion(2, true);
      expect(conJitter).toBeGreaterThanOrEqual(0);
      expect(conJitter).toBeLessThanOrEqual(4000);
    }
  });

  it('ejecutarComparacionJitter y guardarResultadosJitter exportan CSV y HTML válidos', async () => {
    const filas = await ejecutarComparacionJitter('http://localhost:3000', 500, 10);
    expect(filas.length).toBe(10);

    const dirTmp = path.resolve(process.cwd(), 'carga', 'resultados');
    const { rutaCsv, rutaHtml } = guardarResultadosJitter(filas, dirTmp);

    expect(fs.existsSync(rutaCsv)).toBe(true);
    expect(fs.existsSync(rutaHtml)).toBe(true);

    const csvContent = fs.readFileSync(rutaCsv, 'utf-8');
    expect(csvContent).toContain('segundo,recon_sin_jitter,recon_con_jitter');

    const htmlContent = fs.readFileSync(rutaHtml, 'utf-8');
    expect(htmlContent).toContain('Tormenta de Reconexiones (RF-10b)');
  });
});
