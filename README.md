# SheepKeep

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/sheepkeep-lockup-dark.svg">
  <img src="docs/assets/sheepkeep-lockup-light.svg" alt="SheepKeep" width="300">
</picture>

**Your things, remembered.** SheepKeep is a self-hosted home inventory with an iPhone companion
for documenting rooms, boxes and the things in them.

SheepKeep is an independent, modified fork of [Kept](https://github.com/keptinventory/kept),
created by [Ibrahim Roshdy](https://github.com/ibrahimroshdy) and developed with its contributors.
The fork was previously called **Kept NFC**. It is maintained separately from Kept.
See [upstream credits, source and compatibility](UPSTREAM.md) and [citation metadata](CITATION.cff).

## What SheepKeep adds

- An iPhone app for rooms, boxes and inventory editing. Scan existing QR or NFC labels, print QR
  label sheets, and record additions, removals, moves and photographs in the history.
- Offline captures with original photographs and documents, plus review for work held after a
  server restore.
- Text and photo queries against an opt-in local visual index. See the
  [verification status](docs/mvp1/status.md) for the current retrieval and device evidence.

## Build and run from source

Use Docker with Compose v2. Build the image from this checkout and select it explicitly.

```sh
git clone https://github.com/e3742526/kept-nfc.git sheepkeep
cd sheepkeep
docker build --build-arg REVISION="$(git rev-parse HEAD)" -t sheepkeep:local .
test -f .env || printf 'KEPT_IMAGE=sheepkeep:local\n' > .env
KEPT_IMAGE=sheepkeep:local docker compose run --rm init
KEPT_IMAGE=sheepkeep:local docker compose up -d
```

Follow the setup address and code printed by `init`. Set `KEPT_IMAGE=sheepkeep:local` in the
instance's `.env` to select the build on later starts. For an existing installation, use its
current Compose project name, volumes and public URL so the database and printed labels stay
connected to the same instance.

Use HTTPS for the iPhone app and browser camera features. The [iPhone setup guide](apps/ios/README.md)
covers local builds. See [CONTRIBUTING.md](CONTRIBUTING.md) for development and focused checks.
[Kept's upstream documentation](https://keptinventory.info/) is a reference for inherited features
and upstream distribution channels. [SheepKeep security reporting](SECURITY.md) covers this fork.

## License and source

SheepKeep is distributed under the [GNU Affero General Public License, version 3](LICENSE).
See the [modification and attribution notice](UPSTREAM.md) for the upstream revision, dates and
third-party credits. Deployments should make the corresponding source of the running revision
available through the app's **Source code** link. The image also serves its third-party notices
at `/notices.txt`.
