// Utilidades de prueba de la Persona 3: instancias completas (HTTP + WS + Redis propios) en el
// mismo proceso y un cliente WebSocket que guarda los mensajes recibidos.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Redis, type RedisOptions } from 'ioredis';
import { WebSocket } from 'ws';
import type { Ctx } from '../../compartido/contexto.js';
import type { WsClienteServidor, WsServidorCliente } from '../../compartido/contratos.js';
import { metricas } from '../../src/metricas/index.js';
import { enrutarUpgrades } from '../../src/upgrade.js';
import { montarVerificacion, type OpcionesVerificacion } from '../../src/verificacion/index.js';

/** Mismas opciones que compartido/redis.ts (RF-10a): sin cola offline, timeout de 500 ms. */
export const OPCIONES_REDIS: RedisOptions = {
  enableOfflineQueue: false,
  commandTimeout: 500,
  maxRetriesPerRequest: 1,
  retryStrategy: (intento) => Math.min(100 * 2 ** intento, 2_000),
};

export interface Instancia {
  nombre: string;
  url: string;
  ctx: Ctx;
  cerrar(): Promise<void>;
}

export const esperar = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

async function listo(r: Redis): Promise<void> {
  if (r.status === 'ready') return;
  await new Promise<void>((ok) => r.once('ready', () => ok()));
}

/** Una "instancia" como las del compose: su propio servidor HTTP, sus clientes Redis y su id. */
export async function levantarInstancia(
  urlRedis: string,
  nombre: string,
  opciones: Partial<OpcionesVerificacion> = {},
): Promise<Instancia> {
  const redis = new Redis(urlRedis, { ...OPCIONES_REDIS, connectionName: `${nombre}-principal` });
  const redisSub = new Redis(urlRedis, { ...OPCIONES_REDIS, connectionName: `${nombre}-sub` });
  await Promise.all([listo(redis), listo(redisSub)]);
  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  const ctx: Ctx = { redis, redisSub, instancia: nombre, metricas };
  enrutarUpgrades(server);
  const modulo = montarVerificacion(app, ctx, server, opciones);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  return {
    nombre,
    url: `ws://127.0.0.1:${port}/ws/verificacion`,
    ctx,
    async cerrar() {
      modulo.cerrar();
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
      redis.disconnect();
      redisSub.disconnect();
    },
  };
}

export interface ClienteWs {
  ws: WebSocket;
  instancia: string | undefined;
  mensajes: WsServidorCliente[];
  enviar(m: WsClienteServidor): void;
  /** Espera el primer mensaje (desde `desde`) que cumpla el predicado. */
  esperar<T extends WsServidorCliente>(pred: (m: WsServidorCliente) => m is T, ms?: number, desde?: number): Promise<T>;
  esperar(pred: (m: WsServidorCliente) => boolean, ms?: number, desde?: number): Promise<WsServidorCliente>;
  cerrar(): void;
}

export async function conectar(url: string, auditor: string): Promise<ClienteWs> {
  const ws = new WebSocket(`${url}?auditor=${encodeURIComponent(auditor)}`);
  const mensajes: WsServidorCliente[] = [];
  const esperas = new Set<() => void>();
  let instancia: string | undefined;
  ws.on('upgrade', (res) => {
    instancia = res.headers['x-instancia'] as string | undefined;
  });
  ws.on('message', (datos) => {
    mensajes.push(JSON.parse(String(datos)) as WsServidorCliente);
    for (const f of esperas) f();
  });
  await new Promise<void>((ok, mal) => {
    ws.once('open', () => ok());
    ws.once('error', mal);
  });
  const cliente: ClienteWs = {
    ws,
    get instancia() {
      return instancia;
    },
    mensajes,
    enviar(m) {
      ws.send(JSON.stringify(m));
    },
    esperar(pred: (m: WsServidorCliente) => boolean, ms = 3_000, desde = 0) {
      return new Promise<WsServidorCliente>((ok, mal) => {
        let i = desde;
        const revisar = () => {
          for (; i < mensajes.length; i++) {
            if (pred(mensajes[i]!)) {
              terminar();
              ok(mensajes[i]!);
              return;
            }
          }
        };
        const t = setTimeout(() => {
          terminar();
          mal(new Error(`timeout ${ms} ms esperando mensaje; recibidos: ${JSON.stringify(mensajes.slice(desde))}`));
        }, ms);
        const terminar = () => {
          clearTimeout(t);
          esperas.delete(revisar);
        };
        esperas.add(revisar);
        revisar();
      });
    },
    cerrar() {
      ws.close();
    },
  } as ClienteWs;
  return cliente;
}
