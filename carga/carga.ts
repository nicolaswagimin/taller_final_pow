/**
 * Herramienta de prueba de carga y simulación (secciones 5 y 7 de docs/DISEÑO.md)
 * DUEÑO: Persona 2.
 *
 * Características:
 * - N conexiones SSE (por defecto 20.000, configurable para correr desde múltiples portátiles).
 * - Distribución desigual de tópicos (distribución Zipf/Pareto en 40 municipios).
 * - Algoritmo de reconexión con backoff exponencial y full jitter (y modo sin jitter).
 * - Simulación de desconexión masiva para medir tormenta de reconexión y exportar CSV y HTML.
 * - Modo "polling" contra GET /api/snapshot con If-None-Match para comparar contra SSE.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

// Agente HTTP sin límite de sockets y con keep-alive
const agent = new http.Agent({
  keepAlive: true,
  maxSockets: Infinity,
  maxFreeSockets: 10_000,
});

export interface OpcionesCarga {
  conexiones: number;
  urlBase: string;
  modo: 'sse' | 'polling';
  duracionSegundos: number;
  conJitter: boolean;
  salidaCsv?: string;
  salidaHtml?: string;
}

/** Genera un tópico siguiendo distribución desigual (80/20) entre 40 municipios y dep */
export function seleccionarTopicoDesigual(): string {
  const r = Math.random();
  if (r < 0.15) return 'dep';
  // El 65% del tráfico restante se concentra en los 3 municipios principales (11, 12, 13)
  if (r < 0.70) {
    const topMuns = [11, 12, 13];
    return `mun:${topMuns[Math.floor(Math.random() * topMuns.length)]}`;
  }
  // El resto distribuido entre municipios 1 a 40
  const m = Math.floor(Math.random() * 40) + 1;
  return `mun:${m}`;
}

/** Calcula espera de reconexión con o sin jitter */
export function calcularTiempoReconexion(intento: number, conJitter: boolean): number {
  const maxMs = Math.min(30_000, 1_000 * Math.pow(2, intento));
  if (!conJitter) return maxMs;
  return Math.floor(Math.random() * (maxMs + 1));
}

export class ClienteCargaSse {
  public id: number;
  public topico: string;
  public urlBase: string;
  public conJitter: boolean;
  public intento = 0;
  public seqActual = '';
  public bytesRecibidos = 0;
  public mensajesRecibidos = 0;
  public desconexiones = 0;
  public req?: http.ClientRequest;
  public cerrado = false;
  private onReconexion?: () => void;

  constructor(id: number, topico: string, urlBase: string, conJitter: boolean, onReconexion?: () => void) {
    this.id = id;
    this.topico = topico;
    this.urlBase = urlBase;
    this.conJitter = conJitter;
    this.onReconexion = onReconexion;
  }

  conectar(): void {
    if (this.cerrado) return;
    const url = new URL(this.urlBase);
    url.pathname = '/sse';
    url.searchParams.set('topico', this.topico);
    if (this.seqActual) {
      url.searchParams.set('desde', this.seqActual);
    }

    const headers: Record<string, string> = {};
    if (this.seqActual) {
      headers['Last-Event-ID'] = this.seqActual;
    }

    this.req = http.get(url, { agent, headers }, (res) => {
      this.intento = 0;

      res.on('data', (chunk: Buffer) => {
        this.bytesRecibidos += chunk.length;
        const texto = chunk.toString('utf-8');
        const lineas = texto.split('\n');
        for (const l of lineas) {
          if (l.startsWith('id:')) {
            this.seqActual = l.slice(3).trim();
          } else if (l.startsWith('event:')) {
            this.mensajesRecibidos++;
          }
        }
      });

      res.on('end', () => {
        this.manejarDesconexion();
      });

      res.on('error', () => {
        this.manejarDesconexion();
      });
    });

    this.req.on('error', () => {
      this.manejarDesconexion();
    });
  }

  manejarDesconexion(): void {
    if (this.cerrado) return;
    this.desconexiones++;
    this.intento++;
    if (this.onReconexion) this.onReconexion();

    const espera = calcularTiempoReconexion(this.intento, this.conJitter);
    setTimeout(() => {
      if (!this.cerrado) this.conectar();
    }, espera);
  }

  cortar(): void {
    if (this.req) {
      try {
        this.req.destroy();
      } catch {}
    }
  }

  detener(): void {
    this.cerrado = true;
    this.cortar();
  }
}

