const { styleText } = require('node:util');

let hrstart;
let hrend;
let total = 0;

const ONE_THOUSAND = 1000;
const ONE_MILLION = 1000000;
const PREFIX = 0;

function formatTime(ms) {
  const date = new Date(ms);
  const minutes = date.getMinutes();
  const seconds = date.getSeconds();
  const miliseconds = date.getMilliseconds();

  let time = '';

  if (minutes === 0 && seconds === 0 && miliseconds === 0) {
    time += '< 1 ms';
  } else {
    time += minutes > PREFIX ? `${minutes}m ` : '';
    time += seconds > PREFIX ? `${seconds}s ` : '';
    time += miliseconds > PREFIX ? `${miliseconds}ms` : '';
  }

  return time;
}

function printDescription(description) {
  console.log(styleText('cyan', description));
}

function timeStart(taskName) {
  console.log(styleText('yellow', `[${taskName}]\n`));
  hrstart = process.hrtime();
}

function timeEnd() {
  hrend = process.hrtime(hrstart);
  const totalTimeInMilisecs = hrend[0] * ONE_THOUSAND + hrend[1] / ONE_MILLION;

  total += totalTimeInMilisecs;
  console.info(`Execution time: ${formatTime(totalTimeInMilisecs)}\n`);
}

function getTotalTime(reset) {
  const totalTime = formatTime(total);

  if (reset === true) {
    total = 0;
  }

  return totalTime;
}

function showTotalTime() {
  console.log(`Total time: ${getTotalTime(true)}\n`);
}

function success(taskName) {
  console.log(`[${taskName}]${styleText('green', ' Success')}`);
}

const task = {
  printDescription: printDescription,
  timeStart: timeStart,
  timeEnd: timeEnd,
  getTotalTime: getTotalTime,
  showTotalTime: showTotalTime,
  success: success
};

module.exports = task;
