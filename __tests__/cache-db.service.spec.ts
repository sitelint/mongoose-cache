import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type mongoose from 'mongoose';
import { MongoError } from 'mongodb';

import { CacheDb, type CacheEntry } from '../src/cache-db.service';

function createPoolClearedError() {
  const err = new MongoError('Connection pool for localhost:27017 was cleared');
  Object.defineProperty(err, 'name', { value: 'MongoPoolClearedError' });

  return err;
}

function createMockCollection(overrides: Record<string, any> = {}) {
  return {
    createIndex: mock.fn(() => Promise.resolve()),
    dropIndex: mock.fn(() => Promise.resolve()),
    deleteMany: mock.fn(() => Promise.resolve({ deletedCount: 1 })),
    findOne: mock.fn(() => Promise.resolve(null)),
    replaceOne: mock.fn(() => Promise.resolve({ modifiedCount: 1, upsertedCount: 0 })),
    ...overrides
  };
}

function createMockDb(collectionOverrides?: Record<string, any>) {
  return {
    collection: mock.fn(() => createMockCollection(collectionOverrides)),
    command: mock.fn(() => Promise.resolve({ size: 0 }))
  };
}

describe('#CacheDb', () => {
  beforeEach(() => {
    CacheDb.clearConnection();
  });

  afterEach(() => {
    CacheDb.clearConnection();
  });

  describe('#setConnection', () => {
    it('should set db when connection.db is available', () => {
      const mockDb = createMockDb();
      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      const statsPromise = CacheDb.getCacheStats();

      assert.notStrictEqual(statsPromise, undefined);
    });

    it('should set db on open event when connection.db is not yet available', async () => {
      const mockDb = createMockDb();
      let openCb: () => void;
      const connection = {
        db: undefined,
        once: mock.fn((_event: string, cb: () => void) => {
          openCb = cb;
        })
      } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      const beforeStats = await CacheDb.getCacheStats();

      assert.strictEqual(beforeStats.size, 0);

      (connection as any).db = mockDb;
      openCb!();

      const afterStats = await CacheDb.getCacheStats();

      assert.strictEqual(typeof afterStats.size, 'number');
    });
  });

  describe('#clearConnection', () => {
    it('should clear the db reference', async () => {
      const mockDb = createMockDb();
      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);
      CacheDb.clearConnection();

      const stats = await CacheDb.getCacheStats();

      assert.strictEqual(stats.size, 0);
    });
  });

  describe('#configure', () => {
    it('should set maxCacheSizeBytes', async () => {
      CacheDb.configure({ maxCacheSizeBytes: 1024 });

      const stats = await CacheDb.getCacheStats();

      assert.strictEqual(stats.max, 1024);
    });

    it('should unset maxCacheSizeBytes when not provided', async () => {
      CacheDb.configure({});

      const stats = await CacheDb.getCacheStats();

      assert.strictEqual(stats.max, undefined);
    });
  });

  describe('#cacheKey', () => {
    it('should generate a deterministic cache key from a query', () => {
      const mockModel = {
        collection: { name: 'test_collection' }
      };
      const query1 = {
        model: mockModel,
        getQuery: mock.fn()
      } as any;
      (query1.getQuery as any).mock.mockImplementation(() => ({
        name: 'Alice',
        age: 30
      }));

      const query2 = {
        model: mockModel,
        getQuery: mock.fn()
      } as any;
      (query2.getQuery as any).mock.mockImplementation(() => ({
        name: 'Alice',
        age: 30
      }));

      const query3 = {
        model: mockModel,
        getQuery: mock.fn()
      } as any;
      (query3.getQuery as any).mock.mockImplementation(() => ({ name: 'Bob' }));

      const key1 = CacheDb.cacheKey(query1);
      const key2 = CacheDb.cacheKey(query2);
      const key3 = CacheDb.cacheKey(query3);

      assert.strictEqual(key1, key2);
      assert.notStrictEqual(key1, key3);
    });

    it('should produce different keys for different collections', () => {
      const query1 = {
        model: { collection: { name: 'users' } },
        getQuery: mock.fn()
      } as any;
      (query1.getQuery as any).mock.mockImplementation(() => ({ _id: '123' }));

      const query2 = {
        model: { collection: { name: 'workspaces' } },
        getQuery: mock.fn()
      } as any;
      (query2.getQuery as any).mock.mockImplementation(() => ({ _id: '123' }));

      const key1 = CacheDb.cacheKey(query1);
      const key2 = CacheDb.cacheKey(query2);

      assert.notStrictEqual(key1, key2);
    });

    it('should produce a hex string of correct length', () => {
      const query = {
        model: { collection: { name: 'items' } },
        getQuery: mock.fn()
      } as any;
      (query.getQuery as any).mock.mockImplementation(() => ({ active: true }));

      const key = CacheDb.cacheKey(query);

      assert.strictEqual(typeof key, 'string');
      assert.strictEqual(key.length, 40);
    });
  });

  describe('#cacheKeyForAggregation', () => {
    it('should generate a key from collection and pipeline', () => {
      const pipeline = [{ $match: { active: true } }];

      const key = CacheDb.cacheKeyForAggregation('events', pipeline);

      assert.strictEqual(typeof key, 'string');
      assert.strictEqual(key.length, 40);
    });

    it('should produce same key for same input', () => {
      const pipeline = [{ $group: { _id: '$type', count: { $sum: 1 } } }];
      const key1 = CacheDb.cacheKeyForAggregation('logs', pipeline);
      const key2 = CacheDb.cacheKeyForAggregation('logs', pipeline);

      assert.strictEqual(key1, key2);
    });

    it('should produce different keys for different pipelines', () => {
      const pipeline1 = [{ $match: { status: 'active' } }];
      const pipeline2 = [{ $match: { status: 'inactive' } }];

      const key1 = CacheDb.cacheKeyForAggregation('sites', pipeline1);
      const key2 = CacheDb.cacheKeyForAggregation('sites', pipeline2);

      assert.notStrictEqual(key1, key2);
    });
  });

  describe('#isWriteAggregation', () => {
    it('should return true for $merge stage', () => {
      assert.strictEqual(CacheDb.isWriteAggregation([{ $merge: 'target' } as any]), true);
    });

    it('should return true for $out stage', () => {
      assert.strictEqual(CacheDb.isWriteAggregation([{ $out: 'target' } as any]), true);
    });

    it('should return false for read-only stages', () => {
      assert.strictEqual(CacheDb.isWriteAggregation([{ $match: { active: true } } as any]), false);
    });

    it('should return false for empty pipeline', () => {
      assert.strictEqual(CacheDb.isWriteAggregation([]), false);
    });

    it('should return true if any stage is a write stage', () => {
      assert.strictEqual(
        CacheDb.isWriteAggregation([{ $match: { active: true } } as any, { $merge: 'results' } as any]),
        true
      );
    });
  });

  describe('#readCache', () => {
    it('should return null when no db connection is set', async () => {
      const result = await CacheDb.readCache('test-key');

      assert.strictEqual(result, null);
    });

    it('should return null when document is not found', async () => {
      const mockCol = createMockCollection({
        findOne: mock.fn(() => Promise.resolve(null))
      });
      const mockDb = createMockDb();

      (mockDb.collection as any).mock.mockImplementation(() => mockCol);

      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      const result = await CacheDb.readCache('missing-key');

      assert.strictEqual(result, null);
      assert.strictEqual(mockCol.findOne.mock.calls.length, 1);
    });

    it('should return cache entry when document is found', async () => {
      const mockDoc = {
        data: { name: 'Alice' },
        meta: {
          cachedAt: 1000,
          collection: 'users',
          ttl: 60000
        }
      };
      const mockCol = createMockCollection({
        findOne: mock.fn(() => Promise.resolve(mockDoc))
      });
      const mockDb = createMockDb();

      (mockDb.collection as any).mock.mockImplementation(() => mockCol);

      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      const result = await CacheDb.readCache('test-key');

      assert.notStrictEqual(result, null);
      assert.deepStrictEqual(result!.data, { name: 'Alice' });
      assert.strictEqual(result!.meta.cachedAt, 1000);
      assert.strictEqual(result!.meta.collection, 'users');
    });

    it('should return null for MongoPoolClearedError', async () => {
      const mockCol = createMockCollection({
        findOne: mock.fn(() => Promise.reject(createPoolClearedError()))
      });
      const mockDb = createMockDb();

      (mockDb.collection as any).mock.mockImplementation(() => mockCol);

      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      const result = await CacheDb.readCache('test-key');

      assert.strictEqual(result, null);
    });
  });

  describe('#writeCache', () => {
    it('should return early when no db connection is set', async () => {
      await assert.doesNotReject(() =>
        CacheDb.writeCache('key', {
          data: {},
          meta: { cachedAt: 1, collection: 'c', ttl: 0 }
        })
      );
    });

    it('should call replaceOne with upsert', async () => {
      const mockCol = createMockCollection({
        replaceOne: mock.fn(() => Promise.resolve({ modifiedCount: 1, upsertedCount: 0 }))
      });
      const mockDb = createMockDb();

      (mockDb.collection as any).mock.mockImplementation(() => mockCol);

      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      const entry: CacheEntry = {
        data: { active: true },
        meta: {
          cachedAt: Date.now(),
          collection: 'sites',
          ttl: 60000
        }
      };

      await CacheDb.writeCache('key-1', entry);

      assert.strictEqual(mockCol.replaceOne.mock.calls.length, 1);
      const callArgs: any[] = (mockCol.replaceOne as any).mock.calls[0].arguments;
      assert.strictEqual(callArgs[0]._id, 'key-1');
      assert.strictEqual(callArgs[1].data, entry.data);
      assert.strictEqual(callArgs[2].upsert, true);
    });

    it('should add expiresAt when TTL is set', async () => {
      const mockCol = createMockCollection({
        replaceOne: mock.fn(() => Promise.resolve({ modifiedCount: 1, upsertedCount: 0 }))
      });
      const mockDb = createMockDb();

      (mockDb.collection as any).mock.mockImplementation(() => mockCol);

      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      const cachedAt = Date.now();
      const ttl = 60000;
      const entry: CacheEntry = {
        data: { active: true },
        meta: { cachedAt, collection: 'sites', ttl }
      };

      await CacheDb.writeCache('key-ttl', entry);

      const callArgs: any[] = (mockCol.replaceOne as any).mock.calls[0].arguments;
      assert.ok(callArgs[1].expiresAt instanceof Date);
      assert.strictEqual(callArgs[1].expiresAt.getTime(), cachedAt + ttl);
    });

    it('should skip write for MongoPoolClearedError', async () => {
      const mockCol = createMockCollection({
        replaceOne: mock.fn(() => Promise.reject(createPoolClearedError()))
      });
      const mockDb = createMockDb();

      (mockDb.collection as any).mock.mockImplementation(() => mockCol);

      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      await assert.doesNotReject(() =>
        CacheDb.writeCache('key', {
          data: {},
          meta: { cachedAt: 1, collection: 'c', ttl: 0 }
        })
      );
    });
  });

  describe('#invalidateCollection', () => {
    it('should return early when no db connection is set', async () => {
      await assert.doesNotReject(() => CacheDb.invalidateCollection('test-col'));
    });

    it('should call deleteMany with correct $or filter', async () => {
      const mockCol = createMockCollection({
        deleteMany: mock.fn(() => Promise.resolve({ deletedCount: 3 }))
      });
      const mockDb = createMockDb();

      (mockDb.collection as any).mock.mockImplementation(() => mockCol);

      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      await CacheDb.invalidateCollection('users');

      assert.strictEqual(mockCol.deleteMany.mock.calls.length, 1);
      const filter: any = (mockCol.deleteMany as any).mock.calls[0].arguments[0];
      assert.deepStrictEqual(filter.$or, [{ 'meta.collection': 'users' }, { 'meta.populatedCollections': 'users' }]);
    });

    it('should handle MongoPoolClearedError gracefully', async () => {
      const mockCol = createMockCollection({
        deleteMany: mock.fn(() => Promise.reject(createPoolClearedError()))
      });
      const mockDb = createMockDb();

      (mockDb.collection as any).mock.mockImplementation(() => mockCol);

      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      await assert.doesNotReject(() => CacheDb.invalidateCollection('users'));
    });
  });

  describe('#sweepExpired', () => {
    it('should return early when no db connection is set', async () => {
      await assert.doesNotReject(() => CacheDb.sweepExpired());
    });

    it('should call deleteMany with expiration expression', async () => {
      const mockCol = createMockCollection({
        deleteMany: mock.fn(() => Promise.resolve({ deletedCount: 0 }))
      });
      const mockDb = createMockDb();

      (mockDb.collection as any).mock.mockImplementation(() => mockCol);

      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      await CacheDb.sweepExpired();

      assert.strictEqual(mockCol.deleteMany.mock.calls.length, 1);
      const filter: any = (mockCol.deleteMany as any).mock.calls[0].arguments[0];
      assert.ok(filter.$expr);
      assert.strictEqual(filter['meta.ttl'].$type, 'number');
    });

    it('should handle MongoPoolClearedError gracefully', async () => {
      const mockCol = createMockCollection({
        deleteMany: mock.fn(() => Promise.reject(createPoolClearedError()))
      });
      const mockDb = createMockDb();

      (mockDb.collection as any).mock.mockImplementation(() => mockCol);

      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      await assert.doesNotReject(() => CacheDb.sweepExpired());
    });
  });

  describe('#initializeCacheDB', () => {
    it('should log warning when db is not ready', async () => {
      await CacheDb.initializeCacheDB();
    });

    it('should create all required indexes when db is ready', async () => {
      const mockCol = createMockCollection({
        createIndex: mock.fn(() => Promise.resolve('index-name'))
      });
      const mockDb = createMockDb();

      (mockDb.collection as any).mock.mockImplementation(() => mockCol);

      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      await CacheDb.initializeCacheDB();

      assert.strictEqual(mockCol.createIndex.mock.calls.length, 2);
      assert.strictEqual(mockCol.dropIndex.mock.calls.length, 1);
      assert.strictEqual((mockCol.dropIndex as any).mock.calls[0].arguments[0], 'expiresAt_1');
    });

    it('should handle errors during index creation', async () => {
      const mockCol = createMockCollection({
        createIndex: mock.fn(() => Promise.reject(new Error('Index creation failed')))
      });
      const mockDb = createMockDb();

      (mockDb.collection as any).mock.mockImplementation(() => mockCol);

      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      await CacheDb.initializeCacheDB();
    });
  });

  describe('#initializePeriodTasks', () => {
    afterEach(() => {
      mock.method(globalThis, 'setImmediate');
      CacheDb.clearConnection();
    });

    it('should call setImmediate with a function', () => {
      const setImmediateSpy = mock.method(globalThis, 'setImmediate', (fn: Function) => {
        return 1 as unknown as NodeJS.Immediate;
      });

      CacheDb.initializePeriodTasks({ sweepIntervalMs: 5000 });

      assert.strictEqual(setImmediateSpy.mock.calls.length, 1);
      assert.strictEqual(typeof (setImmediateSpy as any).mock.calls[0].arguments[0], 'function');
    });
  });

  describe('#getCacheSize', () => {
    it('should return 0 when no db connection is set', async () => {
      const size = await CacheDb.getCacheSize();

      assert.strictEqual(size, 0);
    });

    it('should return size from db.command result', async () => {
      const mockDb = createMockDb();

      (mockDb.command as any).mock.mockImplementation(() => Promise.resolve({ size: 102400 }));

      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      const size = await CacheDb.getCacheSize();

      assert.strictEqual(size, 102400);
    });

    it('should return 0 for MongoPoolClearedError', async () => {
      const mockDb = createMockDb();

      (mockDb.command as any).mock.mockImplementation(() => Promise.reject(createPoolClearedError()));

      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      const size = await CacheDb.getCacheSize();

      assert.strictEqual(size, 0);
    });

    it('should return 0 for other errors', async () => {
      const mockDb = createMockDb();

      (mockDb.command as any).mock.mockImplementation(() => Promise.reject(new Error('Unknown error')));

      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      const size = await CacheDb.getCacheSize();

      assert.strictEqual(size, 0);
    });
  });

  describe('#getCacheStats', () => {
    it('should return size and max limit', async () => {
      CacheDb.configure({ maxCacheSizeBytes: 2048 });
      const mockDb = createMockDb();

      (mockDb.command as any).mock.mockImplementation(() => Promise.resolve({ size: 512 }));

      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      const stats = await CacheDb.getCacheStats();

      assert.strictEqual(stats.size, 512);
      assert.strictEqual(stats.max, 2048);
    });
  });
});
