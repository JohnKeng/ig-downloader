function ts() {
  return new Date().toISOString();
}

function info(msg, ...args) {
  console.log(`[${ts()}] INFO ` + msg, ...args);
}

function warn(msg, ...args) {
  console.warn(`[${ts()}] WARN ` + msg, ...args);
}

function error(msg, ...args) {
  console.error(`[${ts()}] ERROR ` + msg, ...args);
}

module.exports = { info, warn, error };

