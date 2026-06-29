/* eslint-disable no-sync */
const fs = require('node:fs');
const path = require('node:path');
const shell = require('shelljs');

const task = require('../utils/task.js');
const commonUtils = require('../utils/common.js');
const constants = require('../constants');
const taskName = commonUtils.getTaskName(__filename);

function restoreCwd(originalCwd) {
  shell.cd(originalCwd);
}

function resolvePrettierPath(baseDir) {
  const prettierPath = shell.which('prettier');

  if (prettierPath) {
    return prettierPath;
  }

  const localPrettierPath = path.resolve(
    baseDir,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'prettier.cmd' : 'prettier'
  );

  return fs.existsSync(localPrettierPath) ? localPrettierPath : null;
}

function action(resolve, reject) {
  task.timeStart(taskName);

  const rootResult = shell.exec('git rev-parse --show-toplevel', {
    silent: true
  });

  if (rootResult.code !== constants.EXIT_SUCCESS) {
    reject(`[${taskName}] Not a git repository`);

    return;
  }

  const originalCwd = process.cwd();

  shell.cd(rootResult.stdout.trim());

  const statusResult = shell.exec('git status --porcelain', { silent: true });

  if (statusResult.code !== constants.EXIT_SUCCESS) {
    restoreCwd(originalCwd);
    reject(`[${taskName}] Git status failed`);

    return;
  }

  const lines = statusResult.stdout.split('\n').filter(Boolean);

  if (lines.length === 0) {
    restoreCwd(originalCwd);
    task.success(taskName);
    task.timeEnd(taskName);
    resolve();

    return;
  }

  const files = lines
    .filter((line) => !line.slice(0, 2).includes('D'))
    .map((line) => {
      const filePath = line.slice(3).trim();
      const arrowIndex = filePath.indexOf(' -> ');

      return arrowIndex > -1 ? filePath.slice(arrowIndex + 4) : filePath;
    })
    .filter((filePath) => /\.(ts|js|mjs|cjs)$/i.test(filePath))
    .filter((filePath) => fs.existsSync(filePath));

  if (files.length === 0) {
    restoreCwd(originalCwd);
    task.success(taskName);
    task.timeEnd(taskName);
    resolve();

    return;
  }

  const prettierPath = resolvePrettierPath(originalCwd);

  if (!prettierPath) {
    restoreCwd(originalCwd);
    reject(`[${taskName}] prettier not found`);

    return;
  }

  const prettierResult = shell.exec(`"${prettierPath}" --write ${files.map((f) => `"${f}"`).join(' ')}`, {
    silent: true
  });

  restoreCwd(originalCwd);

  if (prettierResult.code !== constants.EXIT_SUCCESS) {
    reject(`[${taskName}] Prettier failed: ${prettierResult.stderr}`);

    return;
  }

  if (prettierResult.stdout) {
    console.log(prettierResult.stdout);
  }

  task.success(taskName);
  task.timeEnd(taskName);
  resolve();
}

module.exports = action;
