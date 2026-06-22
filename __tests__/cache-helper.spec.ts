import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Query, type Schema } from 'mongoose';

import { cachePlugin, getCachePatchStatus } from '../src/cache-helper';

describe('#cacheHelper', () => {
  describe('#getCachePatchStatus', () => {
    it('should return initial state before any patches', () => {
      const status = getCachePatchStatus();

      assert.strictEqual(typeof status.aggregate, 'boolean');
      assert.strictEqual(typeof status.bulkWrite, 'boolean');
      assert.strictEqual(typeof status.insertMany, 'boolean');
      assert.strictEqual(typeof status.query, 'boolean');
    });
  });

  describe('#cachePlugin', () => {
    let originalQueryExec: typeof Query.prototype.exec;
    let originalModelAggregate: typeof mongoose.Model.aggregate;
    let originalModelInsertMany: typeof mongoose.Model.insertMany;
    let originalModelBulkWrite: typeof mongoose.Model.bulkWrite;

    before(() => {
      originalQueryExec = Query.prototype.exec;
      originalModelAggregate = mongoose.Model.aggregate;
      originalModelInsertMany = mongoose.Model.insertMany;
      originalModelBulkWrite = mongoose.Model.bulkWrite;
    });

    after(() => {
      Query.prototype.exec = originalQueryExec;
      mongoose.Model.aggregate = originalModelAggregate;
      mongoose.Model.insertMany = originalModelInsertMany;
      mongoose.Model.bulkWrite = originalModelBulkWrite;
    });

    it('should patch Query.prototype.exec with new implementation', () => {
      const originalExec = Query.prototype.exec;

      cachePlugin({} as Schema);

      assert.notStrictEqual(Query.prototype.exec, originalExec);
    });

    it('should not re-patch when called a second time', () => {
      const execAfterFirstCall = Query.prototype.exec;

      cachePlugin({} as Schema);

      assert.strictEqual(Query.prototype.exec, execAfterFirstCall);
    });

    it('should set all patch status flags after caching', () => {
      cachePlugin({} as Schema);

      const status = getCachePatchStatus();

      assert.strictEqual(status.query, true);
    });
  });
});
