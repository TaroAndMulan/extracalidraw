import { createContext, useContext } from "react";

import type { PublicUser } from "../../whiteboard-server/src/protocol";

export interface AuthContextValue {
  user: PublicUser;
  appName: string;
  logout: () => Promise<void>;
  setUser: (user: PublicUser) => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export const useAuth = () => {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used within AuthContext");
  }
  return value;
};
