import type mongoose from 'mongoose';
import type { Query, PipelineStage } from 'mongoose';
import { MongoError } from 'mongodb';
import * as crypto from 'node:crypto';

import logger from './logger';

export type CacheEntry = {
  data: any;
  meta: {
    cachedAt: number;
    collection: string;
    dbName: string;
    populatedCollections?: string[];
    ttl: number;
  };
};

/**
 * MongoDB-based cache for Mongoose queries with TTL and invalidation support.
 *
 * Uses native MongoDB collections (bypassing Mongoose models to avoid recursive caching)
 * for safe concurrent access across multiple PM2 instances.
 *
 * Supports multiple MongoDB databases — each database gets its own `_cache_entries` collection.
 *
 * @export
 * @class CacheDb
 */
export class CacheDb {
  private static readonly CACHE_COLLECTION = '_cache_entries';

  private static maxCacheSizeBytes: number | undefined;
  static readonly DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
  private static dbs: Map<string, mongoose.mongo.Db> = new Map();

  /**
   * Check if an error is a transient pool-cleared error that will resolve on retry.
   *
   * @private
   * @static
   * @param {unknown} err
   * @returns {boolean}
   */
  private static isTransientPoolError(err: unknown): boolean {
    if (err instanceof MongoError) {
      return err.name === 'MongoPoolClearedError';
    }

    return false;
  }

  /**
   * Get the MongoDB native Db instance by database name.
   * When dbName is not provided, returns the first registered db.
   * Returns null if no connection has been registered yet.
   *
   * @private
   * @static
   * @param {string} [dbName]
   * @returns {(mongoose.mongo.Db | null)}
   * @memberof CacheDb
   */
  private static getDb(dbName?: string): mongoose.mongo.Db | null {
    if (dbName) {
      return CacheDb.dbs.get(dbName) || null;
    }

    const first = CacheDb.dbs.values().next();

    return first.done ? null : first.value;
  }

  /**
   * Get all registered database names.
   *
   * @static
   * @returns {string[]}
   * @memberof CacheDb
   */
  public static getAllDbNames(): string[] {
    return Array.from(CacheDb.dbs.keys());
  }

  /**
   * Get the native MongoDB collection for cache entries in a specific database.
   *
   * @private
   * @static
   * @param {string} [dbName]
   * @returns {(mongoose.mongo.Collection | null)}
   * @memberof CacheDb
   */
  private static cacheCollection(dbName?: string): mongoose.mongo.Collection | null {
    const db = CacheDb.getDb(dbName);

    return db ? db.collection(CacheDb.CACHE_COLLECTION) : null;
  }

  /**
   * Extract the database name from a Mongoose connection.
   *
   * @private
   * @static
   * @param {mongoose.Connection} connection
   * @returns {string}
   * @memberof CacheDb
   */
  private static getDbNameFromConnection(connection: mongoose.Connection): string {
    return connection.db.databaseName;
  }

  /**
   * Register a MongoDB connection for the cache to use.
   * Multiple connections to different databases can be registered;
   * the database name from `connection.db.databaseName` is used as the key.
   *
   * @static
   * @param {mongoose.Connection} connection
   * @memberof CacheDb
   */
  public static setConnection(connection: mongoose.Connection): void {
    const register = (): void => {
      if (connection.db) {
        const dbName = CacheDb.getDbNameFromConnection(connection);

        CacheDb.dbs.set(dbName, connection.db);
      }
    };

    if (connection.db) {
      register();
    } else {
      connection.once('open', (): void => {
        register();
      });
    }
  }

  /**
   * Clear all registered database connections.
   *
   * @static
   * @memberof CacheDb
   */
  public static clearConnection(): void {
    CacheDb.dbs.clear();
  }

  /**
   * Configure cache settings such as maximum size.
   *
   * @static
   * @param {{ maxCacheSizeBytes?: number }} options
   * @memberof CacheDb
   */
  public static configure(options: { maxCacheSizeBytes?: number }): void {
    CacheDb.maxCacheSizeBytes = options.maxCacheSizeBytes;
  }

  /**
   * Initialize cache collections and create indexes for all registered databases.
   *
   * @static
   * @returns {Promise<void>}
   * @memberof CacheDb
   */
  public static async initializeCacheDB(): Promise<void> {
    const dbNames = CacheDb.getAllDbNames();

    if (dbNames.length === 0) {
      logger.warn('[CacheDb.initializeCacheDB] No DB connections registered, skipping index creation');

      return;
    }

    for (const dbName of dbNames) {
      try {
        const cacheCol = CacheDb.cacheCollection(dbName);

        if (!cacheCol) {
          continue;
        }

        // Index for looking up cache entries by collection name (for invalidation)
        await cacheCol.createIndex({
          'meta.collection': 1
        });

        // Index for looking up cache entries by populated collections (for cross-collection invalidation)
        await cacheCol.createIndex({
          'meta.populatedCollections': 1
        });

        // Index for looking up cache entries by database name
        await cacheCol.createIndex({
          'meta.dbName': 1
        });

        // Clean up unused TTL index from a prior version
        await cacheCol.dropIndex('expiresAt_1').catch(() => {});
      } catch (err) {
        logger.error('[CacheDb.initializeCacheDB]', err);
      }
    }

    logger.countReset('Global cache hit');
  }

