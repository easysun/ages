import { createApp } from "./app";
import type { Bindings } from "./bindings";
import { scheduledCleanup } from "./cleanup";

const app = createApp();
export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, bindings: Bindings) {
    await scheduledCleanup(bindings);
  },
};
