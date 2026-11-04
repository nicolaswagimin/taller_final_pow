import type { Request, Response } from 'express';
import type { Topico } from '../../compartido/contratos.js';

export interface ConexionSse {
  id: string;
  topico: Topico;
  req: Request;
  res: Response;
  atrasada: boolean;
  cerrada: boolean;
  retryMs: number;
  enviar(texto: string): boolean;
  cerrar(): void;
}

export function crearConexionSse(
  id: string,
  topico: Topico,
  req: Request,
  res: Response,
  onDrainSnapshot: (con: ConexionSse) => Promise<void>,
  onCerrar: (con: ConexionSse) => void,
): ConexionSse {
  const retryMs = Math.floor(Math.random() * 4001) + 1000; // 1000 a 5000 ms

  const con: ConexionSse = {
    id,
    topico,
    req,
    res,
    atrasada: false,
    cerrada: false,
    retryMs,
    enviar(texto: string): boolean {
      if (con.cerrada) return false;

      // RF-9: Contrapresión > 512 KB -> reconecta y cerrar
      if (res.writableLength > 512 * 1024) {
        res.write('event: reconecta\ndata: {}\n\n');
        con.cerrar();
        return false;
      }

      // RF-9: Si ya está atrasada (> 64 KB), no mandar deltas hasta drain
      if (con.atrasada) {
        return false;
      }

      // RF-9: Si supera 64 KB, marcar como atrasada y esperar drain para snapshot
      if (res.writableLength > 64 * 1024) {
        con.atrasada = true;
        res.once('drain', () => {
          if (!con.cerrada) {
            void onDrainSnapshot(con);
          }
        });
        return false;
      }

      const ok = res.write(texto);
      if (!ok || res.writableLength > 64 * 1024) {
        con.atrasada = true;
        res.once('drain', () => {
          if (!con.cerrada) {
            void onDrainSnapshot(con);
          }
        });
      }
      return ok;
    },
    cerrar() {
      if (con.cerrada) return;
      con.cerrada = true;
      try {
        res.end();
      } catch {
        // ignorar si ya cerró
      }
      onCerrar(con);
    },
  };

  // Cabeceras HTTP SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Enviar retry inicial
  res.write(`retry: ${retryMs}\n\n`);

  req.on('close', () => {
    con.cerrar();
  });

  return con;
}
