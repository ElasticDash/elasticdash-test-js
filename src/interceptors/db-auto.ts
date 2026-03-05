import { getCaptureContext } from '../capture/recorder.js'

type AnyFn = (...args: unknown[]) => unknown

interface MethodPatch {
  proto: Record<string, unknown>
  method: string
  original: AnyFn
}

const appliedPatches: MethodPatch[] = []

function wrapProtoMethod(proto: object, method: string, eventName: string): void {
  const p = proto as Record<string, unknown>
  if (typeof p[method] !== 'function') return

  const original = p[method] as AnyFn
  appliedPatches.push({ proto: p, method, original })

  p[method] = function (this: unknown, ...args: unknown[]) {
    // Skip callback-style calls to avoid breaking legacy APIs
    if (args.length > 0 && typeof args[args.length - 1] === 'function') {
      return original.apply(this, args)
    }

    const ctx = getCaptureContext()
    if (!ctx) return original.apply(this, args)

    const { recorder, replay } = ctx
    const id = recorder.nextId()

    if (replay.shouldReplay(id)) {
      const historicalEvent = replay.getRecordedEvent(id)
      if (historicalEvent) recorder.record(historicalEvent)
      return Promise.resolve(replay.getRecordedResult(id))
    }

    const start = Date.now()
    const input = args.length === 1 ? args[0] : args

    let result: unknown
    try {
      result = original.apply(this, args)
    } catch (err) {
      recorder.record({
        id, type: 'db', name: eventName,
        input, output: { error: String(err) },
        timestamp: start, durationMs: Date.now() - start,
      })
      throw err
    }

    if (result != null && typeof (result as Promise<unknown>).then === 'function') {
      return (result as Promise<unknown>)
        .then((output: unknown) => {
          recorder.record({
            id, type: 'db', name: eventName,
            input, output,
            timestamp: start, durationMs: Date.now() - start,
          })
          return output
        })
        .catch((err: unknown) => {
          recorder.record({
            id, type: 'db', name: eventName,
            input, output: { error: String(err) },
            timestamp: start, durationMs: Date.now() - start,
          })
          throw err
        })
    }

    // Sync return (rare for DB calls)
    recorder.record({
      id, type: 'db', name: eventName,
      input, output: result,
      timestamp: start, durationMs: Date.now() - start,
    })
    return result
  }
}

async function tryPatchPg(): Promise<void> {
  // @ts-ignore — optional peer dependency
  const pgMod = await import('pg') as Record<string, unknown>
  const pg = (pgMod.default as Record<string, unknown> | undefined) ?? pgMod
  const Client = pg.Client as { prototype: object } | undefined
  // Patch Client.prototype only — Pool.query delegates to Client internally
  if (Client?.prototype) {
    wrapProtoMethod(Client.prototype, 'query', 'pg.query')
  }
}

async function tryPatchMysql2(): Promise<void> {
  // @ts-ignore — optional peer dependency
  const mod = await import('mysql2/promise') as Record<string, unknown>
  const mysql2 = (mod.default as Record<string, unknown> | undefined) ?? mod
  const Connection = mysql2.Connection as { prototype: object } | undefined
  if (Connection?.prototype) {
    wrapProtoMethod(Connection.prototype, 'query', 'mysql2.query')
    wrapProtoMethod(Connection.prototype, 'execute', 'mysql2.execute')
  }
}

async function tryPatchMongodb(): Promise<void> {
  // @ts-ignore — optional peer dependency
  const mongMod = await import('mongodb') as Record<string, unknown>
  const Collection = (
    mongMod.Collection ??
    (mongMod.default as Record<string, unknown> | undefined)?.Collection
  ) as { prototype: object } | undefined
  if (Collection?.prototype) {
    for (const method of ['find', 'findOne', 'insertOne', 'updateOne', 'deleteOne', 'aggregate']) {
      wrapProtoMethod(Collection.prototype, method, `mongodb.${method}`)
    }
  }
}

async function tryPatchIoredis(): Promise<void> {
  // @ts-ignore — optional peer dependency
  const mod = await import('ioredis') as Record<string, unknown>
  const Redis = (mod.default ?? mod) as { prototype: object } | undefined
  if (Redis?.prototype) {
    wrapProtoMethod(Redis.prototype, 'call', 'redis.call')
  }
}

/**
 * Auto-instruments common DB driver prototypes. Safe to call when drivers are
 * not installed — missing modules are silently skipped.
 */
export async function installDBAutoInterceptor(): Promise<void> {
  await Promise.allSettled([
    tryPatchPg(),
    tryPatchMysql2(),
    tryPatchMongodb(),
    tryPatchIoredis(),
  ])
}

/** Restores all patched DB driver prototypes to their originals. */
export function uninstallDBAutoInterceptor(): void {
  for (const { proto, method, original } of appliedPatches) {
    proto[method] = original
  }
  appliedPatches.length = 0
}
