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

# Remove everything only needed to build and test (compiler, Vite, Vitest, ...).
FROM build AS pruned
RUN npm prune --omit=dev

FROM ${NODE_IMAGE} AS backend
WORKDIR /app
COPY --from=pruned --chown=node:node /app /app
# Never run as root: a flaw in the service must not own the container.
USER node
EXPOSE 3000
# Every service listens on PORT (default 3000). Choose the program with the command, for example:
#   node services/habit/dist/main.js
ENTRYPOINT ["node"]
CMD ["services/identity/dist/main.js"]

FROM ${NGINX_IMAGE} AS web
COPY infra/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/build /usr/share/nginx/html
EXPOSE 8080
