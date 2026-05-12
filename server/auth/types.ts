export type AuthUser = { id: string; username: string; role: string };

export type LocalUser = AuthUser & {
  lastLogin: string;
  passwordHash?: string;
  password?: string; // legacy plaintext, migrated at startup
};
