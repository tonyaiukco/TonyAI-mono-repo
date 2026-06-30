import { create } from "zustand";
import type { AuthUser } from "@tonyai/shared-types";

interface AuthState {
  user: AuthUser | null;
  loaded: boolean;
  setUser: (user: AuthUser | null) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  loaded: false,
  setUser: (user) => set({ user, loaded: true }),
  clear: () => set({ user: null, loaded: true }),
}));
