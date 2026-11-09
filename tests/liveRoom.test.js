/**
 * utils/liveRoom.js: is a room a live stream by this host, asked of the streaming
 * server. Fails closed, caches answers a minute and errors ten seconds, tries each
 * configured server in turn. fetch is stubbed; nothing leaves the process.
 */
const ROOM = { name: 'room-1', mode: 'standalone', host: 'host1', broadcasting: true, liveAt: '2026-11-09T18:00:00.000Z' };
const answer = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

let mod;
function load(env = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  jest.isolateModules(() => { mod = require('../utils/liveRoom'); });
  process.env = saved;
  return mod;
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-11-09T18:30:00Z') });
  global.fetch = jest.fn(async () => answer(200, ROOM));
  load();
});
afterEach(() => {
  jest.useRealTimers();
  delete global.fetch;
});

describe('what counts as live', () => {
  test('a broadcasting stream by that host: its go-live time', async () => {
    expect(await mod.liveRoom('Host1', 'room-1')).toEqual({ liveAt: ROOM.liveAt });
    expect(global.fetch).toHaveBeenCalledWith('https://live.3speak.tv/rooms/room-1', expect.objectContaining({ signal: expect.anything() }));
  });

  test.each([
    ['a conference room', { mode: 'conference' }],
    ['somebody else\'s stream', { host: 'mallory' }],
    ['a stream in standby', { broadcasting: false }],
    ['a stream that never went live', { liveAt: undefined }],
    ['an empty go-live time', { liveAt: '' }],
  ])('%s is not', async (_label, over) => {
    global.fetch.mockResolvedValue(answer(200, { ...ROOM, ...over }));
    expect(await mod.liveRoom('host1', 'room-1')).toBeNull();
  });

  test('a room that does not exist is not', async () => {
    global.fetch.mockResolvedValue(answer(404));
    expect(await mod.liveRoom('host1', 'room-1')).toBeNull();
  });

  test('no host or no room is not, and nothing is asked', async () => {
    expect(await mod.liveRoom('', 'room-1')).toBeNull();
    expect(await mod.liveRoom('host1', '')).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('the room name is escaped into the path', async () => {
    await mod.liveRoom('host1', 'a/b?c');
    expect(global.fetch.mock.calls[0][0]).toBe('https://live.3speak.tv/rooms/a%2Fb%3Fc');
  });
});

describe('fails closed', () => {
  test.each([
    ['the server errors', async () => answer(500)],
    ['the connection fails', async () => { throw new Error('ECONNREFUSED'); }],
    ['the body is not JSON', async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } })],
  ])('%s: not live', async (_label, impl) => {
    global.fetch.mockImplementation(impl);
    expect(await mod.liveRoom('host1', 'room-1')).toBeNull();
  });
});

describe('caching', () => {
  test('an answer is reused for a minute, then asked again', async () => {
    await mod.liveRoom('host1', 'room-1');
    await mod.liveRoom('HOST1', 'room-1');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(60 * 1000 + 1);
    await mod.liveRoom('host1', 'room-1');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('"not live" is cached too, so an ended stream stops getting ads within a minute and is not asked per viewer', async () => {
    global.fetch.mockResolvedValue(answer(404));
    await mod.liveRoom('host1', 'room-1');
    await mod.liveRoom('host1', 'room-1');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('an error is only remembered for ten seconds', async () => {
    global.fetch.mockResolvedValueOnce(answer(503));
    expect(await mod.liveRoom('host1', 'room-1')).toBeNull();
    jest.advanceTimersByTime(10 * 1000 + 1);
    expect(await mod.liveRoom('host1', 'room-1')).toEqual({ liveAt: ROOM.liveAt });
  });

  test('a full cache drops what has expired, and everything if nothing has', async () => {
    for (let i = 0; i < 5000; i += 1) mod._cache.set(`h/r${i}`, { value: null, exp: Date.now() + 1000 });
    await mod.liveRoom('host1', 'room-1');
    expect(mod._cache.size).toBe(1);
    for (let i = 0; i < 4999; i += 1) mod._cache.set(`old/r${i}`, { value: null, exp: Date.now() - 1 });
    await mod.liveRoom('host1', 'room-2');
    expect(mod._cache.has('host1/room-1')).toBe(true);
    expect(mod._cache.has('old/r0')).toBe(false);
  });
});

describe('several streaming servers', () => {
  test('asked in order; a 404 moves on to the next, the first real answer wins', async () => {
    load({ LIVE_ROOM_API_URLS: 'https://a.example/, https://b.example' });
    global.fetch.mockImplementation(async (url) => (url.startsWith('https://a.example') ? answer(404) : answer(200, ROOM)));
    expect(await mod.liveRoom('host1', 'room-1')).toEqual({ liveAt: ROOM.liveAt });
    expect(global.fetch.mock.calls.map(([u]) => u)).toEqual(['https://a.example/rooms/room-1', 'https://b.example/rooms/room-1']);
  });

  test('a server that is down does not hide a stream on the next one', async () => {
    load({ LIVE_ROOM_API_URLS: 'https://a.example,https://b.example' });
    global.fetch.mockImplementation(async (url) => {
      if (url.startsWith('https://a.example')) throw new Error('down');
      return answer(200, ROOM);
    });
    expect(await mod.liveRoom('host1', 'room-1')).toEqual({ liveAt: ROOM.liveAt });
  });
});
