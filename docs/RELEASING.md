# Releasing

One repository, one version for the product: the room server image and the client
package carry the same `X.Y.Z`. Everything is published by GitHub Actions; nothing
is published from a laptop.

| Trigger | What is published |
| --- | --- |
| Pull request | Nothing. The suites run and the image is built for both platforms, never pushed. |
| Push to `main` | The image, as `:latest` and `:sha-<commit>`. |
| Tag `v<version>` | The image as `:<version>`, `:<major>.<minor>` and `:stable`; the client to npm; a GitHub release. |

`latest` follows `main`, so it runs ahead of the newest release. Pull `stable`
for the newest release, `X.Y.Z` for one in particular, and a digest for an exact
build. Images are published for `linux/amd64` and `linux/arm64`, with an SBOM and
build provenance attached.

The image is built by `ci.yml`, after the suites it shares a run with: a version
is never published from code whose tests were not run on that same commit.

## Cutting a release

The version lives in the tag. The manifests published under it —
`packages/connector/package.json` and `apps/server/pyproject.toml` — are written
from one place, and a release refuses to run if they disagree with the tag:

```sh
scripts/version.sh set 0.3.0     # both manifests and the lock file
git commit -am "chore: release 0.3.0"
```

Merge that to `main`, then tag the merged commit:

```sh
git tag v0.3.0
git push origin v0.3.0
```

`release.yml` checks the tag against the manifests, runs the whole CI on it,
publishes the image and the client, and opens the GitHub release with generated
notes plus the pull and pairing commands. A tag with a hyphen — `v0.3.0-rc.1` —
is published as a pre-release and moves neither `stable` nor `X.Y`.

Tags are what people pull, so a bad release is corrected by cutting the next
patch, never by moving a tag.

## Version numbers

An npm version is spent the moment it is published: the number can never be
reused, not even after unpublishing it. So every publish needs a new one, and
there is no snapshot to overwrite.

`main` is therefore not published to npm on every commit — `ghcr.io/...:latest`
already carries it, and the client can be run from a checkout. npm gets release
versions only: `0.2.0`, `0.3.0`, and a patch when something published is wrong.
To rehearse the pipeline or ship something risky to a volunteer, tag a
pre-release (`v0.3.0-rc.1`): it is published under the **`next`** dist-tag, so
`npm install @sidevoice/uplink` keeps resolving to the last final release and
only `npm install @sidevoice/uplink@next` picks it up.

Below `1.0.0`, a breaking change is a minor bump and a fix is a patch. The
server image and the client carry the same number, so a version says which
server a client was built against.

## Running the image

```sh
docker run -d --name sidevoice -p 127.0.0.1:8767:8767 -v sidevoice-data:/data \
  ghcr.io/rubasace/sidevoice:stable
```

`/data` holds the room's journal, connector pairings and provider keys; keep it
on a volume so a redeploy keeps them. The room has no access control: publish it
only behind a reverse proxy that adds TLS and authentication, and set
`VOICE_PUBLIC_ORIGIN` to the public origin.

## One-time setup owned by the repository owner

None of it can be done by CI. Until it is done, releases still run: the image is
published, and the npm step reports that it was skipped.

### The image package

The first push creates the package **private**, even from a public repository,
and no API changes that. Open the package (Profile → Packages → `sidevoice`) →
Package settings → Change visibility → Public. It cannot be made private again.
While it is private, `docker pull` asks for credentials.

Nothing else is needed: the workflow authenticates with the repository's own
token.

### npm

The scope `@sidevoice` and the unscoped name `sidevoice-uplink` were both
unregistered when this was written, so either is available.

1. Create an account on npmjs.com and enable 2FA.
2. Create the organisation **`sidevoice`** — free for public packages — which
   gives the `@sidevoice` scope. If the name has been taken since, rename the
   package to `sidevoice-uplink` in `packages/connector/package.json` and skip
   the organisation.
3. **Publish the first version by hand.** npm can only be told to trust this
   repository on a package that already exists, so the first publish needs a
   human:

   ```sh
   cd packages/connector
   npm publish --access public      # asks for your 2FA code
   ```

   (Or let CI do it with a token in the repository secret `NPM_TOKEN`. It has
   to be a token that can publish with no human present: an **automation**
   token, or a **granular** token with *read and write* on the `@sidevoice`
   scope **and the bypass-2FA option enabled**. A granular token without it is
   refused with `403 ... Two-factor authentication or granular access token
   with bypass 2fa enabled is required to publish packages`.)
4. On the package page → Settings → **Trusted publisher** → GitHub Actions, with
   repository `rubasace/sidevoice` and workflow `release.yml`. From then on the
   release publishes over OIDC with no token at all: delete the `NPM_TOKEN`
   secret if you created one, and the `NODE_AUTH_TOKEN` block in
   `.github/workflows/release.yml` with it.
5. Set the repository variable **`PUBLISH_NPM`** to `true` (Settings → Secrets
   and variables → Actions → Variables). That is the switch the release reads.

Publishing over OIDC attaches provenance automatically, which is why the release
asks for `id-token: write`.

### The server as a Python package

Not yet, and deliberately. The server finds the assets it serves relative to the
checkout, and `pyproject.toml` ships only the `sidevoice` package, so a wheel
installed into `site-packages` would find neither the web build nor the browser
assets: PyPI would carry something that imports and then serves nothing. The
supported ways to run the server are the image and a checkout, and the packaging
work is tracked in #34. PyPI itself needs no token when that lands — a *pending
publisher* can be configured for a project that does not exist yet.
