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
exports.cachePlugin = cachePlugin;
exports.getCachePatchStatus = getCachePatchStatus;
const mongoose_1 = __importStar(require("mongoose"));
const cache_db_service_1 = require("./cache-db.service");
const logger_1 = __importDefault(require("./logger"));
let isOriginalExecPatched = false;
let isAggregatePatched = false;
let isInsertManyPatched = false;
let isBulkWritePatched = false;
/**
 * Check if a cache entry is still valid based on its TTL and freshness.
 *
 * @param {(CacheEntry | null)} entry
 * @param {number} now
 * @returns {boolean}
 */
function isCacheValid(entry, now) {
    if (entry === null) {
        return false;
    }
    return !entry.meta.ttl || now - entry.meta.cachedAt < entry.meta.ttl;
}
/**
 * Extract collection names from populated paths in a Mongoose query.
 *
 * @param {Query<any, any>} query - The Mongoose query to analyze
 * @returns {string[]} - Array of collection names that are being populated
 */
function extractPopulatedCollections(query) {
    const collections = new Set();
    try {
        // Access Mongoose internal populate options
        const queryAny = query;
        const populateOptions = queryAny._mongooseOptions?.populate;
        if (!populateOptions) {
            return [];
        }
        // Recursive helper to extract collections from populate objects
        const extractFromPopulate = (pop) => {
            if (typeof pop !== 'object' || pop === null || Array.isArray(pop)) {
                return;
            }
            // Try to get the model from the populate object
            if (pop.model) {
                const collectionName = pop.model.collection?.name;
                if (collectionName) {
                    collections.add(collectionName);
                }
            }
            // If path is specified, try to resolve the model from the query's model
            if (pop.path && !pop.model && query.model) {
                try {
                    const schemaPath = query.model.schema.path(pop.path);
                    if (schemaPath && schemaPath.options?.ref) {
                        const refModel = query.model.db.model(schemaPath.options.ref);
                        if (refModel?.collection?.name) {
                            collections.add(refModel.collection.name);
                            logger_1.default.debug(`[extractPopulatedCollections] Resolved ${pop.path} -> ${refModel.collection.name}`);
                        }
                    }
                }
                catch (err) {
                    logger_1.default.error(`[extractPopulatedCollections] Error resolving path ${pop.path}:`, err);
                }
            }
            // Handle nested populates recursively
            if (pop.populate) {
                const nestedPops = Array.isArray(pop.populate) ? pop.populate : [pop.populate];
                for (const nestedPop of nestedPops) {
                    extractFromPopulate(nestedPop);
                }
            }
        };
        // Handle different populate formats
        let populates = [];
        if (Array.isArray(populateOptions)) {
            populates = populateOptions;
        }
        else if (typeof populateOptions === 'object') {
            // Check if it's an object with populate field names as keys
            const keys = Object.keys(populateOptions);
            if (keys.length > 0 && populateOptions[keys[0]]?.path) {
                // It's an object like { apiToken: PopulateOptions, workspace: PopulateOptions }
                populates = Object.values(populateOptions);
            }
            else {
                // It's a single populate options object
                populates = [populateOptions];
            }
        }
        for (const pop of populates) {
            extractFromPopulate(pop);
        }
        if (collections.size > 0) {
            logger_1.default.debug(`[Cache] Detected populated collections: ${Array.from(collections).join(', ')}`);
        }
    }
    catch (err) {
        logger_1.default.error('[extractPopulatedCollections] Error extracting populated collections', err);
    }
    return Array.from(collections);
}
/**
 * Apply caching plugin to Mongoose schema and patch prototypes once.
 *
 * This plugin enables disk-based caching for Mongoose queries and aggregations.
 * It automatically intercepts `.exec()` calls on supported operations and stores results
 * in a persistent cache layer with TTL and freshness tracking.
 *
 * ### Supported Query Operations:
 * - `find`, `findOne`, `findById`
 * - To enable caching, use `.set('useCache', true)` on the query.
 * - Optionally, set TTL with `.set('cacheTTL', 60000)` (in milliseconds).
 *
 * ### Supported Aggregation Pipelines:
 * - Any aggregation executed via `.aggregate(...)`
 * - To enable caching, use `.option({ useCache: true })` on the aggregation.
 * - Optionally, set TTL with `.option({ cacheTTL: 60000 })`
 *
 * ### Example (Query):
 * ```ts
 * Model.find({ ... })
 *   .set('useCache', true)
 *   .set('cacheTTL', 60000)
 *   .exec();
 * ```
 *
 * ### Example (Aggregation):
 * ```ts
 * Model.aggregate([...])
 *   .option({ useCache: true, cacheTTL: 60000 })
 *   .exec();
 * ```
 *
 * @export
 * @param {Schema} schema - The Mongoose schema to apply the plugin to.
 * @returns {void}
 */
