# @sitelint/mongoose-cache

MongoDB-based cache for Mongoose queries with TTL and invalidation support. Uses native MongoDB collections (bypassing Mongoose models) for safe concurrent access across multiple PM2 or cluster instances.

## Features

- **Query caching** — `find`, `findOne`, `findById` with simple `.set('useCache', true)` opt-in
- **Aggregation caching** — cache aggregation pipeline results via `.option({ useCache: true })`
- **TTL support** — per-query TTL with a 7-day default
- **Auto-invalidation** — write operations (`save`, `updateOne`, `deleteMany`, `insertMany`, `bulkWrite`, `$merge`, `$out`) automatically invalidate affected cache entries
- **Cross-collection invalidation** — detects `.populate()` paths and invalidates cache when populated collections change
- **Size limit** — configurable max cache size to prevent unbounded growth
- **Periodic sweep** — background cleanup of expired entries
- **Pool-cleared resilience** — gracefully handles transient `MongoPoolClearedError`

## How it works

### Architecture

The cache stores serialized query results directly in MongoDB under a dedicated `_cache_entries` collection. It bypasses Mongoose models entirely and uses the native MongoDB driver (`db.collection()`) to avoid recursive caching — cached reads never pass through the patched Mongoose layer.

```
 ┌──────────────────────────────────────────────────────┐
 │                   Application                        │
 │                                                      │
 │  Model.find().set('useCache',true).exec()            │
 │       │                                              │
 │       ▼                                              │
 │  Query.prototype.exec  (patched by cachePlugin)      │
 │       │                                              │
  │       ├── cache HIT? ──── return cached result       │
  │       │                                              │
  │       ├── cache MISS ─── originalQuery.exec()        │
  │       │       │                                      │
  │       │       ├── MongoDB (source collection)        │
 │       │       │                                      │
 │       │       ▼                                      │
 │       └── CacheDb.writeCache(key, entry)             │
 │               │                                      │
 │               ▼                                      │
 │       MongoDB._cache_entries  (native driver)        │
 └──────────────────────────────────────────────────────┘
```

### Why MongoDB for caching?

Rather than using an external store like Redis, the cache lives in the same MongoDB deployment:

- **Zero infrastructure** — no additional service to deploy, monitor, or secure
- **Atomic consistency** — cache writes and invalidations share the same connection pool as application data, reducing race-condition surface
- **Multi-instance safe** — PM2, cluster, or horizontally scaled API instances all read/write the same cache collection without coordination
- **TTL index** — MongoDB's built-in TTL index on `expiresAt` provides automatic document expiry with no application-level sweep needed (the background sweep is a belt-and-suspenders fallback)

### Monkey-patching strategy

`cachePlugin()` patches Mongoose prototypes globally (once, on first schema registration):

| Target | What it patches |
|---|---|
| `Query.prototype.exec` | Intercepts all queries. Destructive ops auto-invalidate. Read ops check cache before executing. |
| `Model.aggregate` | Wraps aggregates to check/update cache at `.exec()` time. Detects `$merge`/`$out` write stages. |
| `Model.insertMany` | Invalidates the collection after bulk inserts. |
| `Model.bulkWrite` | Invalidates the collection after bulk writes. |
| `schema.post('save')` | Per-schema hook that invalidates on every `save()`. |

The patching is guarded by module-level booleans so it never happens twice — even if `cachePlugin` is called on multiple schemas. The `post('save')` hook, however, is registered per-schema before the global-patch guard so every model gets it.

### Invalidation strategy

The plugin uses **eager invalidation**: any write to a collection deletes all cache entries for that collection. This is deliberately coarse-grained and avoids the complexity of partial invalidation (tracking which individual documents were affected).

When a query uses `.populate()`, the plugin introspects Mongoose's internal `_mongooseOptions.populate` to determine which collections are referenced. These are stored in `meta.populatedCollections`. A write to any populated collection also invalidates the parent query's cache entry — achieved via the `$or` filter in `invalidateCollection`:

