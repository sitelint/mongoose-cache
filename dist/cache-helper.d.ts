import { type Schema } from 'mongoose';
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
export declare function cachePlugin(schema: Schema): void;
/**
 * Check if the cache plugin has been applied to Mongoose prototypes and Model methods.
 *
 *
 * @export
 * @returns {{aggregate: boolean; query: boolean; insertMany: boolean; bulkWrite: boolean; }}
 */
export declare function getCachePatchStatus(): {
    aggregate: boolean;
    bulkWrite: boolean;
    insertMany: boolean;
    query: boolean;
};