function cachePlugin(schema) {
    /*
      Register schema-specific hooks BEFORE the global-patches guard,
      so every model gets post('save') / insertMany / bulkWrite regardless
      of whether the global Query.prototype.exec and Model.aggregate
      have already been patched by an earlier model.
      Guard against fake/mock schemas (e.g. in tests) that lack schema.post.
    */
    if (typeof schema.post === 'function') {
        schema.post('save', async function () {
            const col = this.collection.name;
            try {
                await cache_db_service_1.CacheDb.invalidateCollection(col);
                logger_1.default.debug(`Cache invalidated via save for collection: ${col}`);
                logger_1.default.countReset(`Global cache hit: ${col}`);
                logger_1.default.countReset(`Aggregate cache hit: ${col}`);
            }
            catch (err) {
                logger_1.default.error('[CacheDb.save] CacheDb.invalidateCollection', err);
            }
        });
    }
    if (isOriginalExecPatched && isAggregatePatched) {
        return;
    }
    if (isOriginalExecPatched === false) {
        const originalExec = mongoose_1.Query.prototype.exec;
        mongoose_1.Query.prototype.exec = async function (...args) {
            const now = Date.now();
            const destructiveOps = new Set([
                // Delete operations
                'deleteOne',
                'deleteMany',
                'findOneAndDelete',
                'findByIdAndDelete',
                'remove',
                // Update operations
                'updateOne',
                'updateMany',
                'findOneAndUpdate',
                'findByIdAndUpdate',
                'findOneAndReplace',
                'replaceOne'
            ]);
            const op = this.op;
            const col = this.model.collection.name;
            // Handle destructive operations
            if (destructiveOps.has(op)) {
                let res;
                try {
                    res = await originalExec.apply(this, args);
                }
                catch (err) {
                    logger_1.default.error('[CacheDb.cachePlugin] Query.exec (destructive)', err);
                    return new Error(`[CacheDb.cachePlugin] Query.exec: ${err.message}`);
                }
                try {
                    await cache_db_service_1.CacheDb.invalidateCollection(col);
                    logger_1.default.debug(`Cache invalidated for collection: ${col}`);
                    logger_1.default.countReset(`Global cache hit: ${col}`);
                    logger_1.default.countReset(`Aggregate cache hit: ${col}`);
                }
                catch (err) {
                    logger_1.default.error('[CacheDb.cachePlugin] CacheDb.invalidateCollection', err);
                }
                return res;
            }
            // Handle cacheable read operations
            const cacheableOps = new Set(['find', 'findOne', 'findById']);
            if (cacheableOps.has(op) === false) {
                return originalExec.apply(this, args);
            }
            const useCache = this.get('useCache');
            let ttl = this.get('cacheTTL');
            if (typeof useCache === 'undefined' || useCache === false) {
                return originalExec.apply(this, args);
            }
            if (typeof ttl === 'undefined') {
                ttl = cache_db_service_1.CacheDb.DEFAULT_TTL;
            }
            const key = cache_db_service_1.CacheDb.cacheKey(this);
            let cached = null;
            try {
                cached = await cache_db_service_1.CacheDb.readCache(key);
            }
            catch (err) {
                logger_1.default.error('[CacheDb.cachePlugin] CacheDb.readCache', err);
            }
            if (isCacheValid(cached, now)) {
                logger_1.default.count(`Global cache hit: ${key}`);
                return Promise.resolve(cached.data);
            }
            // Extract populated collections BEFORE executing the query
            const populatedCollections = extractPopulatedCollections(this);
            let res;
            try {
                res = await originalExec.apply(this, args);
            }
            catch (err) {
                logger_1.default.error('[CacheDb.cachePlugin] Query.exec', err);
                return Promise.reject(new Error(`[CacheDb.cachePlugin] Query.exec: ${err.message}`));
            }
            const entry = {
                data: res,
                meta: {
                    cachedAt: now,
                    collection: col,
                    populatedCollections: populatedCollections.length > 0 ? populatedCollections : undefined,
                    ttl
                }
            };
            if (populatedCollections.length > 0) {
                logger_1.default.debug(`[Cache] Storing cache for ${col} with populated: ${populatedCollections.join(', ')}`);
            }
            try {
                await cache_db_service_1.CacheDb.writeCache(key, entry);
            }
            catch (err) {
                logger_1.default.error('[CacheDb.cachePlugin] CacheDb.writeCache', err);
            }
            return res;
        };
        isOriginalExecPatched = true;
    }
    if (isAggregatePatched === false) {
        // This avoids edge cases if an error occurs during patching.
        isAggregatePatched = true;
        const originalAggregate = mongoose_1.default.Model.aggregate;
        mongoose_1.default.Model.aggregate = function (...args) {
            const agg = originalAggregate.apply(this, args);
            /*
             * NOTE: options may not be set yet if caller chains .option({ useCache: true }) after aggregate().
             * We check useCache at patch-time here for early bail-out, but also re-check inside agg.exec
             * to handle the chaining case correctly.
             */
            const useCacheAtPatchTime = agg.options?.useCache;
            const col = this.collection.name;
            logger_1.default.debug(`[Aggregate] Model.aggregate called on "${col}" | useCache at patch-time: ${useCacheAtPatchTime}`);
            // If useCache is explicitly false at patch-time, skip patching exec entirely.
            if (useCacheAtPatchTime === false) {
                logger_1.default.debug(`[Aggregate] Caching disabled (useCache=false) for "${col}" — skipping exec patch`);
                return agg;
            }
            const originalAggExec = agg.exec;
            agg.exec = async function () {
                const now = Date.now();
                // Re-read options here — caller may have chained .option({ useCache: true }) after aggregate()
                const useCache = agg.options?.useCache;
                let ttl = agg.options?.cacheTTL;
                logger_1.default.debug(`[Aggregate] agg.exec called on "${col}" | useCache at exec-time: ${useCache} | ttl: ${ttl}`);
                if (useCache === false || typeof useCache === 'undefined') {
                    /*
                     * Only warn when cache was expected at patch-time but is now gone — genuine bug.
                     * If it was never set (useCacheAtPatchTime is also undefined), this aggregate
                     * intentionally skips caching, so no warning needed.
                     */
                    if (useCacheAtPatchTime === true) {
                        logger_1.default.debug(`[Aggregate] useCache was true at patch-time but missing at exec-time for "${col}" — cache bypassed unexpectedly`);
                    }
                    return originalAggExec.call(this);
                }
                if (typeof ttl === 'undefined') {
                    ttl = cache_db_service_1.CacheDb.DEFAULT_TTL;
                }
                const key = cache_db_service_1.CacheDb.cacheKeyForAggregation(col, args);
                const isWriteOp = cache_db_service_1.CacheDb.isWriteAggregation(args[0]);
                logger_1.default.debug(`[Aggregate] key="${key}" | isWriteOp=${isWriteOp}`);
                // Handle write aggregations - execute and invalidate, but don't cache
                if (isWriteOp) {
                    logger_1.default.debug(`[Aggregate] Write operation detected on "${col}" — executing and invalidating cache`);
                    let res;
                    try {
                        res = await originalAggExec.call(this);
                    }
                    catch (err) {
                        logger_1.default.error('[CacheDb.aggregate] agg.exec (write)', err);
                        return new Error(`[CacheDb.aggregate] agg.exec: ${err.message}`);
                    }
                    try {
                        await cache_db_service_1.CacheDb.invalidateCollection(col);
                        logger_1.default.debug(`Cache invalidated via aggregation for collection: ${col}`);
                        logger_1.default.countReset(`Global cache hit: ${col}`);
                        logger_1.default.countReset(`Aggregate cache hit: ${col}`);
                    }
                    catch (err) {
                        logger_1.default.error('[CacheDb.aggregate] CacheDb.invalidateCollection', err);
                    }
                    return res;
                }
                // Handle read aggregations - use cache
                let cached = null;
                try {
                    cached = await cache_db_service_1.CacheDb.readCache(key);
                }
                catch (err) {
                    logger_1.default.error('[CacheDb.aggregate] CacheDb.readCache', err);
                }
                logger_1.default.debug(`[Aggregate] Cache check for "${col}" | cached=${cached !== null} | cachedAt=${cached?.meta?.cachedAt}`);
                if (isCacheValid(cached, now)) {
                    logger_1.default.count(`Aggregate cache hit: ${key}`);
                    return Promise.resolve(cached.data);
                }
                logger_1.default.debug(`[Aggregate] Cache MISS for "${col}" — executing aggregation and writing to cache`);
                let res;
                try {
                    res = await originalAggExec.call(this);
                }
                catch (err) {
                    logger_1.default.error('[CacheDb.aggregate] agg.exec', err);
                    return new Error(`[CacheDb.aggregate] agg.exec: ${err.message}`);
                }
                logger_1.default.debug(`[Aggregate] Writing cache for "${col}" | ttl=${ttl} | resultCount=${Array.isArray(res) ? res.length : 1}`);
                const entry = {
                    data: res,
                    meta: {
                        cachedAt: now,
                        collection: col,
                        ttl
                    }
                };
                try {
                    await cache_db_service_1.CacheDb.writeCache(key, entry);
                }
                catch (err) {
                    logger_1.default.error('[CacheDb.aggregate] CacheDb.writeCache', err);
                }
                return res;
            };
            return agg;
        };
    }
    // Patch Model.insertMany to invalidate cache
    if (isInsertManyPatched === false) {
        const originalInsertMany = mongoose_1.default.Model.insertMany;
        mongoose_1.default.Model.insertMany = async function (docs, options) {
            const col = this.collection.name;
            let res;
            try {
                res = await originalInsertMany.call(this, docs, options);
            }
            catch (err) {
                logger_1.default.error('[CacheDb.insertMany]', err);
                throw err;
            }
            try {
                await cache_db_service_1.CacheDb.invalidateCollection(col);
                logger_1.default.debug(`Cache invalidated via insertMany for collection: ${col}`);
                logger_1.default.countReset(`Global cache hit: ${col}`);
                logger_1.default.countReset(`Aggregate cache hit: ${col}`);
            }
            catch (err) {
                logger_1.default.error('[CacheDb.insertMany] CacheDb.invalidateCollection', err);
            }
            return res;
        };
        isInsertManyPatched = true;
    }
    // Patch Model.bulkWrite to invalidate cache
    if (isBulkWritePatched === false) {
        const originalBulkWrite = mongoose_1.default.Model.bulkWrite;
        mongoose_1.default.Model.bulkWrite = async function (writes, options) {
            const col = this.collection.name;
            let res;
            try {
                res = await originalBulkWrite.call(this, writes, options);
            }
            catch (err) {
                logger_1.default.error('[CacheDb.bulkWrite]', err);
                throw err;
            }
            try {
                await cache_db_service_1.CacheDb.invalidateCollection(col);
                logger_1.default.debug(`Cache invalidated via bulkWrite for collection: ${col}`);
                logger_1.default.countReset(`Global cache hit: ${col}`);
                logger_1.default.countReset(`Aggregate cache hit: ${col}`);
            }
            catch (err) {
                logger_1.default.error('[CacheDb.bulkWrite] CacheDb.invalidateCollection', err);
            }
            return res;
        };
        isBulkWritePatched = true;
    }
}
/**
 * Check if the cache plugin has been applied to Mongoose prototypes and Model methods.
 *
 *
 * @export
 * @returns {{aggregate: boolean; query: boolean; insertMany: boolean; bulkWrite: boolean; }}
 */
function getCachePatchStatus() {
    return {
        aggregate: isAggregatePatched,
        bulkWrite: isBulkWritePatched,
        insertMany: isInsertManyPatched,
        query: isOriginalExecPatched
    };
}
//# sourceMappingURL=cache-helper.js.map