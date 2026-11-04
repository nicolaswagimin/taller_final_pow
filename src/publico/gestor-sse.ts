import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import { claves } from '../../compartido/claves.js';
import type { Ctx } from '../../compartido/contexto.js';
import {
  type Candidato,
  type Correccion,
  type Delta,
  type EventoCambio,
  type MensajeSseDelta,
  type Snapshot,
  type Topico,
} from '../../compartido/contratos.js';
import { deserializarCamposStream } from '../../carga/eventos-falsos.js';
import { type ConexionSse, crearConexionSse } from './conexiones.js';
import { obtenerSnapshot, obtenerUltimoSeq } from './snapshot.js';

interface BufferTopico {
  topico: Topico;
  delta: Delta;
  informadas: number;
  correcciones: Correccion[];
  ultimoSeq: string;
  actasCount: number;
  latencias: number[];
}

export class GestorSse {
  private redis: Redis;
  private redisSub: Redis;
  private metricas: Ctx['metricas'];

  // Map<topico, Set<ConexionSse>> para alta y baja O(1)
  private conexionesPorTopico = new Map<Topico, Set<ConexionSse>>();

  // Conteo de suscriptores para gestionar suscripción dinámica a Redis
  private suscripcionesMun = new Map<number, number>();
  private suscripcionesDep = 0;

  // Último id procesado por stream por esta instancia
  private ultimoIdProcesado = new Map<string, string>();

  // Buffer de acumulación de 2 segundos
  private acumulado = new Map<Topico, BufferTopico>();
  private temporizadorVentana?: NodeJS.Timeout;

  // Estado de degradación (Redis caído / vuelto)
  private degradado = false;

  private idContador = 0;
  private fanoutIngenuo = process.env.FANOUT_INGENUO === '1';

  constructor(ctx: Ctx) {
    this.redis = ctx.redis;
    this.redisSub = ctx.redisSub;
    this.metricas = ctx.metricas;

    this.iniciarSuscripciones();
    this.iniciarVentana2s();
  }

  private iniciarSuscripciones(): void {
    this.redisSub.on('message', (canal: string, seqAviso: string) => {
      void this.alRecibirAviso(canal, seqAviso);
    });

    // Detectar caídas y reconexiones de Redis
    const marcarDegradado = (caido: boolean) => {
      if (this.degradado !== caido) {
        this.degradado = caido;
        this.notificarEstado(caido);
      }
    };

    this.redis.on('close', () => marcarDegradado(true));
    this.redis.on('end', () => marcarDegradado(true));
    this.redis.on('ready', () => marcarDegradado(false));

    this.redisSub.on('close', () => marcarDegradado(true));
    this.redisSub.on('end', () => marcarDegradado(true));
    this.redisSub.on('ready', () => marcarDegradado(false));
  }

  private iniciarVentana2s(): void {
    this.temporizadorVentana = setInterval(() => {
      void this.emitirVentana();
    }, 2_000);
    this.temporizadorVentana.unref();
  }

  public detener(): void {
    if (this.temporizadorVentana) {
      clearInterval(this.temporizadorVentana);
    }
  }

  /**
   * Alta de una nueva conexión SSE (O(1)).
   */
  public async altaConexion(topico: Topico, req: Request, res: Response): Promise<ConexionSse> {
    const id = `${Date.now()}-${++this.idContador}`;

    const con = crearConexionSse(
      id,
      topico,
      req,
      res,
      async (c) => {
        // Callback al desahogarse el buffer (drain): enviar snapshot fresco
        try {
          const snap = await obtenerSnapshot(this.redis, c.topico);
          const msg = `id: ${snap.seq}\nevent: snapshot\nretry: ${c.retryMs}\ndata: ${JSON.stringify(snap)}\n\n`;
          c.res.write(msg);
          c.atrasada = false;
        } catch {
          // Si falla Redis, quedará para el próximo intento
        }
      },
      (c) => {
        this.bajaConexion(c);
      },
    );

    let conjunto = this.conexionesPorTopico.get(topico);
    if (!conjunto) {
      conjunto = new Set();
      this.conexionesPorTopico.set(topico, conjunto);
    }
    conjunto.add(con);

    // Ajustar suscripciones dinámicas
    this.registrarInteresTopico(topico);

    this.metricas.conexionAbierta('sse');

    // Estado degradado si aplica
    if (this.degradado) {
      con.res.write(`event: estado\ndata: {"degradado":true}\n\n`);
    }

    // Gestionar evento inicial (Snapshot o Reconexión RF-6)
    const cursor = (req.headers['last-event-id'] as string) || (req.query.desde as string);
    await this.procesarInicioConexion(con, cursor);

    return con;
  }