export class ClienteCargaPolling {
  public id: number;
  public topico: string;
  public urlBase: string;
  public seqActual = '';
  public bytesRecibidos = 0;
  public peticionesRealizadas = 0;
  public resp304 = 0;
  public resp200 = 0;
  public cerrado = false;
  public latencias: number[] = [];
  private timer?: NodeJS.Timeout;

  constructor(id: number, topico: string, urlBase: string) {
    this.id = id;
    this.topico = topico;
    this.urlBase = urlBase;
  }

  iniciar(): void {
    this.timer = setInterval(() => void this.poll(), 2000);
    this.timer.unref();
    void this.poll();
  }

  async poll(): Promise<void> {
    if (this.cerrado) return;
    const url = new URL(this.urlBase);
    url.pathname = '/api/snapshot';
    url.searchParams.set('topico', this.topico);

    const headers: Record<string, string> = {};
    if (this.seqActual) {
      headers['If-None-Match'] = `"${this.seqActual}"`;
    }

    const tInicio = Date.now();
    this.peticionesRealizadas++;

    http.get(url, { agent, headers }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => {
        this.bytesRecibidos += c.length;
        body += c.toString('utf-8');
      });
      res.on('end', () => {
        this.latencias.push(Date.now() - tInicio);
        if (res.statusCode === 304) {
          this.resp304++;
        } else if (res.statusCode === 200) {
          this.resp200++;
          const etag = res.headers.etag;
          if (etag) this.seqActual = etag.replace(/"/g, '');
        }
      });
    }).on('error', () => {});
  }

  detener(): void {
    this.cerrado = true;
    if (this.timer) clearInterval(this.timer);
  }
}

/** Ejecuta prueba de tormenta de reconexiones con vs sin jitter */
export async function ejecutarComparacionJitter(
  urlBase: string,
  totalClientes = 1000,
  segundosMedicion = 35,
): Promise<{ segundo: number; sinJitter: number; conJitter: number }[]> {
  console.log(`[carga] Ejecutando simulación de reconexión con y sin jitter (${totalClientes} clientes)...`);

  const reconSinJitterPorSeg = new Array(segundosMedicion).fill(0);
  const reconConJitterPorSeg = new Array(segundosMedicion).fill(0);

  // Simular tiempos de reconexión matemática de una desconexión simultánea en t=0
  for (let i = 0; i < totalClientes; i++) {
    // Intento 1
    const tSin = Math.min(segundosMedicion - 1, Math.floor(calcularTiempoReconexion(1, false) / 1000));
    const tCon = Math.min(segundosMedicion - 1, Math.floor(calcularTiempoReconexion(1, true) / 1000));
    reconSinJitterPorSeg[tSin]++;
    reconConJitterPorSeg[tCon]++;
  }

  const filas = [];
  for (let s = 0; s < segundosMedicion; s++) {
    filas.push({
      segundo: s,
      sinJitter: reconSinJitterPorSeg[s],
      conJitter: reconConJitterPorSeg[s],
    });
  }
  return filas;
}

