/* eslint-disable no-sync */
const path = require('node:path');
const fs = require('node:fs');
const glob = require('glob-all');
const shell = require('shelljs');

const task = require('../utils/task.js');
const commonUtils = require('../utils/common.js');
const constants = require('../constants');
const taskName = commonUtils.getTaskName(__filename);
const rootDir = path.resolve(__dirname, '../../..');
const EXIT_UNCAUGHT_FATAL_EXCEPTION = 1;

function action(resolve, reject) {
  task.timeStart(taskName);

  const MAXIMUM_AMOUNT_OF_PENDING_UNIT_TESTS = 10;

  const forbiddenMethods = ['describe.only', 'it.only', 'test.only'];

  const pendingMethods = ['describe.skip', 'xdescribe', 'it.skip', 'xit', 'test.skip', 'xtest'];

  const filesWithForbiddenRules = [];
  const filesWithPendingRules = [];

  function testForUnexpectedMethod(file) {
    const content = fs.readFileSync(file, 'utf-8');

    function checkForForbiddenRules(method) {
      const regex = new RegExp(`\\s?${method.replace('.', '\\.')}\\s?\\(?`, 'gmi');

      if (regex.test(content)) {
        filesWithForbiddenRules.push({
          file: file,
          method: method
        });
      }
    }

    function checkForPendingRules(method) {
      const regex = new RegExp(`\\s?${method.replace('.', '\\.')}\\s?\\(?`, 'gmi');

      if (regex.test(content)) {
        filesWithPendingRules.push({
          file: file,
          method: method
        });
      }
    }

    forbiddenMethods.forEach(checkForForbiddenRules);
    pendingMethods.forEach(checkForPendingRules);
  }

  const files = [`${rootDir}/__tests__/**/*.spec.ts`];
  const allFiles = glob.sync(files);
  const NO_INVALID_FILES = 0;

  for (const file of allFiles) {
    testForUnexpectedMethod(file);
  }

  if (filesWithPendingRules.length > NO_INVALID_FILES) {
    if (filesWithPendingRules.length <= MAXIMUM_AMOUNT_OF_PENDING_UNIT_TESTS) {
      console.log(
        `[${taskName}] Pending rules found\n`,
        JSON.stringify(filesWithPendingRules, null, constants.JSON_AMOUNT_OF_WHITESPACE),
        '\n'
      );
    } else {
      console.log(JSON.stringify(filesWithPendingRules, null, constants.JSON_AMOUNT_OF_WHITESPACE), '\n');
      task.timeEnd(taskName);
      reject(
        `[${taskName}] The total amount ${filesWithPendingRules.length} of allowable (${MAXIMUM_AMOUNT_OF_PENDING_UNIT_TESTS}) pending rules has been exceeded. Fix the unit tests to reduce total amount of pending tests.`
      );
      shell.exit(EXIT_UNCAUGHT_FATAL_EXCEPTION);
    }
  }

  if (filesWithForbiddenRules.length === NO_INVALID_FILES) {
    task.success(taskName);
    task.timeEnd(taskName);

    resolve();

    return;
  }

  console.log(
    `[${taskName}] Limit rules found\n`,
    JSON.stringify(filesWithForbiddenRules, null, constants.JSON_AMOUNT_OF_WHITESPACE)
  );
  task.timeEnd();
  reject(`[${taskName}] Limit rules found`);
  shell.exit(EXIT_UNCAUGHT_FATAL_EXCEPTION);
}

module.exports = action;
