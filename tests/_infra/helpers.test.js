/**
 * The shared test helpers (tests/helpers) against the real modules they stand in
 * for: the throwaway database behind utils/db, and Hive signatures checked by
 * utils/hiveAuth.
 */
const request = require('supertest');
const express = require('express');
const testDb = require('../helpers/db');
const { buildApp, apiKeyHeader } = require('../helpers/app');
const { hiveAccount, fakeHiveChain } = require('../helpers/hive');

describe('helpers/db', () => {
  const db = testDb.use();

  test('the app\'s getDb() and the helper share one throwaway database', async () => {
    const { getDb } = require('../../utils/db');
    await getDb().collection('probe').insertOne({ n: 1 });
    expect(await db().collection('probe').countDocuments()).toBe(1);
    expect(db().databaseName).toMatch(/^checker_test_/);
  });

  test('every test starts empty', async () => {
    expect(await db().collection('probe').countDocuments()).toBe(0);
  });
});

describe('helpers/app', () => {
  test('mounts routers behind JSON parsing and turns a thrown error into a JSON 500', async () => {
    const r = express.Router();
    r.post('/echo', (req, res) => res.json(req.body));
    r.get('/boom', () => { throw new Error('kaput'); });
    const app = buildApp(['/t', r]);
    await request(app).post('/t/echo').send({ a: 1 }).expect(200, { a: 1 });
    await request(app).get('/t/boom').expect(500, { error: 'kaput' });
    expect(apiKeyHeader().Authorization).toBe('Bearer test-api-secret');
  });
});

describe('helpers/hive', () => {
  test('a signature verifies through utils/hiveAuth for the signer only', async () => {
    const alice = hiveAccount('alice');
    const bob = hiveAccount('bob');
    const chain = fakeHiveChain([alice, bob]);
    const { verifyHiveSignedMessage } = require('../../utils/hiveAuth');
    const signature = alice.sign('hello');
    await expect(verifyHiveSignedMessage({ message: 'hello', signature, username: 'alice' })).resolves.toBe(true);
    await expect(verifyHiveSignedMessage({ message: 'hello', signature, username: 'bob' })).resolves.toBe(false);
    await expect(verifyHiveSignedMessage({ message: 'other', signature, username: 'alice' })).resolves.toBe(false);
    expect(chain.calls.map((c) => c[1])).toContain('get_accounts');
  });

  test('an unstubbed chain call fails loudly', async () => {
    fakeHiveChain();
    const dhive = require('@hiveio/dhive');
    await expect(new dhive.Client('http://127.0.0.1:9').database.call('get_dynamic_global_properties'))
      .rejects.toThrow(/no stub/);
  });
});
