/**
 * Session state.
 *
 * The profile comes from `/auth/me` rather than being decoded from the JWT:
 * permissions and memberships change server-side, and a token minted ten
 * minutes ago should not decide what this person can see now.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, onSessionEnded, tokens } from './api';
import type { AuthTokens, Membership, Role, UserProfile } from './types';

interface AuthValue {
  user: UserProfile | null;
  /** True until the stored session has been checked on first load. */
  loading: boolean;
  signIn: (email: string, password: string) => Promise<UserProfile>;
  register: (input: RegisterInput) => Promise<UserProfile>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  can: (permission: string) => boolean;
  /** The laboratory this person works in, when they belong to exactly one. */
  laboratory: Membership | null;
  isAdmin: boolean;
}

export interface RegisterInput {
  email: string;
  password: string;
  fullName: string;
  jobTitle?: string;
  /** Joins the new account to a laboratory straight away, if supplied. */
  laboratoryCode?: string;
}

const AuthContext = createContext<AuthValue | null>(null);

const ADMIN_ROLES: Role[] = ['SUPER_ADMIN', 'LAB_ADMIN'];

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const loadProfile = useCallback(async () => {
    if (!tokens.access()) {
      setUser(null);
      return;
    }
    try {
      setUser(await api.get<UserProfile>('/auth/me'));
    } catch {
      tokens.clear();
      setUser(null);
    }
  }, []);

  useEffect(() => {
    void loadProfile().finally(() => setLoading(false));
  }, [loadProfile]);

  // The API client ends the session when a refresh fails; mirror that here so
  // the router sends the person to sign-in instead of showing empty screens.
  useEffect(() => onSessionEnded(() => setUser(null)), []);

  const signIn = useCallback(async (email: string, password: string) => {
    const result = await api.post<AuthTokens>(
      '/auth/login',
      { email, password },
      { anonymous: true },
    );
    tokens.set(result.accessToken, result.refreshToken);
    setUser(result.user);
    return result.user;
  }, []);

  const register = useCallback(async (input: RegisterInput) => {
    const result = await api.post<AuthTokens>('/auth/register', input, {
      anonymous: true,
    });
    tokens.set(result.accessToken, result.refreshToken);
    setUser(result.user);
    return result.user;
  }, []);

  const signOut = useCallback(async () => {
    const refreshToken = tokens.refresh();
    try {
      // Best effort: revoking server-side is what actually ends the session,
      // but a failure here must not strand someone on a signed-in screen.
      if (refreshToken) await api.post('/auth/logout', { refreshToken });
    } catch {
      /* ignored */
    } finally {
      tokens.clear();
      setUser(null);
    }
  }, []);

  const value = useMemo<AuthValue>(() => {
    const permissions = new Set(user?.permissions ?? []);
    const memberships = user?.memberships ?? [];
    return {
      user,
      loading,
      signIn,
      register,
      signOut,
      refreshProfile: loadProfile,
      can: (permission) => permissions.has(permission),
      laboratory: memberships.length > 0 ? memberships[0]! : null,
      isAdmin: user ? ADMIN_ROLES.includes(user.role) : false,
    };
  }, [user, loading, signIn, register, signOut, loadProfile]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