  /**
   * Generate a unique cache key for a Mongoose query.
   * Includes database name to avoid collisions across databases.
   *
   * @static
   * @param {Query<any, any>} q
   * @returns {string}
   * @memberof CacheDb
   */
  public static cacheKey(q: Query<any, any>): string {
    const query = JSON.stringify(q.getQuery());
    const col = q.model.collection.name;
    const dbName = q.model.db.db.databaseName;

    return crypto.createHash('sha1').update(`${dbName}:${col}:${query}`).digest('hex');
  }

  /**
   * Read a cache entry from MongoDB.
   *
   * @static
   * @param {string} key
   * @param {string} [dbName]
   * @returns {(Promise<CacheEntry | null>)}
   * @memberof CacheDb
   */
  public static async readCache(key: string, dbName?: string): Promise<CacheEntry | null> {
    const col = CacheDb.cacheCollection(dbName);

    if (!col) {
      return null;
    }

    try {
      const doc = await col.findOne({
        _id: key as any
      });

      if (!doc) {
        return null;
      }

      return {
        data: doc.data,
        meta: doc.meta as CacheEntry['meta']
      };
    } catch (err) {
      if (CacheDb.isTransientPoolError(err)) {
        logger.warn('[CacheDb.readCache] Connection pool cleared, treating as cache miss');

        return null;
      }
      logger.error('[CacheDb.readCache]', err);

      return null;
    }
  }

  /**
   * Write a cache entry to MongoDB.
   *
   * @static
   * @param {string} key
   * @param {CacheEntry} entry
   * @param {string} [dbName]
   * @returns {Promise<void>}
   * @memberof CacheDb
   */
  public static async writeCache(key: string, entry: CacheEntry, dbName?: string): Promise<void> {
    const cacheCol = CacheDb.cacheCollection(dbName);

    if (!cacheCol) {
      return;
    }

    if (typeof CacheDb.maxCacheSizeBytes === 'number') {
      try {
        const db = CacheDb.getDb(dbName);
        const stats = db
          ? await db.command({
              collStats: CacheDb.CACHE_COLLECTION
            })
          : null;

        if (stats && stats.size >= CacheDb.maxCacheSizeBytes) {
          logger.warn(`[CacheDb] Cache size limit reached (${stats.size} bytes). Skipping write for key: ${key}`);

          return;
        }
      } catch (_) {
        // Collection may not exist yet — proceed with write
      }
    }

    try {
      const doc: Record<string, any> = {
        _id: key as any,
        data: entry.data,
        meta: entry.meta
      };

      // If TTL is set, add an expiresAt field for MongoDB's TTL index
      if (typeof entry.meta.ttl === 'number') {
        doc.expiresAt = new Date(entry.meta.cachedAt + entry.meta.ttl);
      }

      await cacheCol.replaceOne(
        {
          _id: key as any
        },
        doc,
        {
          upsert: true
        }
      );
    } catch (err) {
      if (CacheDb.isTransientPoolError(err)) {
        logger.warn('[CacheDb.writeCache] Connection pool cleared, skipping write');

        return;
      }
      logger.error('[CacheDb.writeCache]', err);
    }
  }

  /**
   * Generate a unique cache key for an aggregation pipeline on a given collection.
   *
   * @static
   * @template T
   * @param {string} collection
   * @param {T[]} pipeline
   * @param {string} [dbName]
   * @returns {string}
   * @memberof CacheDb
   */
  public static cacheKeyForAggregation<T>(collection: string, pipeline: T[], dbName?: string): string {
    const serialized: string = JSON.stringify(pipeline);
    const dbPrefix = dbName ? `${dbName}:` : '';

    return crypto.createHash('sha1').update(`${dbPrefix}${collection}:agg:${serialized}`).digest('hex');
  }

  /**
   * Determines whether an aggregation pipeline contains write-capable stages.
   *
   * @static
   * @param {PipelineStage[]} pipeline
   * @returns {boolean}
   * @memberof CacheDb
   */
  public static isWriteAggregation(pipeline: PipelineStage[]): boolean {
    return pipeline.some((stage): boolean => {
      return '$merge' in stage || '$out' in stage;
    });
  }

  /**
   * Invalidate all cache entries for a given collection in a specific database
   * or across all registered databases when dbName is not specified.
   *
   * @static
   * @param {string} collection
   * @param {string} [dbName]
   * @returns {Promise<void>}
   * @memberof CacheDb
   */
  public static async invalidateCollection(collection: string, dbName?: string): Promise<void> {
    if (dbName) {
      await CacheDb.invalidateCollectionInDb(collection, dbName);
    } else {
      // When no dbName specified, invalidate across ALL registered databases
      const dbNames = CacheDb.getAllDbNames();

      for (const name of dbNames) {
        await CacheDb.invalidateCollectionInDb(collection, name);
      }
    }
  }

