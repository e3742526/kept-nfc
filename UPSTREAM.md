# Upstream and modification notice

SheepKeep is a modified work based on [Kept](https://github.com/keptinventory/kept), created by
[Ibrahim Roshdy](https://github.com/ibrahimroshdy) with the
[Kept contributors](https://github.com/keptinventory/kept/graphs/contributors).
The fork descends from [Kept revision `52a19f0`](https://github.com/keptinventory/kept/commit/52a19f0c9060f6db3f6250a6b46d7cd9032aae66).
Upstream changes through [Kept revision `c0a205bf`](https://github.com/keptinventory/kept/commit/c0a205bf195a626b910b9cc03aa5f933ad29d13b) were merged on November 25, 2026.
The fork's changes began on November 22, 2026 and include the iPhone client, NFC and QR workflows,
capture and recovery changes, inventory provenance, visual retrieval, and security fixes.
The SheepKeep rebrand and v2 identity integration are dated November 23, 2026.
Kept's copyright notices, commit authorship and [release history](CHANGELOG.md) are retained.
[CITATION.cff](CITATION.cff) records the project and its upstream reference.

## License and corresponding source

SheepKeep is an independently maintained derivative distributed under the
[GNU Affero General Public License, version 3](LICENSE). The upstream project and its contributors
are credited here. The production SheepKeep logo uses outlined Nunito lettering from the supplied
SheepKeep Identity v2 package. See the [Nunito source](https://github.com/google/fonts/tree/main/ofl/nunito)
and [SIL Open Font License](docs/assets/OFL-Nunito.txt). Other third-party notices ship with the
container and are visible at `/notices.txt` on a running instance.

[SheepKeep source repository](https://github.com/e3742526/kept-nfc) currently uses the original
fork slug. Published builds should link to the corresponding fork revision. The Docker build uses
`SOURCE` and `REVISION` to set the source URL. An operator serving a different modified tree needs
to set `KEPT_SOURCE_URL` to that version's corresponding source. See [AGPL §5, §6 and §13](LICENSE).

## Compatibility

| Surface | Existing identity |
|---|---|
| Signed iPhone app and Sign in with Apple | Bundle ID `info.keptinventory.nfc`, existing signing configuration, Keychain and `kept-nfc://auth/callback` |
| Inventory labels and saved links | Configured HTTPS origin and existing label paths, codes and NFC/QR records |
| Local and server data | Browser/PWA identifiers and storage keys, iPhone outbox storage, Postgres roles and schema, and existing export formats |
| Configuration and tooling | `KEPT_*` environment variables, `kept` CLI and Compose service, and private workspace scope `@kept/*` |

The display name and icons change independently of these identifiers. The fork retains inherited
Kept release and integration references for compatibility and provenance. Upstream binaries and
documents describe Kept. Build SheepKeep from this checkout using its [source instructions](README.md#build-and-run-from-source).