  /**
   * Baja de una conexión SSE (O(1)).
   */
  public bajaConexion(con: ConexionSse): void {
    const conjunto = this.conexionesPorTopico.get(con.topico);
    if (conjunto) {
      conjunto.delete(con);
      if (conjunto.size === 0) {
        this.conexionesPorTopico.delete(con.topico);
      }
    }
    this.desregistrarInteresTopico(con.topico);
    this.metricas.conexionCerrada('sse');
  }

  private registrarInteresTopico(topico: Topico): void {
    if (topico === 'dep') {
      this.suscripcionesDep++;
      if (this.suscripcionesDep === 1) {
        void this.redisSub.subscribe(claves.pubDep());
      }
    } else if (topico.startsWith('mun:')) {
      const m = Number(topico.slice(4));
      const actual = this.suscripcionesMun.get(m) ?? 0;
      this.suscripcionesMun.set(m, actual + 1);
      if (actual === 0) {
        void this.redisSub.subscribe(claves.pubMun(m));
      }
    } else if (topico.startsWith('pue:')) {
      // Puesto depende del municipio al que pertenece
      const p = Number(topico.slice(4));
      void this.obtenerMunDePuesto(p).then((m) => {
        if (m) {
          const actual = this.suscripcionesMun.get(m) ?? 0;
          this.suscripcionesMun.set(m, actual + 1);
          if (actual === 0) {
            void this.redisSub.subscribe(claves.pubMun(m));
          }
        }
      });
    }
  }

  private desregistrarInteresTopico(topico: Topico): void {
    if (topico === 'dep') {
      this.suscripcionesDep = Math.max(0, this.suscripcionesDep - 1);
      if (this.suscripcionesDep === 0) {
        void this.redisSub.unsubscribe(claves.pubDep());
      }
    } else if (topico.startsWith('mun:')) {
      const m = Number(topico.slice(4));
      const actual = this.suscripcionesMun.get(m) ?? 0;
      const nuevo = Math.max(0, actual - 1);
      if (nuevo === 0) {
        this.suscripcionesMun.delete(m);
        void this.redisSub.unsubscribe(claves.pubMun(m));
      } else {
        this.suscripcionesMun.set(m, nuevo);
      }
    } else if (topico.startsWith('pue:')) {
      const p = Number(topico.slice(4));
      void this.obtenerMunDePuesto(p).then((m) => {
        if (m) {
          const actual = this.suscripcionesMun.get(m) ?? 0;
          const nuevo = Math.max(0, actual - 1);
          if (nuevo === 0) {
            this.suscripcionesMun.delete(m);
            void this.redisSub.unsubscribe(claves.pubMun(m));
          } else {
            this.suscripcionesMun.set(m, nuevo);
          }
        }
      });
    }
  }

  private async obtenerMunDePuesto(p: number): Promise<number | null> {
    const direct = await this.redis.get(`cat:pue:${p}:mun`);
    if (direct) return Number(direct);
    // Convención por defecto o fallback
    return Math.floor(p / 10);
  }

