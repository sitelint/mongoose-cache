const task = require('../utils/task.js');
const commonUtils = require('../utils/common.js');
const shell = require('shelljs');

const constants = require('../constants');
const taskName = commonUtils.getTaskName(__filename);

function action(resolve, reject) {
  task.timeStart(taskName);

  function resultCallback(code) {
    if (code === constants.EXIT_SUCCESS) {
      task.success(taskName);
      task.timeEnd(taskName);
      resolve();

      return;
    }

    task.timeEnd(taskName);
    reject(`[${taskName}] TypeScript lint errors found. Code: ${code}`);
    shell.exit(code);
  }

  shell.exec('npm run lint', resultCallback);
}

module.exports = action;