```
meta.collection = "blogs"           -- direct match
meta.populatedCollections = "posts" -- cross-collection match
```

### Scalability

- **Bypasses Mongoose** — cache reads use native `findOne` against `_cache_entries`, avoiding the overhead of Mongoose hydration, schema validation, middleware, and getters. A cache hit returns raw JSON in a single round-trip.
- **Index-backed lookups** — the `_cache_entries` collection has indexes on `meta.collection` and `meta.populatedCollections` so invalidations are fast regardless of cache size.
- **Size guard** — `maxCacheSizeBytes` prevents unbounded growth in long-running deployments. When the limit is hit, new writes are skipped (not the query — the query still executes and returns data).
- **Connection-pool resilience** — all cache operations catch `MongoPoolClearedError` (common during replica-set elections or network blips) and degrade gracefully: reads become cache misses, writes are skipped, invalidations are deferred. The application continues serving uncached data until the pool recovers.
- **No cross-instance coordination** — since the cache state lives in MongoDB, adding more app instances (horizontal scaling) requires no additional synchronization. Each instance independently reads and writes the same cache collection.

## Install

```bash
npm install @sitelint/mongoose-cache
```

`mongoose` is a peer dependency (>=8.0.0).

## Quick start

```ts
import mongoose from 'mongoose';
import { CacheDb, cachePlugin } from '@sitelint/mongoose-cache';

// 1. Apply the plugin to your schemas
const userSchema = new mongoose.Schema({ name: String, email: String });
userSchema.plugin(cachePlugin);

const User = mongoose.model('User', userSchema);

// 2. Pass your Mongoose connection — works with both new and existing connections
//
// Option A: you're in control of connecting
const connection = await mongoose.connect('mongodb://localhost:27017/myapp');
CacheDb.setConnection(connection);

// Option B: you already have an active connection (e.g. Mongoose is already connected)
CacheDb.setConnection(mongoose.connection);
// Note: setConnection handles both cases:
//   - if connection.db is already open, uses it immediately
//   - if still opening, waits for the 'open' event before using it

await CacheDb.initializeCacheDB();

// Optional: configure size limit and periodic sweep
CacheDb.configure({ maxCacheSizeBytes: 500 * 1024 * 1024 }); // 500 MB
CacheDb.initializePeriodTasks({ sweepIntervalMs: 75 * 60 * 1000 }); // every 75 min

// 3. Use .set('useCache', true) on read queries
const users = await User.find({ active: true })
  .set('useCache', true)
  .set('cacheTTL', 60000)   // optional, defaults to 7 days
  .exec();
// The first call hits DB, subsequent calls return cached result

// 4. Write operations auto-invalidate
await User.updateOne({ _id: '...' }, { name: 'Bob' });
// The cache for the "users" collection is cleared
```

## API

### `CacheDb` (static class)

#### `CacheDb.setConnection(connection: mongoose.Connection): void`

Sets the MongoDB connection used for cache storage. Accepts both freshly-created connections and already-active ones:

- If `connection.db` is already available (connection is open), uses it immediately.
- If not yet available (connection is still opening), waits for the `open` event.

Common patterns:

```ts
// New connection
const conn = await mongoose.createConnection(uri).asPromise();
CacheDb.setConnection(conn);

// Default connection (mongoose is already connected)
CacheDb.setConnection(mongoose.connection);

// Inside a disconnect handler (to clear the stale reference)
connection.on('disconnected', CacheDb.clearConnection);
connection.on('reconnected', CacheDb.setConnection.bind(CacheDb, connection));
```

#### `CacheDb.initializeCacheDB(): Promise<void>`

Creates the internal `_cache_entries` collection and builds indexes. Call once after `setConnection`.

#### `CacheDb.configure(options: { maxCacheSizeBytes?: number }): void`

Sets an optional cache size limit. When the cache collection exceeds this limit, new writes are skipped until sweeping frees space.

