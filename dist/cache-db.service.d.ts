import type mongoose from 'mongoose';
import type { Query, PipelineStage } from 'mongoose';
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
export declare class CacheDb {
    private static readonly CACHE_COLLECTION;
    private static maxCacheSizeBytes;
    static readonly DEFAULT_TTL: number;
    private static dbs;
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
    private static getDb;
    /**
     * Get all registered database names.
     *
     * @static
     * @returns {string[]}
     * @memberof CacheDb
     */
    static getAllDbNames(): string[];
    /**
     * Get the native MongoDB collection for cache entries in a specific database.
     *
     * @private
     * @static
     * @param {string} [dbName]
     * @returns {(mongoose.mongo.Collection | null)}
     * @memberof CacheDb
     */
    private static cacheCollection;
    /**
     * Extract the database name from a Mongoose connection.
     *
     * @private
     * @static
     * @param {mongoose.Connection} connection
     * @returns {string}
     * @memberof CacheDb
     */
    private static getDbNameFromConnection;
    /**
     * Register a MongoDB connection for the cache to use.
     * Multiple connections to different databases can be registered;
     * the database name from `connection.db.databaseName` is used as the key.
     *
     * @static
     * @param {mongoose.Connection} connection
     * @memberof CacheDb
     */
    static setConnection(connection: mongoose.Connection): void;
    /**
     * Clear all registered database connections.
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
     * Initialize cache collections and create indexes for all registered databases.
     *
     * @static
     * @returns {Promise<void>}
     * @memberof CacheDb
     */
    static initializeCacheDB(): Promise<void>;
    /**
     * Generate a unique cache key for a Mongoose query.
     * Includes database name to avoid collisions across databases.
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
     * @param {string} [dbName]
     * @returns {(Promise<CacheEntry | null>)}
     * @memberof CacheDb
     */
    static readCache(key: string, dbName?: string): Promise<CacheEntry | null>;
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
    static writeCache(key: string, entry: CacheEntry, dbName?: string): Promise<void>;
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
    static cacheKeyForAggregation<T>(collection: string, pipeline: T[], dbName?: string): string;
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
     * Invalidate all cache entries for a given collection in a specific database
     * or across all registered databases when dbName is not specified.
     *
     * @static
     * @param {string} collection
     * @param {string} [dbName]
     * @returns {Promise<void>}
     * @memberof CacheDb
     */
    static invalidateCollection(collection: string, dbName?: string): Promise<void>;
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
    private static invalidateCollectionInDb;
    /**
     * Clear all cache entries across all registered databases.
     * Call this on application startup to ensure stale cached query results
     * from previous deployments are purged.
     *
     * @static
     * @returns {Promise<void>}
     * @memberof CacheDb
     */
    static clearAllCache(): Promise<void>;
    /**
     * Clear all cache entries in a specific database.
     *
     * @private
     * @static
     * @param {string} dbName
     * @returns {Promise<void>}
     * @memberof CacheDb
     */
    private static clearAllCacheInDb;
    /**
     * Sweep expired cache entries across all registered databases.
     *
     * @static
     * @returns {Promise<void>}
     * @memberof CacheDb
     */
    static sweepExpired(): Promise<void>;
    /**
     * Sweep expired cache entries in a specific database.
     *
     * @private
     * @static
     * @param {string} dbName
     * @returns {Promise<void>}
     * @memberof CacheDb
     */
    private static sweepExpiredInDb;
    /**
     * Initialize periodic tasks for cache sweeping across all registered databases.
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
     * Get current cache size in bytes from MongoDB collStats for a specific database
     * or aggregated across all registered databases.
     *
     * @static
     * @param {string} [dbName]
     * @returns {Promise<number>}
     * @memberof CacheDb
     */
    static getCacheSize(dbName?: string): Promise<number>;
    /**
     * Get cache size for a specific database.
     *
     * @private
     * @static
     * @param {string} dbName
     * @returns {Promise<number>}
     * @memberof CacheDb
     */
    private static getCacheSizeForDb;
    /**
     * Get current cache statistics including size and max limit.
     * Aggregates across all registered databases.
     *
     * @static
     * @returns {Promise<{ size: number; max?: number }>}
     * @memberof CacheDb
     */
    static getCacheStats(): Promise<{
        size: number;
        max?: number;
    }>;
    /**
     * Get statistics for a specific database.
     *
     * @static
     * @param {string} dbName
     * @returns {Promise<{ size: number; max?: number; dbName: string }>}
     * @memberof CacheDb
     */
    static getCacheStatsForDb(dbName: string): Promise<{
        size: number;
        max?: number;
        dbName: string;
    }>;
}
