# Contributing

Thanks for helping improve Discord Dot Bridge.

## Before you start

- Search open and closed issues and pull requests for related work.
- Open an issue before starting a substantial change or a breaking change. Describe
  the problem and proposed approach so the scope is clear.
- Keep each pull request focused on one change.

## Set up and check your changes

Use the [local development instructions](README.md#local-development) and run
the checks listed in [Local checks](README.md#local-checks). The project uses
Node.js 24 and the Terraform version pinned in
[`terraform/versions.tf`](terraform/versions.tf).

Use fictional identities in tests and fixtures. Never commit credentials,
populated deployment files, Terraform state or plans, response policy text, or
private Discord content.

## Open a pull request

Explain what changed, why it changed, and how you checked it. Link the related
issue. Call out any change to deployment behavior, stored data, access scopes,
or policy handling, and update the relevant documentation.

Merging into `main` triggers the deployment workflow when the production
environment is configured. Review deployment and migration effects before
proposing changes to those paths.

For security reports, follow [SECURITY.md](SECURITY.md) instead of opening a
public issue.
