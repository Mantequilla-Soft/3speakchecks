module.exports = async function globalTeardown() {
  if (globalThis.__CHECKER_MONGOD__) await globalThis.__CHECKER_MONGOD__.stop();
};
