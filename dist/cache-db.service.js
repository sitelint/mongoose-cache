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
 * @export
 * @class CacheDb
 */
class CacheDb {
    static CACHE_COLLECTION = '_cache_entries';
    static maxCacheSizeBytes;
    static DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
    static db = null;
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
     * Get the MongoDB native Db instance.
     * Returns null if no connection has been set yet (queries will bypass cache).
     *
     * @private
     * @static
     * @returns {(mongoose.mongo.Db | null)}
     * @memberof CacheDb
     */
    static getDb() {
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
    static cacheCollection() {
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
    static setConnection(connection) {
        if (connection.db) {
            CacheDb.db = connection.db;
        }
        else {
            connection.once('open', () => {
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
    static clearConnection() {
        CacheDb.db = null;
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
     * Initialize cache collections and create indexes.
     *
     * @static
     * @returns {Promise<void>}
     * @memberof CacheDb
     */
    static async initializeCacheDB() {
        try {
            const cacheCol = CacheDb.cacheCollection();
            if (!cacheCol) {
                logger_1.default.warn('[CacheDb.initializeCacheDB] DB not ready, skipping index creation');
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
            await cacheCol.dropIndex('expiresAt_1').catch(() => { });
        }
        catch (err) {
            logger_1.default.error('[CacheDb.initializeCacheDB]', err);
        }
        // Reset global cache hit counter
        logger_1.default.countReset('Global cache hit');
    }
    /**
     * Generate a unique cache key for a Mongoose query.
     *
     * @static
     * @param {Query<any, any>} q
     * @returns {string}
     * @memberof CacheDb
     */
    static cacheKey(q) {
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
    static async readCache(key) {
        const col = CacheDb.cacheCollection();
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
     * @returns {Promise<void>}
     * @memberof CacheDb
     */
    static async writeCache(key, entry) {
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
     * @returns {string}
     * @memberof CacheDb
     */
    static cacheKeyForAggregation(collection, pipeline) {
        const serialized = JSON.stringify(pipeline);
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
    static isWriteAggregation(pipeline) {
        return pipeline.some((stage) => {
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
    static async invalidateCollection(collection) {
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
     * Sweep expired cache entries. With the MongoDB TTL index this is mostly a no-op,
     * but we keep it for entries that may not have a TTL set.
     *
     * @static
     * @returns {Promise<void>}
     * @memberof CacheDb
     */
    static async sweepExpired() {
        const col = CacheDb.cacheCollection();
        if (!col) {
            return;
        }
        try {
            const now = Date.now();
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
     * Initialize periodic tasks for cache sweeping.
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
     * Get current cache size in bytes from MongoDB collStats.
     *
     * @static
     * @returns {Promise<number>}
     * @memberof CacheDb
     */
    static async getCacheSize() {
        const db = CacheDb.getDb();
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
}
exports.CacheDb = CacheDb;
//# sourceMappingURL=cache-db.service.js.map