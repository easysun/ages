export type AppEnvironment = "local" | "development" | "preview" | "production";

export type Bindings = Omit<WorkerBindings, "APP_ENV"> & {
  APP_ENV: AppEnvironment;
};

export type AppContext = {
  Bindings: Bindings;
  Variables: { requestId: string };
};
