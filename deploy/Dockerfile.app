# Web application image. Phase 2 bakes the local embedding and rerank model files in
# (brief non-negotiable 8); until then this is the plain workspace runtime.
FROM node:22-bookworm-slim
WORKDIR /repo
# Optional extra CA for build environments behind a TLS-inspecting proxy (base64 PEM).
# Empty by default; production builds pass nothing and trust only the system store.
ARG EXTRA_CA_B64=""
RUN mkdir -p /etc/build-ca && \
    if [ -n "$EXTRA_CA_B64" ]; then echo "$EXTRA_CA_B64" | base64 -d > /etc/build-ca/extra-ca.crt; \
    else touch /etc/build-ca/extra-ca.crt; fi
ENV NODE_EXTRA_CA_CERTS=/etc/build-ca/extra-ca.crt
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY evals ./evals
COPY config ./config
RUN pnpm install --frozen-lockfile
EXPOSE 3000
CMD ["pnpm", "exec", "tsx", "apps/web/src/server.ts"]
