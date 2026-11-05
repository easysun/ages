# Ages isolated OKE development container

This runs **Wrangler local simulation**, not a Cloudflare Worker production deployment. The existing Cloudflare preview/production release process is unchanged.

## Scope and limits

- One ARM64 replica on the existing two-node Arbay OKE Basic cluster.
- Namespace `ages-dev`, a **ClusterIP-only** Service, no LoadBalancer/NodePort/PVC.
- A disposable `emptyDir` for local D1 (SQLite), R2 and KV simulation. All data may disappear when the Pod is replaced, rescheduled, evicted or restarted on a different node. **Never upload real personal data or use this environment for durable memories.**
- The development container serves local HTTP with `APP_ORIGIN=http://127.0.0.1:8787`. It is usable only through the authenticated Kubernetes private API and `kubectl port-forward`, not through a public Cloudflare Tunnel. The tracking Worker is not deployed here.
- `/health` is the liveness endpoint; `/health/ready` also checks simulated D1/R2/KV bindings. The Wrangler startup runs local migrations before starting the server.
- Login requires separate Google OAuth credentials and the local callback `http://127.0.0.1:8787/auth/google/callback`; without them, use anonymous smoke tests only. Do not reuse production OAuth secrets.

## Image pipeline

`.github/workflows/oke-dev-image.yml` publishes a native `linux/arm64` image on main to `ghcr.io/easysun/ages-dev:sha-<40-character-commit-SHA>`.

**Publishing does not imply public pull access.** Before deployment either make the GHCR package public using GitHub Packages settings, or create a namespace-scoped `imagePullSecret` and add the reference to the Pod template outside source control. Never commit the registry token.

## Initial deployment (after the image is published)

1. Confirm `kubectl config current-context` is `oke-oci` and both ARM64 nodes are Ready.
2. Replace `sha-REPLACE_WITH_COMMIT` in `deployment.yaml` in a GitOps commit with the actual published commit SHA. The placeholder must never be deployed.
3. Review `kubectl kustomize deploy/oke-dev` and `kubectl diff -k deploy/oke-dev` before changing the cluster.
4. Apply through Flux once its GitOps repository is bootstrapped; avoid running both `kubectl apply` and Flux as competing managers.
5. Verify `kubectl -n ages-dev rollout status deploy/ages`, `kubectl -n ages-dev get pods -o wide`, and `kubectl -n ages-dev port-forward svc/ages 8787:8787`.
6. From another terminal: `curl --fail http://127.0.0.1:8787/health` and `curl --fail http://127.0.0.1:8787/health/ready`.

Do not configure public ingress for this simulator. A real development hostname needs Cloudflare Worker bindings for D1/R2/KV or a separately designed persistent database/storage backend, an HTTPS origin/cookie policy, OAuth callbacks, and security validation.
