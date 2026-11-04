-- bloqueos.lua — DUEÑO: Persona 3 (RF-7, RF-8; secciones 4.4 y 4.7 de docs/DISEÑO.md).
--
-- Bloqueo de un acta dudosa por un auditor. Tres operaciones atómicas en un solo script:
-- Redis lo ejecuta sin intercalar otros comandos, así que "comparar el dueño y luego actuar"
-- no puede ser interrumpido por otra instancia (con GET + DEL desde la app sí podría:
-- el lock expira entre los dos comandos, otro auditor lo toma y el DEL borraría el ajeno).
--
-- El valor del lock es "{auditor}:{token}". El token es aleatorio (crypto.randomUUID) y vive
-- solo en la memoria de la conexión WebSocket: conocer el nombre del auditor no basta para
-- renovar ni liberar un lock ajeno.
--
-- ARGV[1] = operación
--
-- tomar     KEYS: 1 lock:acta:{acta}  2 pres:{auditor}  3 pres:idx  4 cola:verif
--           ARGV: 2 valor  3 ttl_ms  4 presencia (JSON)  5 pres_ttl_s  6 ahora_ms  7 auditor  8 acta
--           SET NX PX: si lo logra, actualiza pres:{auditor} con el acta y pres:idx.
--           Devuelve {1, valor} | {0, valor_del_dueño_actual} | {-1, ''} si el acta ya no está en la cola.
--
-- renovar   KEYS: 1 lock:acta:{acta}
--           ARGV: 2 valor  3 ttl_ms
--           PEXPIRE solo si GET == valor. Devuelve 1 | 0.
--
-- liberar   KEYS: 1 lock:acta:{acta}
--           ARGV: 2 valor
--           DEL solo si GET == valor. Devuelve "ok" | "no_eres_dueno".

local op = ARGV[1]

if op == 'tomar' then
  -- Un acta ya resuelta (fuera de cola:verif) no se puede tomar.
  if redis.call('ZSCORE', KEYS[4], ARGV[8]) == false then
    return { -1, '' }
  end
  local ok = redis.call('SET', KEYS[1], ARGV[2], 'NX', 'PX', tonumber(ARGV[3]))
  if not ok then
    local actual = redis.call('GET', KEYS[1])
    return { 0, actual or '' }
  end
  redis.call('SET', KEYS[2], ARGV[4], 'EX', tonumber(ARGV[5]))
  redis.call('ZADD', KEYS[3], tonumber(ARGV[6]), ARGV[7])
  return { 1, ARGV[2] }
end

if op == 'renovar' then
  if redis.call('GET', KEYS[1]) == ARGV[2] then
    return redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
  end
  return 0
end

if op == 'liberar' then
  if redis.call('GET', KEYS[1]) == ARGV[2] then
    redis.call('DEL', KEYS[1])
    return 'ok'
  end
  return 'no_eres_dueno'
end

return redis.error_reply('bloqueos.lua: operación desconocida ' .. tostring(op))
