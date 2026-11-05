# Tests

```bash
npm test                 # the whole suite (a few seconds)
npm run test:coverage    # plus a coverage report in coverage/ (lcov-report/index.html)
npx jest tests/adPayouts # one area
DEBUG_TESTS=1 npx jest … # with the app's console.log output
```

Node.js 22. Nothing to set up: the first run downloads a MongoDB 7 binary once
(`~/.cache/mongodb-binaries`).

## Nothing here can touch production

The suite is built so that it is safe to run anywhere, including on the live box
next to a production `.env`:

| Guard | Where |
|---|---|
| `.env` is never read (dotenv is stubbed) and every secret-, key- or endpoint-like variable from the shell is dropped. Tests see known fake values (`API_SECRET_KEY=test-api-secret`, …). | `setup/env.js` |
| Outbound network is refused. Only loopback (the test database, stub servers a test starts) is reachable, so no test can call Hive, Butter Auth, a payment gateway or a webhook. | `setup/env.js` |
| The only database is a throwaway `mongod` started for the run (or `TEST_MONGODB_URI`, which must be on this machine). Each Jest worker has its own `checker_test_<n>` database; anything else is never dropped. | `setup/globalSetup.js`, `setup/safety.js` |

`_infra/guards.test.js` proves each of these on every run. If it fails, trust nothing else.

## Writing a test

- One file per module or feature: `tests/<area>/<module>.test.js`. Name tests after
  the behaviour ("a viewer row never overwrites a creator row"), not the function.
- **Queries and aggregations run against MongoDB**, not a hand-written fake: a fake
  cannot tell you whether a pipeline works.

  ```js
  const testDb = require('../helpers/db');
  const db = testDb.use();   // real utils/db on this worker's database, emptied before each test
  ```

- **Routes** are mounted on a bare app and called with supertest:

  ```js
  const { buildApp, apiKeyHeader } = require('../helpers/app');
  const app = buildApp(['/advertise', require('../../routes/advertise')]);
  await request(app).get('/advertise/rates').set(apiKeyHeader()).expect(200);
  ```

- **Hive signatures** are real; the chain is fake:

  ```js
  const { hiveAccount, fakeHiveChain } = require('../helpers/hive');
  const alice = hiveAccount('alice');
  fakeHiveChain([alice]);
  const signature = alice.sign(message);
  ```

- **Configuration** is read when a module is first required. Set `process.env.X`
  at the top of the file (before the `require`), or use `jest.isolateModules`.
- **Time**: `jest.useFakeTimers().setSystemTime(new Date('2026-11-01T12:00:00Z'))`.
  Never `sleep`.
- **Other services** (Butter Auth, the embed API, podcast feeds): start a local
  express stub on port 0 and point the env URL at it, or `jest.mock` the client module.

## Bugs found by tests

A test that shows a real bug stays in, written for the correct behaviour and marked
`test.skip('BUG: …')` until the fix lands. Remove the `.skip` together with the fix.

## Older checks

`scripts/test-*.cjs` are standalone scenario scripts from before this suite. They
run against the database in `.env` and protect real rows with
`scripts/_realMoneyGuard.cjs`. Prefer the Jest suite; new checks belong here.

## CI

`.github/workflows/tests.yml` runs the suite with coverage on every pull request and
every push to `main`, and writes the coverage table into the run summary.
`coverageThreshold` in `jest.config.js` is a ratchet: raise it as coverage grows,
never lower it to make a run pass.
