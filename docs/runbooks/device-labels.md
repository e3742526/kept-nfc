# Permanent labels: numbered series, the label address and app links

A printed label and an NFC tag carry one HTTPS link for good. This runbook covers how that link is
made, how to deploy the address it uses, and what still has to be checked on real hardware.

## How it fits together

- **The physical label is a short ID.** `short_ids` (D45, D112, D120) is the tag registry: six
  Crockford characters, unique across the instance, never deleted or reissued; `blank`,
  `assigned` or `retired`; one target at a time, any number of codes per thing or place
  (`is_primary`). Claiming, moving, retiring and reprinting work on it, and the audit log keeps
  each change.
- **A numbered label is an alias of one short ID.** `PPP-XXXX-NNNN`: a purpose prefix (`BIN`,
  `ITM`, `LOC`, `SHF`, `TMP` for write-in labels, `GEN`, or any three letters), a random base36
  series ID, and the label's place in the series. A series is reserved by the server when its
  blank sheet is made (`POST /api/v1/labels/batches` with `kind: 'blank'` and
  `series: {prefix}`): uniqueness is the database's (`label_series_prefix_series_uq`), never a
  phone's. `label_series` and `label_aliases` are append-only and outlive a purged location, so an
  alias is never reissued. The prefix never limits what a label is claimed for.
- **One link format.** `https://<label host>/l/<short ID or alias>`. The scanner reads it from any
  host (D120); `/t/<alias>` is read as the same label. Typed, an alias may use spaces or printed
  hyphens; base36 keeps O, I and L.
- **Resolution.** `POST /api/v1/scan/resolve` answers an alias as its short ID: `open`, or `claim`
  with the short ID to claim. An alias someone can't see is the same `not_in_your_kept` as any
  other miss. Resolution runs under row-level security; a label is not a credential.
- **Printing.** A label whose code has an alias prints the alias and its link, so a replacement
  label (a reprint of the batch, or of the thing it was claimed for) is the same label. The QR is
  vector, error correction M, a four-module quiet zone, its version chosen by the encoder.
- **Write-in sheet.** `letter_20_2x2in` is the OL330 layout: 2-inch squares, 4 × 5 on Letter,
  ¼-inch margins, ⅛ inch between rows and none between columns, measured from a sheet laid out for
  that stock. Each label prints the code and the QR across the top and four grey lines to write
  on; a label with no name yet prints "Contents" over a short line by the code. It suits `TMP`
  series.

## Deploying the label address

1. Pick a host you will keep for as long as the labels last, such as `labels.example.org`. Point
   its DNS at the same server (or proxy) as `KEPT_PUBLIC_URL`, with a valid HTTPS certificate.
   The proxy must pass the `Host` header through.
2. Set `KEPT_LABEL_URL=https://labels.example.org` and restart. New labels and NFC tags carry it.
   On that host, `/l/<code>` (and `/t/<alias>`) redirect with `302` to `KEPT_PUBLIC_URL`, where the
   person signs in and is brought back to the label; `/` goes to the public address; everything
   else is `404`. Nothing is served there that could sign anyone in.
3. For the iPhone app, set `KEPT_APPLE_APP_IDS=<TEAM_ID>.info.keptinventory.nfc`. The server
   serves `/.well-known/apple-app-site-association` on both hosts (no redirect, no sign-in), and the
   app's Associated Domains name the label host (`apps/ios/README.md`).
4. Labels printed before keep the address they carry. When the server moves, keep the label host
   pointed at it; when the public host changes, list the old one in former hostnames (D120).

Do not print a production batch until the label host is the one you will keep.

## Physical acceptance checklist

None of these has been run yet; they need an iPhone, signing and the label host live.

| Check | Expected |
| --- | --- |
| Scan a numbered label with the iPhone Camera, app installed | The app opens the thing, or offers to claim a blank |
| Same, app not installed or link opened in Safari | Web sign-in, then the label's page |
| Same, signed out of the app | Sign in, then the label opens |
| Tap a tag written by the app (NTAG213 20 × 10 mm inlay) | The link notification, then the same destination as the QR |
| Write a tag, then read it back in the app | Verified; the tag and the label's QR carry the same URL |
| Remove the tag during a write | `write_unverified`; a rescan reads what is on it, nothing is registered twice |
| Print a series on 1 × 1, 1.5 × 1, 1.5 × 1.5 and 2 × 2 inch rolls | The QR reads from 20 cm; the alias is legible; nothing is cut off |
| Print a test page on plain paper, hold it over an OL330 sheet against the light, then print a `TMP` series on the sheet | Every label inside its square, including the bottom row; the lines take a pen |
| Scan a tag under a paper label, on plastic, and on metal | Reliable on paper and plastic; record what metal needs (a ferrite-backed tag) |
| Scan a label printed before this change | Opens as before |

## Not done yet

- **Reassigning or retiring a label by hand.** A blank is claimed once; a short ID moves only when
  its thing is merged into another and retires when its target is purged. The registry has the
  states and the audit trail; routes to move a label to another thing or place, or retire a lost
  one, are not written yet.
- **Offline numbered labels.** The phone's snapshot carries no series, so offline a numbered
  label is "Not on this phone" and is checked again online. Adding aliases to the sync snapshot is
  the next step.
- **NFC hardware registry.** Tags are written through Core NFC's NDEF session, which doesn't give
  the chip's UID or type. Recording the UID and chip (NTAG213/215/216) needs an ISO 14443 tag
  session and a table of its own; until then a tag is identified by what it holds, which is enough
  to find, verify and rewrite it. The UID is never proof of identity.
- **Batch NFC programming.** Writing a numbered series to a roll of tags in one resumable flow.
  Each tag can be written one at a time today.
- **A universal link to a blank label in the iPhone app** shows that it is unavailable rather than
  offering the claim; the in-app scanner offers it.
- **Exports** don't carry series; the short IDs travel, so labels resolve after an import only by
  their short ID. Moving a household to another server needs series in the export first.
- **The moving report's QR codes** still use `KEPT_PUBLIC_URL`.
- **Android App Links** (`/.well-known/assetlinks.json`) use the same link format and need no new
  labels; the file isn't served yet.
