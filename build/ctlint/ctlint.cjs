/* eslint-disable no-sync */
/**
 * @fileoverview CTLint - applying predefined rules against code changes.
 */

/* eslint no-console: 0, no-undef: 0 */

const fs = require('node:fs');
const path = require('node:path');
const { styleText } = require('node:util');

let config = [];

try {
  config = JSON.parse(fs.readFileSync(path.resolve(`${process.cwd()}/ctlint.json`), 'utf-8')).tasks;
} catch {
  // ctlint.json may not exist at CWD; --config flag provides it in start()
}
const taskUtil = require('./utils/task.js');

let singleTaskName;

function exitError(message) {
  console.error(styleText('bgRed', styleText('white', 'CTLint error:')), `${message}\n`);

  const EXIT_UNCAUGHT_FATAL_EXCEPTION = 1;

  process.exit(EXIT_UNCAUGHT_FATAL_EXCEPTION);
}

function getTask(taskName) {
  return require(`${__dirname}/tasks/${taskName}.cjs`);
}

function wrapTask(fn) {
  return function () {
    return new Promise(fn);
  };
}

function onCompleted() {
  console.log(styleText('green', 'CTLint work has been done successfully'));
  taskUtil.showTotalTime();
}

function getSingleTaskName(args) {
  function task(arg) {
    const parts = arg.split('--');

    if (typeof parts[1] === 'string' && parts[1].trim().length > 0) {
      return true;
    }

    return false;
  }

  const index = args.findIndex(task);
  let taskName;

  if (typeof index === 'number' && index !== -1) {
    taskName = args[index].split('--')[1].trim();
  }

  return taskName;
}

/*
 * Note: the arguments must be passed in a way -- task-name
 * Example: node build/ctlint/ctlint.cjs start -- process-dashboard-translations
 */
async function start() {
  let tasks;

  console.log(`\n${styleText('bgBlue', 'CTLint Started')}\n`);

  let args = process.argv.slice(2);

  if (args.includes('--config')) {
    const configIndex = args.indexOf('--config') + 1;

    config = JSON.parse(fs.readFileSync(path.resolve(args[configIndex]), 'utf-8')).tasks;
    args = args.slice(configIndex);
  }

  singleTaskName = getSingleTaskName(args);

  if (typeof singleTaskName === 'string') {
    tasks = [singleTaskName].map(getTask).map(wrapTask);
  } else {
    tasks = config.map(getTask).map(wrapTask);
  }

  for (const task of tasks) {
    try {
      await task();
    } catch (e) {
      exitError(e);
    }
  }

  onCompleted();
}

module.exports = start;

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
