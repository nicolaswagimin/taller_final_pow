/**
 * Enrutador del evento 'upgrade' de http.Server (WebSocket en modo noServer).
 * Cada módulo registra su path con registrarUpgrade(server, '/ws/...', manejador);
 * servidor.ts es el único que escucha server.on('upgrade').
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

export type ManejadorUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

const rutasPorServidor = new WeakMap<Server, Map<string, ManejadorUpgrade>>();
const socketsAbiertos = new Set<Duplex>();

export function registrarUpgrade(server: Server, path: string, manejador: ManejadorUpgrade): void {
  let rutas = rutasPorServidor.get(server);
  if (!rutas) {
    rutas = new Map();
    rutasPorServidor.set(server, rutas);
  }
  if (rutas.has(path)) throw new Error(`upgrade ya registrado para ${path}`);
  rutas.set(path, manejador);
}

export function enrutarUpgrades(server: Server): void {
  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const manejador = rutasPorServidor.get(server)?.get(path);
    if (!manejador) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    socketsAbiertos.add(socket);
    socket.once('close', () => socketsAbiertos.delete(socket));
    manejador(req, socket, head);
  });
}

/** Cierre ordenado: destruye los sockets ya promovidos (http.Server no los rastrea). */
export function cerrarUpgrades(): void {
  for (const s of socketsAbiertos) s.destroy();
  socketsAbiertos.clear();
}
