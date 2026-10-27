/** Validate an explicit disposable database before any test creates a pg client.
 * This interlock is not authentication or a substitute for database permissions.
 */
export function readTestDatabase(env = process.env, options = { required: false }) {
  if (env.TEST_DATABASE_REQUIRED !== undefined && !['0', '1'].includes(env.TEST_DATABASE_REQUIRED)) {
    throw new Error('TEST_DATABASE_REQUIRED must be 0 or 1');
  }
  const required = options.required === true || env.TEST_DATABASE_REQUIRED === '1';
  const raw = env.TEST_DATABASE_URL;
  if (raw === undefined) {
    if (required) throw new Error('TEST_DATABASE_URL is required for database tests');
    return undefined;
  }
  const invalid = () => new Error('TEST_DATABASE_URL must be an explicit loopback PostgreSQL URL for a dedicated ccl_ci or ccl_test database');
  if (raw.length === 0 || raw !== raw.trim() || /\s/.test(raw)) throw invalid();
  let parsed;
  try { parsed = new URL(raw); } catch { throw invalid(); }
  const authority = /^postgres(?:ql)?:\/\/([^/?#]+)\//.exec(raw)?.[1];
  const literalHost = authority?.slice(authority.lastIndexOf('@') + 1);
  if (!literalHost || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/i.test(literalHost)) throw invalid();
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.hash || parsed.search ||
      !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase()) ||
      (parsed.port !== '' && (!/^\d+$/.test(parsed.port) || Number(parsed.port) < 1 || Number(parsed.port) > 65535))) {
    throw invalid();
  }
  let database;
  try { database = decodeURIComponent(parsed.pathname.slice(1)); } catch { throw invalid(); }
  if (database.length > 63 || !(database === 'ccl_ci' || /^ccl_test(?:_[a-z0-9]+)*$/.test(database))) throw invalid();
  const identity = url => {
    const host = url.hostname.toLowerCase();
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(host);
    return `${loopback ? 'loopback' : host}:${Number(url.port || '5432')}:${decodeURIComponent(url.pathname.slice(1))}`;
  };
  if (env.DATABASE_URL !== undefined) {
    try {
      const app = new URL(env.DATABASE_URL);
      if (identity(app) === identity(parsed)) throw new Error('TEST_DATABASE_URL must differ from DATABASE_URL');
    } catch (error) {
      if (error instanceof Error && error.message === 'TEST_DATABASE_URL must differ from DATABASE_URL') throw error;
      // An unrelated malformed app URL must not make an explicit safe test URL unsafe.
    }
  }
  return raw;
}
