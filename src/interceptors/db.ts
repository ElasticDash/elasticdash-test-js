import { getCaptureContext } from '../capture/recorder.js'

/**
 * Wraps named methods on a DB client instance in-place so their calls are
 * recorded as "db" events. Returns the same client object.
 *
 * @param client  Any DB client (pg.Client, redis client, mongoose Model, etc.)
 * @param methodNames  Method names to wrap
 * @param label  Optional label prefix for event names (defaults to constructor name)
 */
export function wrapDB<T extends object>(
  client: T,
  methodNames: (keyof T & string)[],
  label?: string,
): T {
  const prefix = label ?? (client.constructor?.name ?? 'db')

  for (const method of methodNames) {
    const original = (client as Record<string, unknown>)[method]
    if (typeof original !== 'function') continue

    ;(client as Record<string, unknown>)[method] = async (...args: unknown[]) => {
      const ctx = getCaptureContext()
      if (!ctx) return (original as (...a: unknown[]) => unknown).apply(client, args)

      const { recorder, replay } = ctx
      const id = recorder.nextId()
      const name = `${prefix}.${method}`

      if (replay.shouldReplay(id)) {
        return replay.getRecordedResult(id)
      }

      const start = Date.now()
      const output = await (original as (...a: unknown[]) => unknown).apply(client, args)
      recorder.record({
        id,
        type: 'db',
        name,
        input: args.length === 1 ? args[0] : args,
        output,
        timestamp: start,
        durationMs: Date.now() - start,
      })

      return output
    }
  }

  return client
}

// --- Driver-specific convenience helpers ---

/** Wraps `query` on a pg.Client or pg.Pool instance. */
export function wrapPgClient<T extends object>(client: T): T {
  return wrapDB(client, ['query'] as (keyof T & string)[], 'pg')
}

/** Wraps `raw` on a knex instance. */
export function wrapKnex<T extends object>(knex: T): T {
  return wrapDB(knex, ['raw'] as (keyof T & string)[], 'knex')
}

/** Wraps common query methods on a MongoDB collection. */
export function wrapMongoCollection<T extends object>(collection: T): T {
  return wrapDB(
    collection,
    ['find', 'findOne', 'insertOne', 'updateOne', 'deleteOne'] as (keyof T & string)[],
    'mongo',
  )
}

/** Wraps common methods on a Redis client. */
export function wrapRedisClient<T extends object>(client: T): T {
  return wrapDB(
    client,
    ['get', 'set', 'del', 'hget', 'hset'] as (keyof T & string)[],
    'redis',
  )
}
