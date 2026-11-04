import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';

export class RedisMock extends EventEmitter {
  public status = 'ready';
  private hashes = new Map<string, Map<string, string>>();
  private zsets = new Map<string, Map<string, number>>();
  private strings = new Map<string, string>();
  private streams = new Map<string, Array<{ id: string; fields: string[] }>>();
  private static pubsubEmitter = new EventEmitter();
  private streamCounter = 0;

  constructor() {
    super();
    RedisMock.pubsubEmitter.setMaxListeners(100);
    RedisMock.pubsubEmitter.on('message', (chan: string, msg: string) => {
      this.emit('message', chan, msg);
    });
  }

  async ping(): Promise<string> {
    return 'PONG';
  }

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<'OK'> {
    this.strings.set(key, String(value));
    return 'OK';
  }

  async hincrby(key: string, field: string, increment: number): Promise<number> {
    let hash = this.hashes.get(key);
    if (!hash) {
      hash = new Map();
      this.hashes.set(key, hash);
    }
    const current = Number(hash.get(field) ?? 0);
    const updated = current + increment;
    hash.set(field, String(updated));
    return updated;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const hash = this.hashes.get(key);
    if (!hash) return {};
    const res: Record<string, string> = {};
    for (const [k, v] of hash.entries()) {
      res[k] = v;
    }
    return res;
  }

  async zincrby(key: string, increment: number, member: string): Promise<string> {
    let zset = this.zsets.get(key);
    if (!zset) {
      zset = new Map();
      this.zsets.set(key, zset);
    }
    const current = zset.get(member) ?? 0;
    const updated = current + increment;
    zset.set(member, updated);
    return String(updated);
  }

  async zadd(key: string, ...args: (string | number)[]): Promise<number> {
    let zset = this.zsets.get(key);
    if (!zset) {
      zset = new Map();
      this.zsets.set(key, zset);
    }
    let idx = 0;
    let added = 0;
    if (args[0] === 'NX') idx++;
    while (idx < args.length) {
      const score = Number(args[idx++]);
      const member = String(args[idx++]);
      if (!zset.has(member)) added++;
      zset.set(member, score);
    }
    return added;
  }

  async zrevrange(key: string, start: number, stop: number, withScores?: string): Promise<string[]> {
    const zset = this.zsets.get(key);
    if (!zset) return [];
    const entries = Array.from(zset.entries()).sort((a, b) => b[1] - a[1]);
    const sliced = entries.slice(start, stop === -1 ? undefined : stop + 1);
    if (withScores?.toUpperCase() === 'WITHSCORES') {
      const res: string[] = [];
      for (const [member, score] of sliced) {
        res.push(member, String(score));
      }
      return res;
    }
    return sliced.map(([member]) => member);
  }

  async xadd(key: string, ...args: string[]): Promise<string> {
    // Syntax: XADD key [MAXLEN ~ n] id field value ...
    let idx = 0;
    if (args[idx]?.toUpperCase() === 'MAXLEN') {
      idx += 3; // MAXLEN ~ n
    }
    const idArg = args[idx++];
    const now = Date.now();
    const id = idArg === '*' ? `${now}-${this.streamCounter++}` : idArg;
    const fields = args.slice(idx);

    let stream = this.streams.get(key);
    if (!stream) {
      stream = [];
      this.streams.set(key, stream);
    }
    stream.push({ id, fields });
    return id;
  }

  async xrange(key: string, start: string, end: string, ...args: (string | number)[]): Promise<Array<[string, string[]]>> {
    const stream = this.streams.get(key) ?? [];
    let count = Infinity;
    const countIdx = args.indexOf('COUNT');
    if (countIdx !== -1 && args[countIdx + 1] !== undefined) {
      count = Number(args[countIdx + 1]);
    }

    const exclusiveStart = start.startsWith('(');
    const cleanStart = exclusiveStart ? start.slice(1) : start;

    const filtered = stream.filter((item) => {
      if (cleanStart !== '-') {
        if (exclusiveStart) {
          if (item.id <= cleanStart) return false;
        } else {
          if (item.id < cleanStart) return false;
        }
      }
      if (end !== '+') {
        if (item.id > end) return false;
      }
      return true;
    });

    return filtered.slice(0, count).map((item) => [item.id, item.fields]);
  }

  async xrevrange(key: string, end: string, start: string, ...args: (string | number)[]): Promise<Array<[string, string[]]>> {
    const stream = this.streams.get(key) ?? [];
    let count = Infinity;
    const countIdx = args.indexOf('COUNT');
    if (countIdx !== -1 && args[countIdx + 1] !== undefined) {
      count = Number(args[countIdx + 1]);
    }

    const filtered = stream.filter((item) => {
      if (end !== '+') {
        if (item.id > end) return false;
      }
      if (start !== '-') {
        if (item.id < start) return false;
      }
      return true;
    });

    const reversed = [...filtered].reverse();
    return reversed.slice(0, count).map((item) => [item.id, item.fields]);
  }

  async xlen(key: string): Promise<number> {
    return (this.streams.get(key) ?? []).length;
  }

  async publish(channel: string, message: string): Promise<number> {
    RedisMock.pubsubEmitter.emit('message', channel, message);
    return 1;
  }

  async subscribe(..._channels: string[]): Promise<void> {
    // no-op, already wired to static emitter
  }

  async unsubscribe(..._channels: string[]): Promise<void> {
    // no-op
  }

  multi(): any {
    const operations: Array<() => Promise<any>> = [];
    const proxy = {
      hincrby: (key: string, field: string, inc: number) => {
        operations.push(() => this.hincrby(key, field, inc));
        return proxy;
      },
      zincrby: (key: string, inc: number, member: string) => {
        operations.push(() => this.zincrby(key, inc, member));
        return proxy;
      },
      zadd: (key: string, ...args: (string | number)[]) => {
        operations.push(() => this.zadd(key, ...args));
        return proxy;
      },
      set: (key: string, val: string) => {
        operations.push(() => this.set(key, val));
        return proxy;
      },
      exec: async () => {
        const results = [];
        for (const op of operations) {
          results.push([null, await op()]);
        }
        return results;
      },
    };
    return proxy;
  }

  async quit(): Promise<'OK'> {
    this.status = 'end';
    return 'OK';
  }
}

export function crearRedisTest(): { redis: Redis; redisSub: Redis } {
  const mockPrincipal = new RedisMock();
  const mockSub = new RedisMock();
  return {
    redis: mockPrincipal as unknown as Redis,
    redisSub: mockSub as unknown as Redis,
  };
}
