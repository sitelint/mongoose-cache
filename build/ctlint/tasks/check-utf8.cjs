/* eslint-disable no-sync */
const fs = require('node:fs');
const path = require('node:path');
const isUtf8 = require('is-utf8');
const glob = require('glob-all');

const task = require('../utils/task.js');
const commonUtils = require('../utils/common.js');
const constants = require('../constants');
const taskName = commonUtils.getTaskName(__filename);

function action(resolve, reject) {
  task.timeStart(taskName);

  const rootDir = path.resolve(__dirname, '../../..');
  const invalidUTF8files = [];

  const NO_INVALID_FILES = 0;
  const files = [
    `${rootDir}/src/**/*.ts`,
    `${rootDir}/__tests__/**/*.ts`,
    `${rootDir}/build/**/*.js`,
    `${rootDir}/build/**/*.cjs`,
    `${rootDir}/*.json`
  ];
  const allFiles = glob.sync(files);

  for (const file of allFiles) {
    if (isUtf8(fs.readFileSync(file)) === false) {
      invalidUTF8files.push(file);
    }
  }

  if (invalidUTF8files.length === NO_INVALID_FILES) {
    task.success(taskName);
    task.timeEnd(taskName);
    resolve();

    return;
  }

  console.log(JSON.stringify(invalidUTF8files, null, constants.JSON_AMOUNT_OF_WHITESPACE));

  task.timeEnd(taskName);
  reject(`[${taskName}] There are files that are not UTF-8 valid!`);
}

module.exports = action;
