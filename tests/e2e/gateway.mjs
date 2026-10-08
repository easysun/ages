export default {
  async fetch(request, env) {
    const target = request.headers.get("x-e2e-target");
    const service =
      target === "app" ? env.APP : target === "tracking" ? env.TRACKING : null;
    const publicOrigin =
      target === "app"
        ? env.APP_ORIGIN
        : target === "tracking"
          ? env.TRACKING_ORIGIN
          : null;
    if (!service || !publicOrigin)
      return new Response("Unknown local Worker target.", { status: 400 });

    const incoming = new URL(request.url);
    const destination = new URL(
      `${incoming.pathname}${incoming.search}`,
      publicOrigin,
    );
    const headers = new Headers(request.headers);
    headers.delete("x-e2e-target");
    headers.set("host", destination.host);

    const init = {
      method: request.method,
      headers,
      redirect: "manual",
    };
    if (request.method !== "GET" && request.method !== "HEAD" && request.body)
      init.body = request.body;
    return service.fetch(new Request(destination, init));
  },
};