  /**
   * RF-6: Reconexión con Last-Event-ID o ?desde=.
   */
  private async procesarInicioConexion(con: ConexionSse, cursor?: string): Promise<void> {
    try {
      if (!cursor) {
        // Sin cursor -> snapshot
        const snap = await obtenerSnapshot(this.redis, con.topico);
        const msg = `id: ${snap.seq}\nevent: snapshot\nretry: ${con.retryMs}\ndata: ${JSON.stringify(snap)}\n\n`;
        con.enviar(msg);
        return;
      }

      // Con cursor: obtener el stream correspondiente
      let claveStream = claves.evDep();
      let puestoFiltro: number | null = null;

      if (con.topico.startsWith('mun:')) {
        const m = con.topico.slice(4);
        claveStream = claves.evMun(m);
      } else if (con.topico.startsWith('pue:')) {
        puestoFiltro = Number(con.topico.slice(4));
        const m = await this.obtenerMunDePuesto(puestoFiltro);
        claveStream = claves.evMun(m ?? 11);
      }

      // 1. Verificar si el cursor es anterior al primer elemento retenido en el stream
      const primerEntrada = await this.redis.xrange(claveStream, '-', '+', 'COUNT', 1);
      if (primerEntrada.length > 0) {
        const primerId = primerEntrada[0][0];
        if (cursor < primerId) {
          // El cursor ya salió de la ventana de retención -> snapshot
          const snap = await obtenerSnapshot(this.redis, con.topico);
          const msg = `id: ${snap.seq}\nevent: snapshot\nretry: ${con.retryMs}\ndata: ${JSON.stringify(snap)}\n\n`;
          con.enviar(msg);
          return;
        }
      }

      // 2. Leer eventos desde el cursor con XRANGE
      // Pedimos hasta 502 elementos para detectar si faltan más de 500
      const entradas = await this.redis.xrange(claveStream, cursor, '+', 'COUNT', 502);

      // Excluir el propio cursor si vino incluido
      const nuevos = entradas.filter(([id]) => id !== cursor);

      if (nuevos.length > 500) {
        // Faltan más de 500 eventos -> snapshot
        const snap = await obtenerSnapshot(this.redis, con.topico);
        const msg = `id: ${snap.seq}\nevent: snapshot\nretry: ${con.retryMs}\ndata: ${JSON.stringify(snap)}\n\n`;
        con.enviar(msg);
        return;
      }

      if (nuevos.length === 0) {
        // Al día, no requiere enviar nada
        return;
      }

      // 3. Agregar los deltas de los eventos intermedios
      const deltaAcumulado: Delta = {};
      let informadasTotal = 0;
      const correcciones: Correccion[] = [];
      let ultimoSeq = cursor;

      for (const [id, campos] of nuevos) {
        const ev = deserializarCamposStream(campos);
        if (puestoFiltro !== null && ev.puesto !== puestoFiltro) {
          continue;
        }
        ultimoSeq = id;
        informadasTotal += ev.informadas;
        for (const [c, diff] of Object.entries(ev.delta)) {
          const cand = c as Candidato;
          deltaAcumulado[cand] = (deltaAcumulado[cand] ?? 0) + (diff ?? 0);
          if ((diff ?? 0) < 0 || ev.tipo === 'correccion') {
            correcciones.push({ acta: ev.acta, motivo: ev.motivo ?? 'Corrección' });
          }
        }
      }

      // Obtener total_mesas
      let catClave = claves.catTotalDep();
      if (con.topico.startsWith('mun:')) catClave = claves.catTotalMun(con.topico.slice(4));
      else if (con.topico.startsWith('pue:')) catClave = claves.catTotalPue(con.topico.slice(4));
      const totalMesas = Number((await this.redis.get(catClave)) ?? 0);

      const deltaData: MensajeSseDelta = {
        topico: con.topico,
        seq: ultimoSeq,
        delta: deltaAcumulado,
        informadas: informadasTotal,
        total_mesas: totalMesas,
        correcciones,
      };

      const msg = `id: ${ultimoSeq}\nevent: delta\nretry: ${con.retryMs}\ndata: ${JSON.stringify(deltaData)}\n\n`;
      con.enviar(msg);
    } catch {
      // Si falla, el cliente reintentará
    }
  }

