# Retired GitHub Actions workflows

Backend CI, mutation reports and sandbox image publication are owned by the local Mac Jenkins jobs. The three `.yml.disabled` files preserve their previous definitions and cannot be discovered as GitHub Actions workflows.

- `ci.yml.disabled`: former blocking API checks. The installed controller now performs the full native checks and records same-SHA Jenkins evidence before deployment.
- `mutation.yml.disabled`: former nightly full and PR changed-file reports. Jenkins runs these on the isolated CI agent; mutation results remain nonblocking.
- `publish-sandbox-image.yml.disabled`: former two-provider multiarch GHCR publication. Jenkins uses `config/sandbox-publish.json`; the default-image gate consumes that same configuration.

Jenkins pipeline sources and their fixed controllers live in the documentation repository under `deploy/jenkins`. Source retirement does not erase GitHub execution history; the operational cutover also disables the former workflows in GitHub.
