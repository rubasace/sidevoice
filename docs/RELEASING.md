# Releasing

One repository, one version for the product: the room server image and the client package
carry the same `X.Y.Z`.

## Continuous: every push to `main`

`release.yml` builds the server image (Python room plus the built web room and browser
audio runtime) and publishes it to the GitHub container registry as
`ghcr.io/rubasace/sidevoice:latest` and `:sha-<commit>`. `ci.yml` runs the Python and
JavaScript suites; pull requests also build the image without publishing it.

## Versioned: tag `vX.Y.Z`

1. Set the version in `packages/connector/package.json` and `apps/server/pyproject.toml`
   (the release job refuses a tag that does not match both).
2. `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. What happens: the image is published as `:X.Y.Z` and `:X.Y`; a GitHub release named
   `vX.Y.Z` is created with generated notes and the image reference; `publish.yml` publishes
   `@sidevoice/uplink@X.Y.Z` to npm.

## One-time setup owned by the repository owner

- npm: an account, the `sidevoice` organisation, and either an automation token in the
  repository secret `NPM_TOKEN` or npm trusted publishing for the package (see issue #2).
- The container registry needs nothing: the workflow uses the repository's own token, and
  packages of a public repository are public.

## Running the image

```sh
docker run -d --name sidevoice -p 127.0.0.1:8767:8767 -v sidevoice-data:/data \
  ghcr.io/rubasace/sidevoice:latest
```

`/data` holds the room's journal, connector pairings and provider keys; keep it on a volume so
a redeploy keeps them. The room has no access control: publish it only behind a reverse proxy
that adds TLS and authentication, and set `VOICE_PUBLIC_ORIGIN` to the public origin.
