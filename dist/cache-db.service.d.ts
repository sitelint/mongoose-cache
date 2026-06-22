import type mongoose from 'mongoose';
import type { Query, PipelineStage } from 'mongoose';
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
export declare class CacheDb {
    private static readonly CACHE_COLLECTION;
    private static maxCacheSizeBytes;
    static readonly DEFAULT_TTL: number;
    private static db;
    /**
     * Check if an error is a transient pool-cleared error that will resolve on retry.
     *
     * @private
     * @static
     * @param {unknown} err
     * @returns {boolean}
     */
    private static isTransientPoolError;
    /**
     * Get the MongoDB native Db instance.
     * Returns null if no connection has been set yet (queries will bypass cache).
     *
     * @private
     * @static
     * @returns {(mongoose.mongo.Db | null)}
     * @memberof CacheDb
     */
    private static getDb;
    /**
     * Get the native MongoDB collection for cache entries.
     *
     * @private
     * @static
     * @returns {(mongoose.mongo.Collection | null)}
     * @memberof CacheDb
     */
    private static cacheCollection;
    /**
     * Set the MongoDB connection for the cache to use.
     * Must be called after the connection is established.
     *
     * @static
     * @param {mongoose.Connection} connection
     * @memberof CacheDb
     */
    static setConnection(connection: mongoose.Connection): void;
    /**
     * Clear the current MongoDB connection reference.
     * Called when the connection is lost so cache operations don't
     * use a stale connection pool.
     *
     * @static
     * @memberof CacheDb
     */
    static clearConnection(): void;
    /**
     * Configure cache settings such as maximum size.
     *
     * @static
     * @param {{ maxCacheSizeBytes?: number }} options
     * @memberof CacheDb
     */
    static configure(options: {
        maxCacheSizeBytes?: number;
    }): void;
    /**
     * Initialize cache collections and create indexes.
     *
     * @static
     * @returns {Promise<void>}
     * @memberof CacheDb
     */
    static initializeCacheDB(): Promise<void>;
    /**
     * Generate a unique cache key for a Mongoose query.
     *
     * @static
     * @param {Query<any, any>} q
     * @returns {string}
     * @memberof CacheDb
     */
    static cacheKey(q: Query<any, any>): string;
    /**
     * Read a cache entry from MongoDB.
     *
     * @static
     * @param {string} key
     * @returns {(Promise<CacheEntry | null>)}
     * @memberof CacheDb
     */
    static readCache(key: string): Promise<CacheEntry | null>;
    /**
     * Write a cache entry to MongoDB.
     *
     * @static
     * @param {string} key
     * @param {CacheEntry} entry
     * @returns {Promise<void>}
     * @memberof CacheDb
     */
    static writeCache(key: string, entry: CacheEntry): Promise<void>;
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
    static cacheKeyForAggregation<T>(collection: string, pipeline: T[]): string;
    /**
     * Determines whether an aggregation pipeline contains write-capable stages.
     *
     * @static
     * @param {PipelineStage[]} pipeline
     * @returns {boolean}
     * @memberof CacheDb
     */
    static isWriteAggregation(pipeline: PipelineStage[]): boolean;
    /**
     * Invalidate all cache entries for a given collection,
     * including entries from other collections that populated this collection.
     *
     * @static
     * @param {string} collection
     * @returns {Promise<void>}
     * @memberof CacheDb
     */
    static invalidateCollection(collection: string): Promise<void>;
    /**
     * Sweep expired cache entries. With the MongoDB TTL index this is mostly a no-op,
     * but we keep it for entries that may not have a TTL set.
     *
     * @static
     * @returns {Promise<void>}
     * @memberof CacheDb
     */
    static sweepExpired(): Promise<void>;
    /**
     * Initialize periodic tasks for cache sweeping.
     *
     * @static
     * @param {{
     *     sweepIntervalMs?: number;
     *   }} [options]
     * @memberof CacheDb
     */
    static initializePeriodTasks(options?: {
        sweepIntervalMs?: number;
        invalidateIntervalMs?: number;
    }): void;
    /**
     * Get current cache size in bytes from MongoDB collStats.
     *
     * @static
     * @returns {Promise<number>}
     * @memberof CacheDb
     */
    static getCacheSize(): Promise<number>;
    /**
     * Get current cache statistics including size and max limit.
     *
     * @static
     * @returns {Promise<{ size: number; max?: number }>}
     * @memberof CacheDb
     */
    static getCacheStats(): Promise<{
        size: number;
        max?: number;
    }>;
}
