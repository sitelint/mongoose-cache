import mongoose, { type Aggregate, type AggregateOptions, Query, type PipelineStage, type Schema } from 'mongoose';

import { CacheDb, type CacheEntry } from './cache-db.service';
import logger from './logger';

let isOriginalExecPatched: boolean = false;
let isAggregatePatched: boolean = false;
let isInsertManyPatched: boolean = false;
let isBulkWritePatched: boolean = false;

/**
 * Check if a cache entry is still valid based on its TTL and freshness.
 *
 * @param {(CacheEntry | null)} entry
 * @param {number} now
 * @returns {boolean}
 */

function isCacheValid(entry: CacheEntry | null, now: number): boolean {
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
function extractPopulatedCollections(query: Query<any, any>): string[] {
  const collections: Set<string> = new Set();

  try {
    // Access Mongoose internal populate options
    const queryAny = query as any;

    const populateOptions = queryAny._mongooseOptions?.populate;

    if (!populateOptions) {
      return [];
    }

    // Recursive helper to extract collections from populate objects
    const extractFromPopulate = (pop: any): void => {
      if (typeof pop !== 'object' || pop === null || Array.isArray(pop)) {
        return;
      }

      // Try to get the model from the populate object
      if (pop.model) {
        const collectionName: string = pop.model.collection?.name;

        if (collectionName) {
          collections.add(collectionName);
        }
      }

      // If path is specified, try to resolve the model from the query's model
      if (pop.path && !pop.model && query.model) {
        try {
          const schemaPath = query.model.schema.path(pop.path);

          if (schemaPath && (schemaPath as any).options?.ref) {
            const refModel = query.model.db.model((schemaPath as any).options.ref);

            if (refModel?.collection?.name) {
              collections.add(refModel.collection.name);
              logger.debug(`[extractPopulatedCollections] Resolved ${pop.path} -> ${refModel.collection.name}`);
            }
          }
        } catch (err) {
          logger.error(`[extractPopulatedCollections] Error resolving path ${pop.path}:`, err);
        }
      }

      // Handle nested populates recursively
      if (pop.populate) {
        const nestedPops: any[] = Array.isArray(pop.populate) ? pop.populate : [pop.populate];

        for (const nestedPop of nestedPops) {
          extractFromPopulate(nestedPop);
        }
      }
    };

    // Handle different populate formats
    let populates: any[] = [];

    if (Array.isArray(populateOptions)) {
      populates = populateOptions;
    } else if (typeof populateOptions === 'object') {
      // Check if it's an object with populate field names as keys
      const keys: string[] = Object.keys(populateOptions);

      if (keys.length > 0 && populateOptions[keys[0]]?.path) {
        // It's an object like { apiToken: PopulateOptions, workspace: PopulateOptions }
        populates = Object.values(populateOptions);
      } else {
        // It's a single populate options object
        populates = [populateOptions];
      }
    }

    for (const pop of populates) {
      extractFromPopulate(pop);
    }

    if (collections.size > 0) {
      logger.debug(`[Cache] Detected populated collections: ${Array.from(collections).join(', ')}`);
    }
  } catch (err) {
    logger.error('[extractPopulatedCollections] Error extracting populated collections', err);
  }

  return Array.from(collections);
}

/**
 * Extract the database name from a Mongoose Model's connection.
 *
 * @param {mongoose.Model<any>} model
 * @returns {string}
 */
function getDbNameFromModel(model: mongoose.Model<any>): string {
  return model.db.db.databaseName;
}

/**
 * Apply caching plugin to Mongoose schema and patch prototypes once.
 *
 * This plugin enables disk-based caching for Mongoose queries and aggregations.
 * It automatically intercepts `.exec()` calls on supported operations and stores results
 * in a persistent cache layer with TTL and freshness tracking.
 *
 * Supports multiple databases — each database gets its own `_cache_entries` collection.
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

export function cachePlugin(schema: Schema): void {
  /*
    Register schema-specific hooks BEFORE the global-patches guard,
    so every model gets post('save') / insertMany / bulkWrite regardless
    of whether the global Query.prototype.exec and Model.aggregate
    have already been patched by an earlier model.
    Guard against fake/mock schemas (e.g. in tests) that lack schema.post.
  */

  if (typeof schema.post === 'function') {
    schema.post('save', async function () {
      const col: string = this.collection.name;
      const dbName: string = getDbNameFromModel(this.constructor as mongoose.Model<any>);

      try {
        await CacheDb.invalidateCollection(col, dbName);
        logger.debug(`Cache invalidated via save for collection: ${col} (db: ${dbName})`);

        logger.countReset(`Global cache hit: ${col}`);
        logger.countReset(`Aggregate cache hit: ${col}`);
      } catch (err) {
        logger.error('[CacheDb.save] CacheDb.invalidateCollection', err);
      }
    });
  }

  if (isOriginalExecPatched && isAggregatePatched) {
    return;
  }

  if (isOriginalExecPatched === false) {
    const originalExec: () => Promise<any> = Query.prototype.exec;

    Query.prototype.exec = async function (...args): Promise<any> {
      const now: number = Date.now();

      const destructiveOps: Set<string> = new Set([
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

      const op: string = (this as Query<any, any> & { op: string }).op;
      const col: string = this.model.collection.name;
      const dbName: string = getDbNameFromModel(this.model);

      // Handle destructive operations
      if (destructiveOps.has(op)) {
        let res: any;

        try {
          res = await originalExec.apply(this, args);
        } catch (err) {
          logger.error('[CacheDb.cachePlugin] Query.exec (destructive)', err);

          return new Error(`[CacheDb.cachePlugin] Query.exec: ${(err as Error).message}`);
        }

        try {
          await CacheDb.invalidateCollection(col, dbName);
          logger.debug(`Cache invalidated for collection: ${col} (db: ${dbName})`);

          logger.countReset(`Global cache hit: ${col}`);
          logger.countReset(`Aggregate cache hit: ${col}`);
        } catch (err) {
          logger.error('[CacheDb.cachePlugin] CacheDb.invalidateCollection', err);
        }

        return res;
      }

      // Handle cacheable read operations
      const cacheableOps: Set<string> = new Set(['find', 'findOne', 'findById']);

      if (cacheableOps.has(op) === false) {
        return originalExec.apply(this, args);
      }

      const useCache: undefined | boolean = this.get('useCache');
      let ttl: number | undefined = this.get('cacheTTL');

      if (typeof useCache === 'undefined' || useCache === false) {
        return originalExec.apply(this, args);
      }

      if (typeof ttl === 'undefined') {
        ttl = CacheDb.DEFAULT_TTL;
      }

      const key: string = CacheDb.cacheKey(this);

      let cached: CacheEntry | null = null;

      try {
        cached = await CacheDb.readCache(key, dbName);
      } catch (err) {
        logger.error('[CacheDb.cachePlugin] CacheDb.readCache', err);
      }

      if (isCacheValid(cached, now)) {
        logger.count(`Global cache hit: ${key}`);

        return Promise.resolve(cached.data);
      }

      // Extract populated collections BEFORE executing the query
      const populatedCollections: string[] = extractPopulatedCollections(this);

      let res: any;

      try {
        res = await originalExec.apply(this, args);
      } catch (err) {
        logger.error('[CacheDb.cachePlugin] Query.exec', err);

        return Promise.reject(new Error(`[CacheDb.cachePlugin] Query.exec: ${(err as Error).message}`));
      }

      const entry: CacheEntry = {
        data: res,
        meta: {
          cachedAt: now,
          collection: col,
          dbName,
          populatedCollections: populatedCollections.length > 0 ? populatedCollections : undefined,
          ttl
        }
      };

      if (populatedCollections.length > 0) {
        logger.debug(`[Cache] Storing cache for ${col} with populated: ${populatedCollections.join(', ')}`);
      }

      try {
        await CacheDb.writeCache(key, entry, dbName);
      } catch (err) {
        logger.error('[CacheDb.cachePlugin] CacheDb.writeCache', err);
      }

      return res;
    };

    isOriginalExecPatched = true;
  }

  if (isAggregatePatched === false) {
    // This avoids edge cases if an error occurs during patching.
    isAggregatePatched = true;

    const originalAggregate: {
      <R = any>(pipeline?: PipelineStage[], options?: AggregateOptions): Aggregate<R[]>;
      <R = any>(pipeline: PipelineStage[]): Aggregate<R[]>;
    } = mongoose.Model.aggregate;

    mongoose.Model.aggregate = function (...args: [pipeline: PipelineStage[]]): Aggregate<any[]> {
      const agg: mongoose.Aggregate<any[]> = originalAggregate.apply(this, args) as Aggregate<any[]>;

      /*
       * NOTE: options may not be set yet if caller chains .option({ useCache: true }) after aggregate().
       * We check useCache at patch-time here for early bail-out, but also re-check inside agg.exec
       * to handle the chaining case correctly.
       */
      const useCacheAtPatchTime: boolean | undefined = agg.options?.useCache;
      const col: string = this.collection.name;
      const dbName: string = getDbNameFromModel(this);

      logger.debug(
        `[Aggregate] Model.aggregate called on "${col}" (db: ${dbName}) | useCache at patch-time: ${useCacheAtPatchTime}`
      );

      // If useCache is explicitly false at patch-time, skip patching exec entirely.
      if (useCacheAtPatchTime === false) {
        logger.debug(`[Aggregate] Caching disabled (useCache=false) for "${col}" — skipping exec patch`);

        return agg;
      }

      const originalAggExec: () => Promise<any[]> = agg.exec;

      agg.exec = async function (): Promise<any> {
        const now: number = Date.now();

        // Re-read options here — caller may have chained .option({ useCache: true }) after aggregate()
        const useCache: boolean | undefined = agg.options?.useCache;
        let ttl: number | undefined = agg.options?.cacheTTL;

        logger.debug(`[Aggregate] agg.exec called on "${col}" | useCache at exec-time: ${useCache} | ttl: ${ttl}`);

        if (useCache === false || typeof useCache === 'undefined') {
          /*
           * Only warn when cache was expected at patch-time but is now gone — genuine bug.
           * If it was never set (useCacheAtPatchTime is also undefined), this aggregate
           * intentionally skips caching, so no warning needed.
           */
          if (useCacheAtPatchTime === true) {
            logger.debug(
              `[Aggregate] useCache was true at patch-time but missing at exec-time for "${col}" — cache bypassed unexpectedly`
            );
          }

          return originalAggExec.call(this);
        }

        if (typeof ttl === 'undefined') {
          ttl = CacheDb.DEFAULT_TTL;
        }

        const key: string = CacheDb.cacheKeyForAggregation(col, args, dbName);
        const isWriteOp: boolean = CacheDb.isWriteAggregation(args[0]);

        logger.debug(`[Aggregate] key="${key}" | isWriteOp=${isWriteOp}`);

        // Handle write aggregations - execute and invalidate, but don't cache
        if (isWriteOp) {
          logger.debug(`[Aggregate] Write operation detected on "${col}" — executing and invalidating cache`);

          let res: any[];

          try {
            res = await originalAggExec.call(this);
          } catch (err) {
            logger.error('[CacheDb.aggregate] agg.exec (write)', err);

            return new Error(`[CacheDb.aggregate] agg.exec: ${(err as Error).message}`);
          }

          try {
            await CacheDb.invalidateCollection(col, dbName);

            logger.debug(`Cache invalidated via aggregation for collection: ${col} (db: ${dbName})`);

            logger.countReset(`Global cache hit: ${col}`);
            logger.countReset(`Aggregate cache hit: ${col}`);
          } catch (err) {
            logger.error('[CacheDb.aggregate] CacheDb.invalidateCollection', err);
          }

          return res;
        }

        // Handle read aggregations - use cache
        let cached: CacheEntry | null = null;

        try {
          cached = await CacheDb.readCache(key, dbName);
        } catch (err) {
          logger.error('[CacheDb.aggregate] CacheDb.readCache', err);
        }

        logger.debug(
          `[Aggregate] Cache check for "${col}" | cached=${cached !== null} | cachedAt=${cached?.meta?.cachedAt}`
        );

        if (isCacheValid(cached, now)) {
          logger.count(`Aggregate cache hit: ${key}`);

          return Promise.resolve(cached.data);
        }

        logger.debug(`[Aggregate] Cache MISS for "${col}" — executing aggregation and writing to cache`);

        let res: any[];

        try {
          res = await originalAggExec.call(this);
        } catch (err) {
          logger.error('[CacheDb.aggregate] agg.exec', err);

          return new Error(`[CacheDb.aggregate] agg.exec: ${(err as Error).message}`);
        }

        logger.debug(
          `[Aggregate] Writing cache for "${col}" | ttl=${ttl} | resultCount=${Array.isArray(res) ? res.length : 1}`
        );

        const entry: CacheEntry = {
          data: res,
          meta: {
            cachedAt: now,
            collection: col,
            dbName,
            ttl
          }
        };

        try {
          await CacheDb.writeCache(key, entry, dbName);
        } catch (err) {
          logger.error('[CacheDb.aggregate] CacheDb.writeCache', err);
        }

        return res;
      };

      return agg;
    };
  }

  // Patch Model.insertMany to invalidate cache
  if (isInsertManyPatched === false) {
    const originalInsertMany = mongoose.Model.insertMany;

    mongoose.Model.insertMany = async function (docs: any[], options?: any): Promise<any> {
      const col: string = this.collection.name;
      const dbName: string = getDbNameFromModel(this);
      let res: any;

      try {
        res = await (originalInsertMany as any).call(this, docs, options);
      } catch (err) {
        logger.error('[CacheDb.insertMany]', err);
        throw err;
      }

      try {
        await CacheDb.invalidateCollection(col, dbName);
        logger.debug(`Cache invalidated via insertMany for collection: ${col} (db: ${dbName})`);

        logger.countReset(`Global cache hit: ${col}`);
        logger.countReset(`Aggregate cache hit: ${col}`);
      } catch (err) {
        logger.error('[CacheDb.insertMany] CacheDb.invalidateCollection', err);
      }

      return res;
    };

    isInsertManyPatched = true;
  }

  // Patch Model.bulkWrite to invalidate cache
  if (isBulkWritePatched === false) {
    const originalBulkWrite = mongoose.Model.bulkWrite;

    mongoose.Model.bulkWrite = async function (writes: any[], options?: any): Promise<any> {
      const col: string = this.collection.name;
      const dbName: string = getDbNameFromModel(this);
      let res: any;

      try {
        res = await (originalBulkWrite as any).call(this, writes, options);
      } catch (err) {
        logger.error('[CacheDb.bulkWrite]', err);
        throw err;
      }

      try {
        await CacheDb.invalidateCollection(col, dbName);
        logger.debug(`Cache invalidated via bulkWrite for collection: ${col} (db: ${dbName})`);

        logger.countReset(`Global cache hit: ${col}`);
        logger.countReset(`Aggregate cache hit: ${col}`);
      } catch (err) {
        logger.error('[CacheDb.bulkWrite] CacheDb.invalidateCollection', err);
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
export function getCachePatchStatus(): {
  aggregate: boolean;
  bulkWrite: boolean;
  insertMany: boolean;
  query: boolean;
} {
  return {
    aggregate: isAggregatePatched,
    bulkWrite: isBulkWritePatched,
    insertMany: isInsertManyPatched,
    query: isOriginalExecPatched
  };
}
