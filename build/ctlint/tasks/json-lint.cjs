/* eslint-disable no-sync */
const path = require('node:path');
const shell = require('shelljs');
const glob = require('glob-all');

const task = require('../utils/task.js');
const commonUtils = require('../utils/common.js');
const taskName = commonUtils.getTaskName(__filename);
const root = path.resolve(__dirname, '../../..');
const EXIT_UNCAUGHT_FATAL_EXCEPTION = 1;

function action(resolve, reject) {
  const files = [`${root}/*.json`, `${root}/build/**/*.json`];

  function validJSON(file) {
    try {
      JSON.parse(shell.cat(file));
    } catch (err) {
      reject(`[${taskName}] File ${file} failed JSON validation.\n`);
      shell.exit(EXIT_UNCAUGHT_FATAL_EXCEPTION);
    }
  }

  task.timeStart(taskName);

  glob.sync(files).forEach(validJSON);

  task.success(taskName);
  task.timeEnd(taskName);
  resolve(`[${taskName}] No errors found in JSON files`);
}

module.exports = action;
