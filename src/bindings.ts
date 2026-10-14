import type { AuthenticatedUser } from "./auth/session";

export type AppEnvironment = "local" | "development" | "preview" | "production";

export type Bindings = Omit<WorkerBindings, "APP_ENV"> & {
  APP_ENV: AppEnvironment;
  APP_ORIGIN?: string;
  TRACKING_ORIGIN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  LOCAL_LOGIN_ENABLED?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
};

export type AppContext = {
  Bindings: Bindings;
  Variables: { requestId: string; user: AuthenticatedUser };
};
