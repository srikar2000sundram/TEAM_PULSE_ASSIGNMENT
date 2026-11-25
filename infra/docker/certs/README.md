# AWS RDS certificate bundle

`rds-global-bundle.pem` is the public certificate authority bundle that Amazon RDS publishes. The
services set `NODE_EXTRA_CA_CERTS=/app/certs/rds-global-bundle.pem` so Node can verify the database's
TLS certificate. It contains public certificates only, no secrets.

- Source: https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
- Downloaded: 2026-11-25
- SHA-256: `90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b`

The Dockerfile checks this SHA-256 while building the image. To refresh the bundle, download it
again, review the change, then update the checksum here and in `infra/docker/Dockerfile`.
