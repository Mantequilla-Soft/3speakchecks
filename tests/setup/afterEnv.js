/**
 * Runs in every test file after the framework is installed.
 *
 * The app logs freely (payout runs, sync workers). That output is noise in a test
 * run, so console.log/info/debug are silenced; warnings and errors still print.
 * DEBUG_TESTS=1 brings everything back.
 */
if (!process.env.DEBUG_TESTS) {
  const quiet = () => {};
  console.log = quiet;
  console.info = quiet;
  console.debug = quiet;
}
