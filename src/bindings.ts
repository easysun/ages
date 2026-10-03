import type { AuthenticatedUser } from "./auth/session";

export type AppEnvironment = "local" | "development" | "preview" | "production";

export type Bindings = Omit<WorkerBindings, "APP_ENV"> & {
  APP_ENV: AppEnvironment;
  APP_ORIGIN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
};

export type AppContext = {
  Bindings: Bindings;
  Variables: { requestId: string; user: AuthenticatedUser };
};