  /**
   * Invalidate cache entries for a collection in a specific database.
   *
   * @private
   * @static
   * @param {string} collection
   * @param {string} dbName
   * @returns {Promise<void>}
   * @memberof CacheDb
   */
  private static async invalidateCollectionInDb(collection: string, dbName: string): Promise<void> {
    const col = CacheDb.cacheCollection(dbName);

    if (!col) {
      return;
    }

    try {
      await col.deleteMany({
        $or: [
          {
            'meta.collection': collection
          },
          {
            'meta.populatedCollections': collection
          }
        ]
      });
    } catch (err) {
      if (CacheDb.isTransientPoolError(err)) {
        logger.warn('[CacheDb.invalidateCollection] Connection pool cleared, skipping invalidation');

        return;
      }
      logger.error('[CacheDb.invalidateCollection]', err);
    }
  }

  /**
   * Sweep expired cache entries across all registered databases.
   *
   * @static
   * @returns {Promise<void>}
   * @memberof CacheDb
   */
  public static async sweepExpired(): Promise<void> {
    const dbNames = CacheDb.getAllDbNames();

    for (const dbName of dbNames) {
      await CacheDb.sweepExpiredInDb(dbName);
    }
  }

  /**
   * Sweep expired cache entries in a specific database.
   *
   * @private
   * @static
   * @param {string} dbName
   * @returns {Promise<void>}
   * @memberof CacheDb
   */
  private static async sweepExpiredInDb(dbName: string): Promise<void> {
    const col = CacheDb.cacheCollection(dbName);

    if (!col) {
      return;
    }

    try {
      const now: number = Date.now();

      await col.deleteMany({
        $expr: {
          $gt: [
            {
              $subtract: [now, '$meta.cachedAt']
            },
            '$meta.ttl'
          ]
        },
        'meta.ttl': {
          $type: 'number'
        }
      });
    } catch (err) {
      if (CacheDb.isTransientPoolError(err)) {
        logger.warn('[CacheDb.sweepExpired] Connection pool cleared, will retry on next cycle');

        return;
      }
      logger.error('[CacheDb.sweepExpired]', err);
    }
  }

  /**
   * Initialize periodic tasks for cache sweeping across all registered databases.
   *
   * @static
   * @param {{
   *     sweepIntervalMs?: number;
   *   }} [options]
   * @memberof CacheDb
   */
  public static initializePeriodTasks(options?: { sweepIntervalMs?: number; invalidateIntervalMs?: number }): void {
    const { sweepIntervalMs = 10 * 60 * 1000 } = options || {};

    const scheduleSweep = async (): Promise<void> => {
      try {
        await CacheDb.sweepExpired();
      } catch (err) {
        logger.error('[CacheDb.scheduleSweep] Failed', err);
      } finally {
        globalThis.setTimeout(scheduleSweep, sweepIntervalMs);
      }
    };

    globalThis.setImmediate(scheduleSweep);
  }

  /**
   * Get current cache size in bytes from MongoDB collStats for a specific database
   * or aggregated across all registered databases.
   *
   * @static
   * @param {string} [dbName]
   * @returns {Promise<number>}
   * @memberof CacheDb
   */
  public static async getCacheSize(dbName?: string): Promise<number> {
    if (dbName) {
      return CacheDb.getCacheSizeForDb(dbName);
    }

    // Aggregate across all dbs
    let total = 0;
    const dbNames = CacheDb.getAllDbNames();

    for (const name of dbNames) {
      total += await CacheDb.getCacheSizeForDb(name);
    }

    return total;
  }

  /**
   * Get cache size for a specific database.
   *
   * @private
   * @static
   * @param {string} dbName
   * @returns {Promise<number>}
   * @memberof CacheDb
   */
  private static async getCacheSizeForDb(dbName: string): Promise<number> {
    const db = CacheDb.getDb(dbName);

    if (!db) {
      return 0;
    }

    try {
      const stats = await db.command({
        collStats: CacheDb.CACHE_COLLECTION
      });

      return stats.size ?? 0;
    } catch (err) {
      if (CacheDb.isTransientPoolError(err)) {
        logger.warn('[CacheDb.getCacheSize] Connection pool cleared');

        return 0;
      }

      return 0;
    }
  }

  /**
   * Get current cache statistics including size and max limit.
   * Aggregates across all registered databases.
   *
   * @static
   * @returns {Promise<{ size: number; max?: number }>}
   * @memberof CacheDb
   */
  public static async getCacheStats(): Promise<{ size: number; max?: number }> {
    return {
      max: CacheDb.maxCacheSizeBytes,
      size: await CacheDb.getCacheSize()
    };
  }

  /**
   * Get statistics for a specific database.
   *
   * @static
   * @param {string} dbName
   * @returns {Promise<{ size: number; max?: number; dbName: string }>}
   * @memberof CacheDb
   */
  public static async getCacheStatsForDb(dbName: string): Promise<{ size: number; max?: number; dbName: string }> {
    return {
      dbName,
      max: CacheDb.maxCacheSizeBytes,
      size: await CacheDb.getCacheSizeForDb(dbName)
    };
  }
}