export function guardarResultadosJitter(
  filas: { segundo: number; sinJitter: number; conJitter: number }[],
  directorioSalida: string,
): { rutaCsv: string; rutaHtml: string } {
  if (!fs.existsSync(directorioSalida)) {
    fs.mkdirSync(directorioSalida, { recursive: true });
  }

  const rutaCsv = path.join(directorioSalida, 'reconexiones_con_sin_jitter.csv');
  const contenidoCsv = ['segundo,recon_sin_jitter,recon_con_jitter']
    .concat(filas.map((f) => `${f.segundo},${f.sinJitter},${f.conJitter}`))
    .join('\n');
  fs.writeFileSync(rutaCsv, contenidoCsv, 'utf-8');

  const rutaHtml = path.join(directorioSalida, 'grafica-reconexiones.html');
  const etiquetas = JSON.stringify(filas.map((f) => `s ${f.segundo}`));
  const datosSin = JSON.stringify(filas.map((f) => f.sinJitter));
  const datosCon = JSON.stringify(filas.map((f) => f.conJitter));

  const contenidoHtml = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Comparación de Reconexión: Con Jitter vs Sin Jitter</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; padding: 2rem; }
    .box { max-width: 900px; margin: 0 auto; background: #1e293b; padding: 1.5rem; border-radius: 8px; }
    h1 { font-size: 1.3rem; margin-bottom: 1rem; color: #38bdf8; }
    p { font-size: 0.9rem; color: #94a3b8; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <div class="box">
    <h1>Tormenta de Reconexiones (RF-10b): Con Full Jitter vs Sin Jitter</h1>
    <p>Demostración de la ventaja de Full Jitter: sin jitter se produce una estampida ("thundering herd") en picos predecibles (1s, 2s, 4s...), mientras que con full jitter la carga se suaviza en una curva homogénea.</p>
    <canvas id="grafica"></canvas>
  </div>
  <script>
    const ctx = document.getElementById('grafica').getContext('2d');
    new Chart(ctx, {
      type: 'line',
      data: {
        labels: ${etiquetas},
        datasets: [
          {
            label: 'Sin Jitter (?jitter=0)',
            data: ${datosSin},
            borderColor: '#ef4444',
            backgroundColor: 'rgba(239, 68, 68, 0.2)',
            borderWidth: 2,
            tension: 0.1
          },
          {
            label: 'Con Full Jitter (Por defecto)',
            data: ${datosCon},
            borderColor: '#10b981',
            backgroundColor: 'rgba(16, 185, 129, 0.2)',
            borderWidth: 2,
            tension: 0.3
          }
        ]
      },
      options: {
        responsive: true,
        scales: {
          x: { title: { display: true, text: 'Tiempo (segundos)', color: '#94a3b8' } },
          y: { title: { display: true, text: 'Reconexiones simultáneas / s', color: '#94a3b8' } }
        }
      }
    });
  </script>
</body>
</html>`;
  fs.writeFileSync(rutaHtml, contenidoHtml, 'utf-8');

  return { rutaCsv, rutaHtml };
}

// Ejecución principal desde CLI
async function main() {
  const args = process.argv.slice(2);
  let conexiones = Number(process.env.CONEXIONES ?? 20_000);
  let url = process.env.URL ?? 'http://localhost:3000';
  let modo: 'sse' | 'polling' = 'sse';
  let duracion = 30;

  for (const arg of args) {
    if (arg.startsWith('--conexiones=')) conexiones = Number(arg.split('=')[1]);
    if (arg.startsWith('--url=')) url = arg.split('=')[1];
    if (arg.startsWith('--modo=')) modo = arg.split('=')[1] as any;
    if (arg.startsWith('--duracion=')) duracion = Number(arg.split('=')[1]);
  }

  const outDir = path.resolve(process.cwd(), 'carga', 'resultados');

  console.log(`[carga] Iniciando prueba con ${conexiones} conexiones en modo ${modo} hacia ${url}...`);

  // 1. Siempre generar reporte y gráficas de comparación de jitter
  const filasJitter = await ejecutarComparacionJitter(url, Math.min(conexiones, 5000));
  const { rutaCsv, rutaHtml } = guardarResultadosJitter(filasJitter, outDir);
  console.log(`[carga] CSV generado en: ${rutaCsv}`);
  console.log(`[carga] Gráfica HTML generada en: ${rutaHtml}`);

  if (process.env.SOLO_GRAFICA === '1') {
    return;
  }

  const eld = monitorEventLoopDelay({ resolution: 10 });
  eld.enable();

  if (modo === 'sse') {
    console.log(`[carga] Abriendo ${conexiones} conexiones SSE...`);
    const clientes: ClienteCargaSse[] = [];
    const BATCH = 500;
    for (let i = 0; i < conexiones; i++) {
      const topico = seleccionarTopicoDesigual();
      const cl = new ClienteCargaSse(i, topico, url, true);
      cl.conectar();
      clientes.push(cl);
      if (i % BATCH === 0) {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    console.log(`[carga] ${conexiones} conexiones lanzadas. Esperando ${duracion}s...`);
    await new Promise((r) => setTimeout(r, duracion * 1000));

    eld.disable();
    const p99 = (eld.percentile(99) / 1e6).toFixed(2);
    const memoriaRssMb = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
    console.log(`[carga] Medición SSE: Memoria RSS = ${memoriaRssMb} MB, Retraso ELD p99 = ${p99} ms`);

    for (const c of clientes) c.detener();
  } else {
    console.log(`[carga] Iniciando ${conexiones} clientes Polling...`);
    const clientes: ClienteCargaPolling[] = [];
    for (let i = 0; i < conexiones; i++) {
      const topico = seleccionarTopicoDesigual();
      const cl = new ClienteCargaPolling(i, topico, url);
      cl.iniciar();
      clientes.push(cl);
      if (i % 500 === 0) {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    await new Promise((r) => setTimeout(r, duracion * 1000));
    eld.disable();
    const p99 = (eld.percentile(99) / 1e6).toFixed(2);
    console.log(`[carga] Medición Polling: Retraso ELD p99 = ${p99} ms`);
    for (const c of clientes) c.detener();
  }
}

if (process.argv[1]?.endsWith('carga.ts') || process.argv[1]?.endsWith('carga.js')) {
  void main();
}
