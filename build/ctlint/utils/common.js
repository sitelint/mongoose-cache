const path = require('node:path');

function getTaskName(fileName) {
  return path.basename(fileName).split(/^(.*)(\.js|\.cjs)$/)[1];
}

const common = {
  getTaskName: getTaskName
};

module.exports = common;
