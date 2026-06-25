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
    deleteMany: mock.fn(() => Promise.resolve({ deletedCount: 1 })),
    dropIndex: mock.fn(() => Promise.resolve()),
    findOne: mock.fn(() => Promise.resolve(null)),
    replaceOne: mock.fn(() => Promise.resolve({ modifiedCount: 1, upsertedCount: 0 })),
    ...overrides
  };
}

function createMockDb(dbName: string = 'testDb', collectionOverrides?: Record<string, any>) {
  return {
    collection: mock.fn(() => createMockCollection(collectionOverrides)),
    command: mock.fn(() => Promise.resolve({ size: 0 })),
    databaseName: dbName
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
    it('should register db in the map when connection.db is available', () => {
      const mockDb = createMockDb('appDb');
      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      assert.deepStrictEqual(CacheDb.getAllDbNames(), ['appDb']);
    });

    it('should register db on open event when connection.db is not yet available', async () => {
      const mockDb = createMockDb('appDb');
      let openCb: () => void;
      const connection = {
        db: undefined,
        once: mock.fn((_event: string, cb: () => void) => {
          openCb = cb;
        })
      } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      assert.deepStrictEqual(CacheDb.getAllDbNames(), []);
      assert.strictEqual(await CacheDb.getCacheSize(), 0);

      (connection as any).db = mockDb;
      openCb!();

      assert.deepStrictEqual(CacheDb.getAllDbNames(), ['appDb']);
    });

    it('should register multiple databases', () => {
      const auditDb = createMockDb('auditDb');
      const appDb = createMockDb('appDb');

      CacheDb.setConnection({ db: auditDb } as unknown as mongoose.Connection);
      CacheDb.setConnection({ db: appDb } as unknown as mongoose.Connection);

      assert.deepStrictEqual(CacheDb.getAllDbNames().sort(), ['appDb', 'auditDb']);
    });
  });

  describe('#clearConnection', () => {
    it('should clear all registered databases', () => {
      const mockDb = createMockDb('appDb');
      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      assert.strictEqual(CacheDb.getAllDbNames().length, 1);

      CacheDb.clearConnection();

      assert.strictEqual(CacheDb.getAllDbNames().length, 0);
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
    it('should generate a deterministic cache key including dbName from the query', () => {
      const mockDb = { databaseName: 'testDb' };
      const mockModel = {
        collection: { name: 'test_collection' },
        db: { db: mockDb }
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

      const key1 = CacheDb.cacheKey(query1);
      const key2 = CacheDb.cacheKey(query2);

      assert.strictEqual(key1, key2);
    });

    it('should produce different keys for different databases', () => {
      const db1 = { databaseName: 'dbOne' };
      const db2 = { databaseName: 'dbTwo' };
      const query1 = {
        model: { collection: { name: 'users' }, db: { db: db1 } },
        getQuery: mock.fn()
      } as any;
      (query1.getQuery as any).mock.mockImplementation(() => ({ _id: '123' }));

      const query2 = {
        model: { collection: { name: 'users' }, db: { db: db2 } },
        getQuery: mock.fn()
      } as any;
      (query2.getQuery as any).mock.mockImplementation(() => ({ _id: '123' }));

      const key1 = CacheDb.cacheKey(query1);
      const key2 = CacheDb.cacheKey(query2);

      assert.notStrictEqual(key1, key2);
    });

    it('should produce a hex string of correct length', () => {
      const mockDb = { databaseName: 'items' };
      const query = {
        model: { collection: { name: 'items' }, db: { db: mockDb } },
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

    it('should include dbName when provided', () => {
      const pipeline = [{ $match: { active: true } }];

      const key1 = CacheDb.cacheKeyForAggregation('events', pipeline, 'dbA');
      const key2 = CacheDb.cacheKeyForAggregation('events', pipeline, 'dbB');

      assert.notStrictEqual(key1, key2);
    });

    it('should produce same key for same input', () => {
      const pipeline = [{ $group: { _id: '$type', count: { $sum: 1 } } }];
      const key1 = CacheDb.cacheKeyForAggregation('logs', pipeline, 'dbA');
      const key2 = CacheDb.cacheKeyForAggregation('logs', pipeline, 'dbA');

      assert.strictEqual(key1, key2);
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
      const mockDb = createMockDb('appDb');

      (mockDb.collection as any).mock.mockImplementation(() => mockCol);

      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      const result = await CacheDb.readCache('missing-key', 'appDb');

      assert.strictEqual(result, null);
      assert.strictEqual(mockCol.findOne.mock.calls.length, 1);
    });

    it('should return cache entry when document is found', async () => {
      const mockDoc = {
        data: { name: 'Alice' },
        meta: {
          cachedAt: 1000,
          collection: 'users',
          dbName: 'appDb',
          ttl: 60000
        }
      };
      const mockCol = createMockCollection({
        findOne: mock.fn(() => Promise.resolve(mockDoc))
      });
      const mockDb = createMockDb('appDb');

      (mockDb.collection as any).mock.mockImplementation(() => mockCol);

      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      const result = await CacheDb.readCache('test-key', 'appDb');

      assert.notStrictEqual(result, null);
      assert.deepStrictEqual(result!.data, { name: 'Alice' });
      assert.strictEqual(result!.meta.cachedAt, 1000);
      assert.strictEqual(result!.meta.collection, 'users');
      assert.strictEqual(result!.meta.dbName, 'appDb');
    });

    it('should return null for MongoPoolClearedError', async () => {
      const mockCol = createMockCollection({
        findOne: mock.fn(() => Promise.reject(createPoolClearedError()))
      });
      const mockDb = createMockDb('appDb');

      (mockDb.collection as any).mock.mockImplementation(() => mockCol);

      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      const result = await CacheDb.readCache('test-key', 'appDb');

      assert.strictEqual(result, null);
    });
  });

  describe('#writeCache', () => {
    it('should return early when no db connection is set', async () => {
      await assert.doesNotReject(() =>
        CacheDb.writeCache('key', {
          data: {},
          meta: { cachedAt: 1, collection: 'c', dbName: 'db', ttl: 0 }
        })
      );
    });

    it('should call replaceOne with upsert', async () => {
      const mockCol = createMockCollection({
        replaceOne: mock.fn(() => Promise.resolve({ modifiedCount: 1, upsertedCount: 0 }))
      });
      const mockDb = createMockDb('appDb');

      (mockDb.collection as any).mock.mockImplementation(() => mockCol);

      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      const entry: CacheEntry = {
        data: { active: true },
        meta: {
          cachedAt: Date.now(),
          collection: 'sites',
          dbName: 'appDb',
          ttl: 60000
        }
      };

      await CacheDb.writeCache('key-1', entry, 'appDb');

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
      const mockDb = createMockDb('appDb');

      (mockDb.collection as any).mock.mockImplementation(() => mockCol);

      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      const cachedAt = Date.now();
      const ttl = 60000;
      const entry: CacheEntry = {
        data: { active: true },
        meta: { cachedAt, collection: 'sites', dbName: 'appDb', ttl }
      };

      await CacheDb.writeCache('key-ttl', entry, 'appDb');

      const callArgs: any[] = (mockCol.replaceOne as any).mock.calls[0].arguments;
      assert.ok(callArgs[1].expiresAt instanceof Date);
      assert.strictEqual(callArgs[1].expiresAt.getTime(), cachedAt + ttl);
    });

    it('should skip write for MongoPoolClearedError', async () => {
      const mockCol = createMockCollection({
        replaceOne: mock.fn(() => Promise.reject(createPoolClearedError()))
      });
      const mockDb = createMockDb('appDb');

      (mockDb.collection as any).mock.mockImplementation(() => mockCol);

      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      await assert.doesNotReject(() =>
        CacheDb.writeCache(
          'key',
          {
            data: {},
            meta: { cachedAt: 1, collection: 'c', dbName: 'appDb', ttl: 0 }
          },
          'appDb'
        )
      );
    });
  });

  describe('#invalidateCollection', () => {
    it('should return early when no db connection is set', async () => {
      await assert.doesNotReject(() => CacheDb.invalidateCollection('test-col'));
    });

    it('should invalidate in all registered databases when no dbName specified', async () => {
      const mockCol1 = createMockCollection({
        deleteMany: mock.fn(() => Promise.resolve({ deletedCount: 3 }))
      });
      const mockCol2 = createMockCollection({
        deleteMany: mock.fn(() => Promise.resolve({ deletedCount: 1 }))
      });
      const auditDb = createMockDb('auditDb');
      const appDb = createMockDb('appDb');

      (auditDb.collection as any).mock.mockImplementation(() => mockCol1);
      (appDb.collection as any).mock.mockImplementation(() => mockCol2);

      CacheDb.setConnection({ db: auditDb } as unknown as mongoose.Connection);
      CacheDb.setConnection({ db: appDb } as unknown as mongoose.Connection);

      await CacheDb.invalidateCollection('users');

      assert.strictEqual(mockCol1.deleteMany.mock.calls.length, 1);
      assert.strictEqual(mockCol2.deleteMany.mock.calls.length, 1);
    });

    it('should invalidate only in specified database when dbName provided', async () => {
      const mockCol1 = createMockCollection({
        deleteMany: mock.fn(() => Promise.resolve({ deletedCount: 3 }))
      });
      const mockCol2 = createMockCollection({
        deleteMany: mock.fn(() => Promise.resolve({ deletedCount: 1 }))
      });
      const auditDb = createMockDb('auditDb');
      const appDb = createMockDb('appDb');

      (auditDb.collection as any).mock.mockImplementation(() => mockCol1);
      (appDb.collection as any).mock.mockImplementation(() => mockCol2);

      CacheDb.setConnection({ db: auditDb } as unknown as mongoose.Connection);
      CacheDb.setConnection({ db: appDb } as unknown as mongoose.Connection);

      await CacheDb.invalidateCollection('users', 'auditDb');

      assert.strictEqual(mockCol1.deleteMany.mock.calls.length, 1);
      assert.strictEqual(mockCol2.deleteMany.mock.calls.length, 0);
    });

    it('should handle MongoPoolClearedError gracefully', async () => {
      const mockCol = createMockCollection({
        deleteMany: mock.fn(() => Promise.reject(createPoolClearedError()))
      });
      const mockDb = createMockDb('appDb');

      (mockDb.collection as any).mock.mockImplementation(() => mockCol);

      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      await assert.doesNotReject(() => CacheDb.invalidateCollection('users', 'appDb'));
    });
  });

  describe('#clearAllCache', () => {
    it('should return early when no db connection is set', async () => {
      await assert.doesNotReject(() => CacheDb.clearAllCache());
    });

    it('should clear cache across all registered databases', async () => {
      const mockCol1 = createMockCollection({
        deleteMany: mock.fn(() => Promise.resolve({ deletedCount: 5 }))
      });
      const mockCol2 = createMockCollection({
        deleteMany: mock.fn(() => Promise.resolve({ deletedCount: 3 }))
      });
      const auditDb = createMockDb('auditDb');
      const appDb = createMockDb('appDb');

      (auditDb.collection as any).mock.mockImplementation(() => mockCol1);
      (appDb.collection as any).mock.mockImplementation(() => mockCol2);

      CacheDb.setConnection({ db: auditDb } as unknown as mongoose.Connection);
      CacheDb.setConnection({ db: appDb } as unknown as mongoose.Connection);

      await CacheDb.clearAllCache();

      assert.strictEqual(mockCol1.deleteMany.mock.calls.length, 1);
      assert.strictEqual(mockCol2.deleteMany.mock.calls.length, 1);
    });

    it('should clear with empty filter to delete all entries', async () => {
      const mockCol = createMockCollection({
        deleteMany: mock.fn(() => Promise.resolve({ deletedCount: 10 }))
      });
      const mockDb = createMockDb('appDb');

      (mockDb.collection as any).mock.mockImplementation(() => mockCol);

      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      await CacheDb.clearAllCache();

      assert.strictEqual(mockCol.deleteMany.mock.calls.length, 1);
      const callArgs: any[] = (mockCol.deleteMany as any).mock.calls[0].arguments;
      assert.deepStrictEqual(callArgs[0], {});
    });

    it('should handle MongoPoolClearedError gracefully', async () => {
      const mockCol = createMockCollection({
        deleteMany: mock.fn(() => Promise.reject(createPoolClearedError()))
      });
      const mockDb = createMockDb('appDb');

      (mockDb.collection as any).mock.mockImplementation(() => mockCol);

      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      await assert.doesNotReject(() => CacheDb.clearAllCache());
    });

    it('should handle generic errors without throwing', async () => {
      const mockCol = createMockCollection({
        deleteMany: mock.fn(() => Promise.reject(new Error('Generic DB error')))
      });
      const mockDb = createMockDb('appDb');

      (mockDb.collection as any).mock.mockImplementation(() => mockCol);

      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      await assert.doesNotReject(() => CacheDb.clearAllCache());
    });
  });

  describe('#sweepExpired', () => {
    it('should return early when no db connection is set', async () => {
      await assert.doesNotReject(() => CacheDb.sweepExpired());
    });

    it('should sweep across all registered databases', async () => {
      const mockCol1 = createMockCollection({
        deleteMany: mock.fn(() => Promise.resolve({ deletedCount: 0 }))
      });
      const mockCol2 = createMockCollection({
        deleteMany: mock.fn(() => Promise.resolve({ deletedCount: 0 }))
      });
      const auditDb = createMockDb('auditDb');
      const appDb = createMockDb('appDb');

      (auditDb.collection as any).mock.mockImplementation(() => mockCol1);
      (appDb.collection as any).mock.mockImplementation(() => mockCol2);

      CacheDb.setConnection({ db: auditDb } as unknown as mongoose.Connection);
      CacheDb.setConnection({ db: appDb } as unknown as mongoose.Connection);

      await CacheDb.sweepExpired();

      assert.strictEqual(mockCol1.deleteMany.mock.calls.length, 1);
      assert.strictEqual(mockCol2.deleteMany.mock.calls.length, 1);
    });

    it('should handle MongoPoolClearedError gracefully', async () => {
      const mockCol = createMockCollection({
        deleteMany: mock.fn(() => Promise.reject(createPoolClearedError()))
      });
      const mockDb = createMockDb('appDb');

      (mockDb.collection as any).mock.mockImplementation(() => mockCol);

      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      await assert.doesNotReject(() => CacheDb.sweepExpired());
    });
  });

  describe('#initializeCacheDB', () => {
    it('should warn when no dbs registered', async () => {
      await CacheDb.initializeCacheDB();
    });

    it('should create indexes in all registered databases', async () => {
      const mockCol1 = createMockCollection({
        createIndex: mock.fn(() => Promise.resolve('index-name'))
      });
      const mockCol2 = createMockCollection({
        createIndex: mock.fn(() => Promise.resolve('index-name'))
      });
      const auditDb = createMockDb('auditDb');
      const appDb = createMockDb('appDb');

      (auditDb.collection as any).mock.mockImplementation(() => mockCol1);
      (appDb.collection as any).mock.mockImplementation(() => mockCol2);

      CacheDb.setConnection({ db: auditDb } as unknown as mongoose.Connection);
      CacheDb.setConnection({ db: appDb } as unknown as mongoose.Connection);

      await CacheDb.initializeCacheDB();

      // 3 indexes + 1 dropIndex call per db
      assert.strictEqual(mockCol1.createIndex.mock.calls.length, 3);
      assert.strictEqual(mockCol1.dropIndex.mock.calls.length, 1);
      assert.strictEqual(mockCol2.createIndex.mock.calls.length, 3);
      assert.strictEqual(mockCol2.dropIndex.mock.calls.length, 1);
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

    it('should aggregate size across all registered databases', async () => {
      const auditDb = createMockDb('auditDb');
      const appDb = createMockDb('appDb');

      (auditDb.command as any).mock.mockImplementation(() => Promise.resolve({ size: 512 }));
      (appDb.command as any).mock.mockImplementation(() => Promise.resolve({ size: 256 }));

      CacheDb.setConnection({ db: auditDb } as unknown as mongoose.Connection);
      CacheDb.setConnection({ db: appDb } as unknown as mongoose.Connection);

      const size = await CacheDb.getCacheSize();

      assert.strictEqual(size, 768);
    });

    it('should return size for specific database', async () => {
      const mockDb = createMockDb('appDb');

      (mockDb.command as any).mock.mockImplementation(() => Promise.resolve({ size: 102400 }));

      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      const size = await CacheDb.getCacheSize('appDb');

      assert.strictEqual(size, 102400);
    });
  });

  describe('#getCacheStats', () => {
    it('should aggregate stats across all databases', async () => {
      CacheDb.configure({ maxCacheSizeBytes: 2048 });
      const mockDb = createMockDb('appDb');

      (mockDb.command as any).mock.mockImplementation(() => Promise.resolve({ size: 512 }));

      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      const stats = await CacheDb.getCacheStats();

      assert.strictEqual(stats.size, 512);
      assert.strictEqual(stats.max, 2048);
    });
  });

  describe('#getCacheStatsForDb', () => {
    it('should return stats for a specific database', async () => {
      CacheDb.configure({ maxCacheSizeBytes: 1024 });
      const mockDb = createMockDb('auditDb');

      (mockDb.command as any).mock.mockImplementation(() => Promise.resolve({ size: 256 }));

      const connection = { db: mockDb } as unknown as mongoose.Connection;

      CacheDb.setConnection(connection);

      const stats = await CacheDb.getCacheStatsForDb('auditDb');

      assert.strictEqual(stats.size, 256);
      assert.strictEqual(stats.max, 1024);
      assert.strictEqual(stats.dbName, 'auditDb');
    });
  });
});
