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
 * @export
 * @class CacheDb
 */
export class CacheDb {
  private static readonly CACHE_COLLECTION = '_cache_entries';

  private static maxCacheSizeBytes: number | undefined;
  static readonly DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
  private static db: mongoose.mongo.Db | null = null;

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
   * Get the MongoDB native Db instance.
   * Returns null if no connection has been set yet (queries will bypass cache).
   *
   * @private
   * @static
   * @returns {(mongoose.mongo.Db | null)}
   * @memberof CacheDb
   */
  private static getDb(): mongoose.mongo.Db | null {
    return CacheDb.db;
  }

  /**
   * Get the native MongoDB collection for cache entries.
   *
   * @private
   * @static
   * @returns {(mongoose.mongo.Collection | null)}
   * @memberof CacheDb
   */
  private static cacheCollection(): mongoose.mongo.Collection | null {
    const db = CacheDb.getDb();

    return db ? db.collection(CacheDb.CACHE_COLLECTION) : null;
  }

  /**
   * Set the MongoDB connection for the cache to use.
   * Must be called after the connection is established.
   *
   * @static
   * @param {mongoose.Connection} connection
   * @memberof CacheDb
   */
  public static setConnection(connection: mongoose.Connection): void {
    if (connection.db) {
      CacheDb.db = connection.db;
    } else {
      connection.once('open', (): void => {
        CacheDb.db = connection.db;
      });
    }
  }

  /**
   * Clear the current MongoDB connection reference.
   * Called when the connection is lost so cache operations don't
   * use a stale connection pool.
   *
   * @static
   * @memberof CacheDb
   */
  public static clearConnection(): void {
    CacheDb.db = null;
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
   * Initialize cache collections and create indexes.
   *
   * @static
   * @returns {Promise<void>}
   * @memberof CacheDb
   */
  public static async initializeCacheDB(): Promise<void> {
    try {
      const cacheCol = CacheDb.cacheCollection();

      if (!cacheCol) {
        logger.warn('[CacheDb.initializeCacheDB] DB not ready, skipping index creation');

        return;
      }

      // Index for looking up cache entries by collection name (for invalidation)
      await cacheCol.createIndex({
        'meta.collection': 1
      });

      // Index for looking up cache entries by populated collections (for cross-collection invalidation)
      await cacheCol.createIndex({
        'meta.populatedCollections': 1
      });

      // Clean up unused TTL index from a prior version (no callers set cacheTTL)
      await cacheCol.dropIndex('expiresAt_1').catch(() => {});
    } catch (err) {
      logger.error('[CacheDb.initializeCacheDB]', err);
    }

    // Reset global cache hit counter
    logger.countReset('Global cache hit');
  }

  /**
   * Generate a unique cache key for a Mongoose query.
   *
   * @static
   * @param {Query<any, any>} q
   * @returns {string}
   * @memberof CacheDb
   */
  public static cacheKey(q: Query<any, any>): string {
    const query = JSON.stringify(q.getQuery());
    const col = q.model.collection.name;

    return crypto.createHash('sha1').update(`${col}:${query}`).digest('hex');
  }

  /**
   * Read a cache entry from MongoDB.
   *
   * @static
   * @param {string} key
   * @returns {(Promise<CacheEntry | null>)}
   * @memberof CacheDb
   */
  public static async readCache(key: string): Promise<CacheEntry | null> {
    const col = CacheDb.cacheCollection();

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
   * @returns {Promise<void>}
   * @memberof CacheDb
   */
  public static async writeCache(key: string, entry: CacheEntry): Promise<void> {
    const cacheCol = CacheDb.cacheCollection();

    if (!cacheCol) {
      return;
    }

    if (typeof CacheDb.maxCacheSizeBytes === 'number') {
      try {
        const db = CacheDb.getDb();
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
   * @returns {string}
   * @memberof CacheDb
   */
  public static cacheKeyForAggregation<T>(collection: string, pipeline: T[]): string {
    const serialized: string = JSON.stringify(pipeline);

    return crypto.createHash('sha1').update(`${collection}:agg:${serialized}`).digest('hex');
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
   * Invalidate all cache entries for a given collection,
   * including entries from other collections that populated this collection.
   *
   * @static
   * @param {string} collection
   * @returns {Promise<void>}
   * @memberof CacheDb
   */
  public static async invalidateCollection(collection: string): Promise<void> {
    const col = CacheDb.cacheCollection();

    if (!col) {
      return;
    }

    try {
      /*
       * Delete cache entries for this collection directly,
       * OR entries that populated this collection (cross-collection invalidation)
       */
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
   * Sweep expired cache entries. With the MongoDB TTL index this is mostly a no-op,
   * but we keep it for entries that may not have a TTL set.
   *
   * @static
   * @returns {Promise<void>}
   * @memberof CacheDb
   */
  public static async sweepExpired(): Promise<void> {
    const col = CacheDb.cacheCollection();

    if (!col) {
      return;
    }

    try {
      const now: number = Date.now();

      // Remove entries where TTL has expired (belt-and-suspenders alongside the TTL index)
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
   * Initialize periodic tasks for cache sweeping.
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
   * Get current cache size in bytes from MongoDB collStats.
   *
   * @static
   * @returns {Promise<number>}
   * @memberof CacheDb
   */
  public static async getCacheSize(): Promise<number> {
    const db = CacheDb.getDb();

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
}
