/**
 * Demostrador de contrapresión (RF-9) — DUEÑO: Persona 2.
 * Caso 1: > 64 KB -> dejar de mandar deltas y en 'drain' mandar snapshot.
 * Caso 2: > 512 KB -> enviar 'event: reconecta' y cerrar conexión.
 */
import http from 'node:http';

export interface ResultadoPruebaLenta {
  recibioSnapshotTrasDrain: boolean;
  recibioReconectaYCerrado: boolean;
  bytesLeidos: number;
}

/**
 * Conecta un cliente que lee muy lentamente o pausa el flujo para provocar contrapresión.
 */
export function probarClienteLento(
  urlServidor: string,
  topico: string,
  modo: 'drain_snapshot' | 'desconexion_512k',
): Promise<ResultadoPruebaLenta> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlServidor);
    url.pathname = '/sse';
    url.searchParams.set('topico', topico);

    let bytesLeidos = 0;
    let bufferTexto = '';
    let recibioSnapshotTrasDrain = false;
    let recibioReconectaYCerrado = false;

    const req = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Status inesperado: ${res.statusCode}`));
        return;
      }

      if (modo === 'drain_snapshot') {
        // Pausar para que el servidor acumule datos en su buffer (> 64 KB)
        res.pause();

        // Tras 800 ms reanudar la lectura para provocar 'drain' en el servidor
        setTimeout(() => {
          res.resume();
        }, 800);
      } else if (modo === 'desconexion_512k') {
        // Pausar y no reanudar para forzar desborde de 512 KB
        res.pause();
      }

      res.on('data', (chunk: Buffer) => {
        bytesLeidos += chunk.length;
        bufferTexto += chunk.toString('utf-8');

        if (bufferTexto.includes('event: snapshot')) {
          recibioSnapshotTrasDrain = true;
        }
        if (bufferTexto.includes('event: reconecta')) {
          recibioReconectaYCerrado = true;
        }
      });

      res.on('end', () => {
        resolve({
          recibioSnapshotTrasDrain,
          recibioReconectaYCerrado,
          bytesLeidos,
        });
      });

      res.on('error', (err) => {
        reject(err);
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    // Timeout de seguridad para la prueba
    setTimeout(() => {
      req.destroy();
      resolve({
        recibioSnapshotTrasDrain,
        recibioReconectaYCerrado,
        bytesLeidos,
      });
    }, 5000);
  });
}

// Ejecución directa por CLI
if (process.argv[1]?.endsWith('cliente-lento.ts') || process.argv[1]?.endsWith('cliente-lento.js')) {
  const urlBase = process.env.BASE_URL ?? 'http://localhost:3000';
  const modo = (process.argv[2] as any) ?? 'drain_snapshot';
  console.log(`[cliente-lento] Iniciando prueba con modo: ${modo} contra ${urlBase}...`);

  probarClienteLento(urlBase, 'mun:11', modo)
    .then((res) => {
      console.log('[cliente-lento] Resultado:', res);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[cliente-lento] Error:', err);
      process.exit(1);
    });
}
