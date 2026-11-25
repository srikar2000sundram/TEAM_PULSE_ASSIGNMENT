# syntax=docker/dockerfile:1.7
#
# One file, three images (build with --target):
#   backend  every service and Lambda in one image; the command picks which one runs
#   web      the static web app behind nginx
#
# Build from the repository root:
#   podman build -f infra/docker/Dockerfile --target backend -t teampulse/backend:local .
# (docker works the same way.)

ARG NODE_IMAGE=docker.io/library/node:22-bookworm-slim
ARG NGINX_IMAGE=docker.io/nginxinc/nginx-unprivileged:1.27-alpine

# Debian "slim", not Alpine: the password hashing library (argon2) ships prebuilt binaries for
# glibc, so no compiler is needed in the image.
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV CI=true NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
COPY . .
# `npm ci` installs exactly what package-lock.json says, so the image matches what was tested.
RUN npm ci
RUN npm run build && npm run build -w @teampulse/web
# The browser may only run the inline script SvelteKit generated: list its hash in the policy.
RUN node tools/docker/render-security-headers.mjs apps/web/build/index.html \
    infra/docker/security-headers.conf.template /tmp/security-headers.conf

# Remove everything only needed to build and test (compiler, Vite, Vitest, ...).
FROM build AS pruned
RUN npm prune --omit=dev

FROM ${NODE_IMAGE} AS backend
WORKDIR /app
COPY --from=pruned --chown=node:node /app /app
# The running services never call npm. Removing it (and corepack) drops a package manager and all of
# its own dependencies from the image, which an attacker could otherwise use and a scanner flags.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
# The certificate authorities for Amazon RDS, so the services can verify the database over TLS.
# The checksum makes the build fail if the file ever changes without review (see certs/README.md).
COPY --chown=node:node infra/docker/certs/rds-global-bundle.pem /app/certs/rds-global-bundle.pem
RUN echo "90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b  /app/certs/rds-global-bundle.pem" | sha256sum -c -
# Never run as root: a flaw in the service must not own the container.
USER node
EXPOSE 3000
# Every service listens on PORT (default 3000). Choose the program with the command, for example:
#   node services/habit/dist/main.js
ENTRYPOINT ["node"]
CMD ["services/identity/dist/main.js"]

FROM ${NGINX_IMAGE} AS web
# Pick up operating-system security fixes published since the base image was built, then drop back to
# the unprivileged user the base image runs as.
USER root
RUN apk upgrade --no-cache
USER 101
COPY infra/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /tmp/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/apps/web/build /usr/share/nginx/html
EXPOSE 8080
