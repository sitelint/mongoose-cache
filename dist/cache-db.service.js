"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CacheDb = void 0;
const mongodb_1 = require("mongodb");
const crypto = __importStar(require("node:crypto"));
const logger_1 = __importDefault(require("./logger"));
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
class CacheDb {
    static CACHE_COLLECTION = '_cache_entries';
    static maxCacheSizeBytes;
    static DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
    static dbs = new Map();
    /**
     * Check if an error is a transient pool-cleared error that will resolve on retry.
     *
     * @private
     * @static
     * @param {unknown} err
     * @returns {boolean}
     */
    static isTransientPoolError(err) {
        if (err instanceof mongodb_1.MongoError) {
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
    static getDb(dbName) {
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
    static getAllDbNames() {
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
    static cacheCollection(dbName) {
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
    static getDbNameFromConnection(connection) {
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
    static setConnection(connection) {
        const register = () => {
            if (connection.db) {
                const dbName = CacheDb.getDbNameFromConnection(connection);
                CacheDb.dbs.set(dbName, connection.db);
            }
        };
        if (connection.db) {
            register();
        }
        else {
            connection.once('open', () => {
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
    static clearConnection() {
        CacheDb.dbs.clear();
    }
    /**
     * Configure cache settings such as maximum size.
     *
     * @static
     * @param {{ maxCacheSizeBytes?: number }} options
     * @memberof CacheDb
     */
    static configure(options) {
        CacheDb.maxCacheSizeBytes = options.maxCacheSizeBytes;
    }
    /**
     * Initialize cache collections and create indexes for all registered databases.
     *
     * @static
     * @returns {Promise<void>}
     * @memberof CacheDb
     */
    static async initializeCacheDB() {
        const dbNames = CacheDb.getAllDbNames();
        if (dbNames.length === 0) {
            logger_1.default.warn('[CacheDb.initializeCacheDB] No DB connections registered, skipping index creation');
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
                await cacheCol.dropIndex('expiresAt_1').catch(() => { });
            }
            catch (err) {
                logger_1.default.error('[CacheDb.initializeCacheDB]', err);
            }
        }
        logger_1.default.countReset('Global cache hit');
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
    static cacheKey(q) {
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
    static async readCache(key, dbName) {
        const col = CacheDb.cacheCollection(dbName);
        if (!col) {
            return null;
        }
        try {
            const doc = await col.findOne({
                _id: key
            });
            if (!doc) {
                return null;
            }
            return {
                data: doc.data,
                meta: doc.meta
            };
        }
        catch (err) {
            if (CacheDb.isTransientPoolError(err)) {
                logger_1.default.warn('[CacheDb.readCache] Connection pool cleared, treating as cache miss');
                return null;
            }
            logger_1.default.error('[CacheDb.readCache]', err);
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
    static async writeCache(key, entry, dbName) {
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
                    logger_1.default.warn(`[CacheDb] Cache size limit reached (${stats.size} bytes). Skipping write for key: ${key}`);
                    return;
                }
            }
            catch (_) {
                // Collection may not exist yet — proceed with write
            }
        }
        try {
            const doc = {
                _id: key,
                data: entry.data,
                meta: entry.meta
            };
            // If TTL is set, add an expiresAt field for MongoDB's TTL index
            if (typeof entry.meta.ttl === 'number') {
                doc.expiresAt = new Date(entry.meta.cachedAt + entry.meta.ttl);
            }
            await cacheCol.replaceOne({
                _id: key
            }, doc, {
                upsert: true
            });
        }
        catch (err) {
            if (CacheDb.isTransientPoolError(err)) {
                logger_1.default.warn('[CacheDb.writeCache] Connection pool cleared, skipping write');
                return;
            }
            logger_1.default.error('[CacheDb.writeCache]', err);
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
    static cacheKeyForAggregation(collection, pipeline, dbName) {
        const serialized = JSON.stringify(pipeline);
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
    static isWriteAggregation(pipeline) {
        return pipeline.some((stage) => {
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
    static async invalidateCollection(collection, dbName) {
        if (dbName) {
            await CacheDb.invalidateCollectionInDb(collection, dbName);
        }
        else {
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
    static async invalidateCollectionInDb(collection, dbName) {
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
        }
        catch (err) {
            if (CacheDb.isTransientPoolError(err)) {
                logger_1.default.warn('[CacheDb.invalidateCollection] Connection pool cleared, skipping invalidation');
                return;
            }
            logger_1.default.error('[CacheDb.invalidateCollection]', err);
        }
    }
    /**
     * Clear all cache entries across all registered databases.
     * Call this on application startup to ensure stale cached query results
     * from previous deployments are purged.
     *
     * @static
     * @returns {Promise<void>}
     * @memberof CacheDb
     */
    static async clearAllCache() {
        const dbNames = CacheDb.getAllDbNames();
        for (const dbName of dbNames) {
            await CacheDb.clearAllCacheInDb(dbName);
        }
    }
    /**
     * Clear all cache entries in a specific database.
     *
     * @private
     * @static
     * @param {string} dbName
     * @returns {Promise<void>}
     * @memberof CacheDb
     */
    static async clearAllCacheInDb(dbName) {
        const col = CacheDb.cacheCollection(dbName);
        if (!col) {
            return;
        }
        try {
            const result = await col.deleteMany({});
            logger_1.default.log(`[CacheDb.clearAllCache] Cleared ${result.deletedCount} cache entries from database: ${dbName}`);
        }
        catch (err) {
            if (CacheDb.isTransientPoolError(err)) {
                logger_1.default.warn('[CacheDb.clearAllCache] Connection pool cleared, will retry on next startup');
                return;
            }
            logger_1.default.error('[CacheDb.clearAllCache]', err);
        }
    }
    /**
     * Sweep expired cache entries across all registered databases.
     *
     * @static
     * @returns {Promise<void>}
     * @memberof CacheDb
     */
    static async sweepExpired() {
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
    static async sweepExpiredInDb(dbName) {
        const col = CacheDb.cacheCollection(dbName);
        if (!col) {
            return;
        }
        try {
            const now = Date.now();
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
        }
        catch (err) {
            if (CacheDb.isTransientPoolError(err)) {
                logger_1.default.warn('[CacheDb.sweepExpired] Connection pool cleared, will retry on next cycle');
                return;
            }
            logger_1.default.error('[CacheDb.sweepExpired]', err);
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
    static initializePeriodTasks(options) {
        const { sweepIntervalMs = 10 * 60 * 1000 } = options || {};
        const scheduleSweep = async () => {
            try {
                await CacheDb.sweepExpired();
            }
            catch (err) {
                logger_1.default.error('[CacheDb.scheduleSweep] Failed', err);
            }
            finally {
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
    static async getCacheSize(dbName) {
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
    static async getCacheSizeForDb(dbName) {
        const db = CacheDb.getDb(dbName);
        if (!db) {
            return 0;
        }
        try {
            const stats = await db.command({
                collStats: CacheDb.CACHE_COLLECTION
            });
            return stats.size ?? 0;
        }
        catch (err) {
            if (CacheDb.isTransientPoolError(err)) {
                logger_1.default.warn('[CacheDb.getCacheSize] Connection pool cleared');
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
    static async getCacheStats() {
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
    static async getCacheStatsForDb(dbName) {
        return {
            dbName,
            max: CacheDb.maxCacheSizeBytes,
            size: await CacheDb.getCacheSizeForDb(dbName)
        };
    }
}
exports.CacheDb = CacheDb;
//# sourceMappingURL=cache-db.service.js.map