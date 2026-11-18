// The "went live" job is off unless LIVE_NOTIFY_ENABLED=true: its web push reaches
// every follower with notifications on, and production 3speak.tv has no switch
// for it yet (utils/config.js).
describe('LIVE_NOTIFY_ENABLED', () => {
  const saved = process.env.LIVE_NOTIFY_ENABLED;
  afterEach(() => {
    if (saved === undefined) delete process.env.LIVE_NOTIFY_ENABLED;
    else process.env.LIVE_NOTIFY_ENABLED = saved;
    jest.resetModules();
  });
  const load = (value) => {
    jest.resetModules();
    if (value === undefined) delete process.env.LIVE_NOTIFY_ENABLED;
    else process.env.LIVE_NOTIFY_ENABLED = value;
    return require('../../utils/config').LIVE_NOTIFY_ENABLED;
  };

  it('is off when not set', () => {
    expect(load(undefined)).toBe(false);
    expect(load('')).toBe(false);
  });

  it('is on only when set to true', () => {
    expect(load('true')).toBe(true);
    expect(load('TRUE')).toBe(true);
    expect(load('false')).toBe(false);
    expect(load('1')).toBe(false);
  });
});

describe('LIVE_EXCLUDED_HOSTS', () => {
  const saved = process.env.LIVE_EXCLUDED_HOSTS;
  afterEach(() => {
    if (saved === undefined) delete process.env.LIVE_EXCLUDED_HOSTS;
    else process.env.LIVE_EXCLUDED_HOSTS = saved;
    jest.resetModules();
  });
  const load = (value) => {
    jest.resetModules();
    if (value === undefined) delete process.env.LIVE_EXCLUDED_HOSTS;
    else process.env.LIVE_EXCLUDED_HOSTS = value;
    return require('../../utils/config').LIVE_EXCLUDED_HOSTS;
  };

  it('hides badadib and ashenadib when not set', () => {
    expect(load(undefined)).toEqual(['badadib', 'ashenadib']);
  });

  it('takes a comma list, and empty hides nobody', () => {
    expect(load(' Badadib , x ')).toEqual(['badadib', 'x']);
    expect(load('')).toEqual([]);
  });
});
