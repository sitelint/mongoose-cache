/* eslint-disable no-sync */
const task = require('../utils/task.js');
const shell = require('shelljs');
const fs = require('node:fs');

const PACKAGE_JSON = 'package.json';

function getPackageVersion() {
  const packageJSONstr = fs.readFileSync(PACKAGE_JSON, 'utf-8');
  const packageJSON = JSON.parse(packageJSONstr);

  return packageJSON.version;
}

function incrementVersion(releaseType) {
  let packageJSONstr = fs.readFileSync(PACKAGE_JSON, 'utf-8');
  const packageJSON = JSON.parse(packageJSONstr);

  let versionPartToIncrement = -1;

  switch (releaseType.toLowerCase()) {
    case 'major':
      versionPartToIncrement = 0;
      break;

    case 'minor':
      versionPartToIncrement = 1;
      break;

    case 'patch':
      versionPartToIncrement = 2;
      break;

    default:
      throw new Error(`Invalid release type, expecting major, minor or patch. Received: ${releaseType}`);
  }

  if (packageJSON.version === undefined) {
    throw new Error('Property version not defined in package.json');
  }

  const VERSION_INCREMENT = 1;

  function incrementVersionPart(currentValue, index) {
    if (index === versionPartToIncrement) {
      return Number(currentValue) + VERSION_INCREMENT;
    } else if (index > versionPartToIncrement) {
      return 0;
    }

    return currentValue;
  }

  packageJSON.version = packageJSON.version.split('.').map(incrementVersionPart).join('.');

  packageJSONstr = JSON.stringify(packageJSON, null, 2);
  fs.writeFileSync(PACKAGE_JSON, packageJSONstr, 'utf-8');

  return packageJSON.version;
}

function getCurrentGitBranchName() {
  const branchName = shell.exec('git rev-parse --abbrev-ref HEAD', {
    silent: true
  }).stdout;

  return branchName.trim();
}

function addPackageToStagingArea(fileName) {
  task.printDescription(`[addPackageToStagingArea] ${fileName}` || PACKAGE_JSON);

  return shell.exec(`git add ${fileName || PACKAGE_JSON}`);
}

function commitChanges(options) {
  task.printDescription(`[commitChanges] ${options}`);

  return shell.exec(`git commit ${options}`);
}

function pushChanges(options) {
  task.printDescription(`[pushChanges] Pushing changes ${options}`);

  return shell.exec(`git push ${options}`);
}

function addTag(tagName) {
  task.printDescription(`[addTag] Adding tag ${tagName}`);

  return shell.exec(`git tag ${tagName}`);
}

function uploadPackageJson() {
  const branchName = getCurrentGitBranchName();
  const newVersion = getPackageVersion();

  if (branchName !== 'develop') {
    throw new Error(`Upload of package.json can be done only on develop branch, current branch is ${branchName}`);
  }

  addPackageToStagingArea();
  commitChanges(`-m "Build: version ${newVersion}"`);
  pushChanges(`origin ${branchName}`);
  addTag(`v${newVersion}`);
  pushChanges(`origin ${branchName} --tags`);

  return newVersion;
}

function incrementPackageVersion(releaseType) {
  return incrementVersion(releaseType);
}

const version = {
  getPackageVersion: getPackageVersion,
  incrementPackageVersion: incrementPackageVersion,
  uploadPackageJson: uploadPackageJson
};

module.exports = version;
