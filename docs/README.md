# SheepKeep documentation

## Operate SheepKeep

- [Build and run from source](../README.md#run-from-source)
- [Set up HTTPS on a home network](../apps/docs/src/content/docs/install/home-network.md)
- [Upgrade an installation](runbooks/upgrade.md)
- [Configure permanent QR and NFC labels](runbooks/device-labels.md)
- [Back up and restore an installation](runbooks/backup-restore.md)
- [Run a restore drill](runbooks/restore-drill.md)
- [Prepare a release](runbooks/release.md) and [configure GitHub repository settings](runbooks/repo-settings.md)
- [Release notes](releases/)

## Build and test

- [Contributor guide](../CONTRIBUTING.md) and [local setup](../apps/docs/src/content/docs/developers/local-setup.md)
- [iPhone setup and development](../apps/ios/README.md)
- [iPhone and NFC acceptance checklist](runbooks/nfc-mvp.md)
- [Manual test scenarios](test_scenarios/README.md)

## Engineering records

- [NFC MVP1 integration contract](mvp1/integration-contract.md) and [qualification status](mvp1/status.md)
- [Native inventory workflows](mvp1/native-inventory-workflows.md), [iOS handoff](mvp1/ios-handoff.md), and [backend handoff](mvp1/backend-handoff.md)
- [Visual retrieval plan and measurements](mvp1/visual-retrieval-plan.md)
- [NFC software design and iPhone mockups](mvp1/design/README.md)
- Optimization reviews from November 24, 2026. [Detailed report](optimization/2026-11-24-muse-gem-neon.md) · [Shorter review](optimization/2026-11-24-muse-spark.md)

The [documentation site source](../apps/docs/src/content/docs/) lives with the docs app. Shared
project artwork lives in [`docs/assets/`](assets/). Keep local audit notes in the ignored
`docs/audits/` directory and scratch files in `.tmp/`.
