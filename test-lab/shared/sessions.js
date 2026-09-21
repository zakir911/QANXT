/**
 * Session handling for the lab applications.
 *
 * Real behaviour rather than a stub: sessions expire on inactivity, repeated bad passwords
 * lock an account, and a locked account stays locked until the lock window passes. These
 * are the states an authentication test has to be able to reach, and a test lab that
 * cannot reach them cannot prove the platform handles them.
 */
import { randomUUID, randomBytes } from 'node:crypto';

export const SESSION_COOKIE = 'lab_session';

export function createSessionStore({
  idleTimeoutMs = 15 * 60 * 1000,
  maxFailedAttempts = 3,
  lockDurationMs = 5 * 60 * 1000,
  clock = () => Date.now()
} = {}) {
  const sessions = new Map();
  const failures = new Map();   // username → { count, lockedUntil }

  const store = {
    /** @returns {{ok: true, token: string, user: object} | {ok: false, reason: string, retryInMs?: number}} */
    signIn(users, username, password) {
      const record = failures.get(username) ?? { count: 0, lockedUntil: 0 };
      const now = clock();

      if (record.lockedUntil > now) {
        return { ok: false, reason: 'locked', retryInMs: record.lockedUntil - now };
      }

      const user = users.find(candidate => candidate.username === username);
      if (!user || user.password !== password) {
        record.count += 1;
        if (record.count >= maxFailedAttempts) {
          record.lockedUntil = now + lockDurationMs;
          record.count = 0;
          failures.set(username, record);
          return { ok: false, reason: 'locked', retryInMs: lockDurationMs };
        }
        failures.set(username, record);
        return { ok: false, reason: 'invalid', attemptsLeft: maxFailedAttempts - record.count };
      }

      failures.delete(username);
      const token = `${randomUUID()}.${randomBytes(8).toString('hex')}`;
      sessions.set(token, { token, userId: user.id, username: user.username, startedAt: now, lastSeenAt: now });
      return { ok: true, token, user };
    },

    /** @returns {{session: object} | {expired: boolean}} */
    resolve(token) {
      if (!token) return { expired: false, session: null };
      const session = sessions.get(token);
      if (!session) return { expired: false, session: null };

      const now = clock();
      if (now - session.lastSeenAt > idleTimeoutMs) {
        sessions.delete(token);
        return { expired: true, session: null };
      }
      session.lastSeenAt = now;
      return { expired: false, session };
    },

    signOut(token) {
      return sessions.delete(token);
    },

    /** Used by the session-timeout fault to age a session without waiting for real time. */
    expire(token) {
      const session = sessions.get(token);
      if (!session) return false;
      session.lastSeenAt = 0;
      return true;
    },

    unlock(username) {
      failures.delete(username);
    },

    count() {
      return sessions.size;
    }
  };

  return store;
}

/**
 * A per-session identifier suffix.
 *
 * Under FAULT_DYNAMIC_LOCATOR the lab regenerates element ids for every session, which is
 * what a framework that hashes class names or ids at render time does in the wild. Tests
 * that lean on a generated id break; tests that lean on a role, a label or a test id do
 * not. That distinction is the point.
 */
export function sessionSalt(token) {
  return (token ?? 'anonymous').slice(0, 8).replace(/[^a-z0-9]/gi, '');
}