  /**
   * Al recibir aviso pub/sub, lee el stream desde el último id procesado (RF-4/RF-6).
   */
  private async alRecibirAviso(canal: string, _seqAviso: string): Promise<void> {
    let claveStream: string;
    let m: number | null = null;

    if (canal === claves.pubDep()) {
      claveStream = claves.evDep();
    } else if (canal.startsWith('pub:mun:')) {
      m = Number(canal.slice(8));
      claveStream = claves.evMun(m);
    } else {
      return;
    }

    const ultimoProcesado = this.ultimoIdProcesado.get(claveStream) ?? '-';

    try {
      // Leer con XRANGE desde el último id procesado
      const entradas = await this.redis.xrange(claveStream, ultimoProcesado, '+', 'COUNT', 1000);
      const nuevas = entradas.filter(([id]) => id !== ultimoProcesado);

      for (const [id, campos] of nuevas) {
        this.ultimoIdProcesado.set(claveStream, id);
        const ev = deserializarCamposStream(campos);
        this.procesarEventoStream(claveStream, id, ev, m);
      }
    } catch (err: any) {
      console.warn(`[gestor-sse] Error leyendo stream ${claveStream}: ${err?.message}`);
    }
  }

  private procesarEventoStream(claveStream: string, seq: string, ev: EventoCambio, m: number | null): void {
    const latencia = Math.max(0, Date.now() - ev.ts_recibido);

    if (this.fanoutIngenuo) {
      // FANOUT_INGENUO=1: Enviar individualmente por acta a cada cliente
      this.emitirIngenuo(seq, ev, m);
      return;
    }

    // Acumular para la ventana de 2 segundos
    if (claveStream === claves.evDep()) {
      this.acumular('dep', seq, ev, latencia);
    } else if (m !== null) {
      const topicoMun: Topico = `mun:${m}`;
      this.acumular(topicoMun, seq, ev, latencia);

      const topicoPue: Topico = `pue:${ev.puesto}`;
      this.acumular(topicoPue, seq, ev, latencia);
    }
  }

  private acumular(topico: Topico, seq: string, ev: EventoCambio, latencia: number): void {
    let buf = this.acumulado.get(topico);
    if (!buf) {
      buf = {
        topico,
        delta: {},
        informadas: 0,
        correcciones: [],
        ultimoSeq: seq,
        actasCount: 0,
        latencias: [],
      };
      this.acumulado.set(topico, buf);
    }

    buf.ultimoSeq = seq;
    buf.informadas += ev.informadas;
    buf.actasCount += 1;
    buf.latencias.push(latencia);

    for (const [c, diff] of Object.entries(ev.delta)) {
      const cand = c as Candidato;
      buf.delta[cand] = (buf.delta[cand] ?? 0) + (diff ?? 0);
      if ((diff ?? 0) < 0 || ev.tipo === 'correccion') {
        buf.correcciones.push({ acta: ev.acta, motivo: ev.motivo ?? 'Corrección' });
      }
    }
  }

