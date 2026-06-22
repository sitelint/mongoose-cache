const task = require('../utils/task.js');
const commonUtils = require('../utils/common.js');
const shell = require('shelljs');

const taskName = commonUtils.getTaskName(__filename);

function action(resolve, reject) {
  const EXIT_SUCCESS = 0;

  function resultCallback(code) {
    if (code === EXIT_SUCCESS) {
      task.success(taskName);
      task.timeEnd(taskName);

      resolve();

      return;
    }

    task.timeEnd();
    reject(`[${taskName}] There were errors in the tests! Code: ${code}`);
    shell.exit(code);
  }

  task.timeStart(taskName);
  shell.exec('npm test', resultCallback);
}

module.exports = action;
