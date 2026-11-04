/**
 * Módulo de verificación (auditores, WebSocket 4.7) — DUEÑO: Persona 3.
 * TODO(Persona 3): tomar/liberar/resolver con lock:acta:{acta} (bloqueos.lua),
 *                  latido y presencia (pres:{auditor}, pres:idx), cola:verif, pub:verif.
 * Por ahora solo hace el upgrade y envía la cola vacía.
 */
import type { Server } from 'node:http';
import type { Express } from 'express';
import { WebSocketServer } from 'ws';
import type { Ctx } from '../../compartido/contexto.js';
import type { WsServidorCliente } from '../../compartido/contratos.js';
import { registrarUpgrade } from '../upgrade.js';

export const RUTA_WS_VERIFICACION = '/ws/verificacion';

export function montarVerificacion(app: Express, ctx: Ctx, server: Server): void {
  const wss = new WebSocketServer({ noServer: true });
  // Muestra qué instancia aceptó el upgrade (RT-2: sin sticky, puede ser cualquiera).
  wss.on('headers', (headers) => headers.push(`X-Instancia: ${ctx.instancia}`));

  registrarUpgrade(server, RUTA_WS_VERIFICACION, (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    ctx.metricas.conexionAbierta('ws');
    ws.once('close', () => ctx.metricas.conexionCerrada('ws'));
    const cola: WsServidorCliente = { t: 'cola', items: [] };
    ws.send(JSON.stringify(cola));
    ws.on('message', () => {
      // TODO(Persona 3): parsear WsClienteServidor y despachar.
    });
  });

  // La ruta HTTP sin upgrade no aplica: responde 501 como el resto de stubs.
  app.get(RUTA_WS_VERIFICACION, (_req, res) => {
    res.status(501).json({ pendiente: 'Persona 3' });
  });
}
