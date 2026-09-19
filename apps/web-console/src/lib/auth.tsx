import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { apiRequest, readSession, writeSession, type StoredSession } from '../api/client';

/**
 * Session state for the console.
 *
 * Permissions are read from the token the server issued, and the UI hides what the caller
 * cannot do. That is a courtesy, not a control: every one of these permissions is enforced
 * again server-side, because a hidden button is not a security boundary.
 */

interface AuthContextValue {
  session: StoredSession | null;
  isAuthenticated: boolean;
  user: StoredSession['user'] | null;
  can(permission: string): boolean;
  login(email: string, password: string, organizationSlug?: string): Promise<void>;
  register(organizationName: string, email: string, password: string, displayName: string): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<StoredSession | null>(() => readSession());

  const apply = useCallback((next: StoredSession | null) => {
    writeSession(next);
    setSession(next);
  }, []);

  const login = useCallback(async (email: string, password: string, organizationSlug?: string) => {
    const result = await apiRequest<StoredSession>('/api/v1/auth/login', {
      method: 'POST',
      authenticated: false,
      body: { email, password, organizationSlug: organizationSlug || undefined }
    });
    apply(result);
  }, [apply]);

  const register = useCallback(async (
    organizationName: string, email: string, password: string, displayName: string
  ) => {
    const result = await apiRequest<StoredSession>('/api/v1/auth/register', {
      method: 'POST',
      authenticated: false,
      body: { organizationName, email, password, displayName }
    });
    apply(result);
  }, [apply]);

  const logout = useCallback(async () => {
    const current = readSession();
    if (current?.refreshToken) {
      // Best effort: the local session is cleared regardless, so a network failure on the
      // way out never leaves someone apparently signed in.
      await apiRequest('/api/v1/auth/logout', {
        method: 'POST', body: { refreshToken: current.refreshToken }
      }).catch(() => undefined);
    }
    apply(null);
  }, [apply]);

  const value = useMemo<AuthContextValue>(() => {
    const permissions = new Set(session?.user.permissions ?? []);
    return {
      session,
      isAuthenticated: session !== null,
      user: session?.user ?? null,
      can: (permission: string) => permissions.has(permission),
      login,
      register,
      logout
    };
  }, [session, login, register, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider.');
  return context;
}

/** The permission vocabulary the console checks against. Mirrors the server's catalogue. */
export const Permissions = {
  projectRead: 'project:read',
  projectWrite: 'project:write',
  applicationWrite: 'application:write',
  discoveryRun: 'discovery:run',
  testWrite: 'test:write',
  testGenerate: 'test:generate',
  executionRun: 'execution:run',
  executionCancel: 'execution:cancel',
  healingApprove: 'healing:approve',
  defectWrite: 'defect:write',
  secretWrite: 'secret:write',
  aiUse: 'ai:use',
  auditRead: 'audit:read'
} as const;
