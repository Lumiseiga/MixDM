const crypto = require('crypto');
const os = require('os');
const { getConfig, setConfig } = require('./database');

function getInstallSeed() {
  let seed = getConfig('install_machine_seed');
  if (!seed) {
    seed = crypto.randomBytes(32).toString('hex');
    setConfig('install_machine_seed', seed);
  }
  return seed;
}

function getMachineProfile() {
  let username = '';
  let homedir = '';
  try {
    const info = os.userInfo();
    username = info.username || '';
    homedir = info.homedir || '';
  } catch (_) {}

  return [
    os.hostname(),
    os.platform(),
    os.arch(),
    username,
    homedir
  ].join('|').toLowerCase();
}

function getMachineLock() {
  return crypto
    .createHash('sha256')
    .update(`${getInstallSeed()}|${getMachineProfile()}`)
    .digest('hex');
}

module.exports = {
  getMachineLock
};