#### `CacheDb.initializePeriodTasks(options?: { sweepIntervalMs?: number }): void`

Starts a background timer that periodically sweeps expired entries. Default interval: 10 minutes.

#### `CacheDb.invalidateCollection(collection: string): Promise<void>`

Manually invalidate all cache entries for a given collection (including cross-collection entries from `.populate()`).

#### `CacheDb.clearConnection(): void`

Clears the internal connection reference. Call on disconnect events.

#### `CacheDb.getCacheStats(): Promise<{ size: number; max?: number }>`

Returns current cache size in bytes and the configured max limit.

#### `CacheDb.readCache(key: string): Promise<CacheEntry | null>`

#### `CacheDb.writeCache(key: string, entry: CacheEntry): Promise<void>`

#### `CacheDb.cacheKey(query: Query<any, any>): string`

#### `CacheDb.cacheKeyForAggregation<T>(collection: string, pipeline: T[]): string`

#### `CacheDb.isWriteAggregation(pipeline: PipelineStage[]): boolean`

#### `CacheDb.sweepExpired(): Promise<void>`

### `cachePlugin(schema: Schema): void`

Mongoose schema plugin. Patches `Query.prototype.exec`, `Model.aggregate`, `Model.insertMany`, and `Model.bulkWrite` (once globally, on first call). Registers `post('save')` hooks per-schema.

### `getCachePatchStatus(): { aggregate: boolean; bulkWrite: boolean; insertMany: boolean; query: boolean }`

Returns which Mongoose prototypes have been patched.

## Supported operations

### Cached reads

| Operation | Opt-in |
|---|---|
| `find` | `.set('useCache', true)` |
| `findOne` | `.set('useCache', true)` |
| `findById` | `.set('useCache', true)` |
| Aggregation (`aggregate()`) | `.option({ useCache: true })` |

### Auto-invalidating writes

| Operation | Trigger |
|---|---|
| `save` | `post('save')` hook |
| `updateOne` / `updateMany` | Patched `Query.prototype.exec` |
| `deleteOne` / `deleteMany` | Patched `Query.prototype.exec` |
| `findOneAndUpdate` / `findOneAndDelete` | Patched `Query.prototype.exec` |
| `findByIdAndUpdate` / `findByIdAndDelete` | Patched `Query.prototype.exec` |
| `findOneAndReplace` / `replaceOne` | Patched `Query.prototype.exec` |
| `insertMany` | Patched `Model.insertMany` |
| `bulkWrite` | Patched `Model.bulkWrite` |
| `$merge` / `$out` aggregation stages | Patched `Model.aggregate` |

## TTL behavior

Default TTL is **7 days** (`CacheDb.DEFAULT_TTL`). Set a custom TTL per query:

```ts
// Query
Model.find({}).set('useCache', true).set('cacheTTL', 300000).exec(); // 5 min

// Aggregation
Model.aggregate([...]).option({ useCache: true, cacheTTL: 300000 }).exec();
```

Expired entries are removed by:
- MongoDB TTL index on `expiresAt` field
- Background sweep (belt-and-suspenders)

## Cache key generation

- **Queries**: `SHA1(collectionName:JSON.stringify(query))` — same filter = same key
- **Aggregations**: `SHA1(collectionName:agg:JSON.stringify(pipeline))`

## Populate-aware invalidation

When a query uses `.populate()`, the plugin detects which collections are referenced and stores them in the cache entry's metadata. If any of those collections are later written to, the cache entry is invalidated.

```ts
// This query populates posts, so a write to "posts" invalidates its cache
Blog.find({}).populate('posts').set('useCache', true).exec();
```

## Logger

By default, only warnings and errors are logged (with a `[mongoose-cache]` prefix). Debug logging is off. To enable:

```ts
import { logger } from '@sitelint/mongoose-cache'; // or require('@sitelint/mongoose-cache').logger

// Not currently exposed — debug is no-op by default
// To enable, you can reassign after import if needed
```

## License

MIT