  /**
   * Emite deltas acumulados cada 2 s con serialización única y lotes de 500 (RF-4).
   */
  public async emitirVentana(): Promise<void> {
    if (this.acumulado.size === 0) return;

    const snapshotAcumulado = new Map(this.acumulado);
    this.acumulado.clear();

    const BATCH_SIZE = 500;
    let totalMensajesEmitidos = 0;
    let totalIngenuoEsperado = 0;
    const todasLatencias: number[] = [];

    for (const [topico, buf] of snapshotAcumulado.entries()) {
      const conexiones = this.conexionesPorTopico.get(topico);
      if (!conexiones || conexiones.size === 0) continue;

      todasLatencias.push(...buf.latencias);
      totalIngenuoEsperado += buf.actasCount * conexiones.size;

      // Obtener total_mesas del tópico
      let catClave = claves.catTotalDep();
      if (topico.startsWith('mun:')) catClave = claves.catTotalMun(topico.slice(4));
      else if (topico.startsWith('pue:')) catClave = claves.catTotalPue(topico.slice(4));

      let totalMesas = 0;
      try {
        totalMesas = Number((await this.redis.get(catClave)) ?? 0);
      } catch {
        // Ignorar error transitorio de Redis
      }

      const datosDelta: MensajeSseDelta = {
        topico,
        seq: buf.ultimoSeq,
        delta: buf.delta,
        informadas: buf.informadas,
        total_mesas: totalMesas,
        correcciones: buf.correcciones,
      };

      // Serializar UNA SOLA VEZ para todas las conexiones del tópico
      const mensajeSerializado = `id: ${buf.ultimoSeq}\nevent: delta\ndata: ${JSON.stringify(datosDelta)}\n\n`;

      const conexionesArr = Array.from(conexiones);

      // Escribir en lotes de 500 con setImmediate entre lotes
      for (let i = 0; i < conexionesArr.length; i += BATCH_SIZE) {
        const lote = conexionesArr.slice(i, i + BATCH_SIZE);
        for (const con of lote) {
          if (con.enviar(mensajeSerializado)) {
            totalMensajesEmitidos++;
          }
        }
        if (i + BATCH_SIZE < conexionesArr.length) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    }

    // Reportar métricas
    if (totalMensajesEmitidos > 0) {
      this.metricas.incrementar('mensajes_sse_emitidos', totalMensajesEmitidos);
    }
    if (totalIngenuoEsperado > 0) {
      this.metricas.incrementar('mensajes_sse_ingenuo', totalIngenuoEsperado);
    }

    if (todasLatencias.length > 0) {
      todasLatencias.sort((a, b) => a - b);
      const p50 = todasLatencias[Math.floor(todasLatencias.length * 0.5)];
      const p99 = todasLatencias[Math.floor(todasLatencias.length * 0.99)];
      this.metricas.registrar('latencia_sse_p50_ms', p50);
      this.metricas.registrar('latencia_sse_p99_ms', p99);
      this.metricas.registrar('lat_p50_ms', p50);
      this.metricas.registrar('lat_p99_ms', p99);
    }
  }

  private emitirIngenuo(seq: string, ev: EventoCambio, m: number | null): void {
    const topicosDestino: Topico[] = [];
    if (m === null) topicosDestino.push('dep');
    else {
      topicosDestino.push(`mun:${m}`);
      topicosDestino.push(`pue:${ev.puesto}`);
    }

    for (const topico of topicosDestino) {
      const conexiones = this.conexionesPorTopico.get(topico);
      if (!conexiones || conexiones.size === 0) continue;

      const datosDelta: MensajeSseDelta = {
        topico,
        seq,
        delta: ev.delta,
        informadas: ev.informadas,
        total_mesas: 0,
        correcciones: ev.motivo ? [{ acta: ev.acta, motivo: ev.motivo }] : [],
      };

      for (const con of conexiones) {
        // En ingenuo: serializar cada vez por cada cliente
        const msg = `id: ${seq}\nevent: delta\ndata: ${JSON.stringify(datosDelta)}\n\n`;
        con.enviar(msg);
        this.metricas.incrementar('mensajes_sse_emitidos', 1);
        this.metricas.incrementar('mensajes_sse_ingenuo', 1);
      }
    }
  }

  /**
   * RF-10a: Notifica evento "estado" a todos los clientes.
   */
  public notificarEstado(degradado: boolean): void {
    const msg = `event: estado\ndata: ${JSON.stringify({ degradado })}\n\n`;
    for (const [, conSet] of this.conexionesPorTopico.entries()) {
      for (const con of conSet) {
        try {
          con.res.write(msg);
        } catch {
          // Ignorar
        }
      }
    }
  }

  public obtenerTotalConexiones(): number {
    let total = 0;
    for (const [, s] of this.conexionesPorTopico.entries()) {
      total += s.size;
    }
    return total;
  }
}
