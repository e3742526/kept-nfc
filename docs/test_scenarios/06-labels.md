# Labels, UPCs, print queue and thermal printing

These cards use the IOS-01 Simulator connection to a seeded fixture with the
Labels module enabled. They also use a fresh browser profile signed in as the
same owner. No Bluetooth printer or physical tag is used. NIIMBOT output,
NFC writes and camera scanning remain hardware work in the
[iOS README](../../apps/ios/README.md#niimbot-b1-pro-printing) and the
[thermal printing runbook](../runbooks/thermal-printing.md).

## LBL-01 Give a new item a label while adding it

**Goal and category.** Label during capture, unavailable hardware and
offline limits.

**Preconditions and inputs.** ADD-01 destination Cable box. Seeded label
codes `3CB8WN` (Cable box) and `7KQ4MZ` (HDMI cable, 2 m). Descriptions
`Playtest labelled A`, `Playtest labelled B` and `Playtest unlabelled`.

1. Save `Playtest unlabelled` without opening the label section. After it
   syncs, open the item's **QR and NFC label** screen.
2. For item A, open **Details → QR or NFC label → New QR label**. Choose
   **Share QR label PDF** and cancel the share sheet. Save the item.
3. For item B, choose **Scan QR label** and enter `7KQ4MZ` if the Simulator
   offers manual entry. Then try **Scan NFC tag** and **Start with NFC** and
   record the Simulator feedback. Choose **Remove label** and save.
4. Disconnect and open the label section for a new item.

**Expected and observe.** The unlabelled item gets a QR code when it syncs.
Item A's QR opens item A in the browser after sync, and its PDF opens in the
share sheet. A used code gives **This label is already on HDMI cable, 2 m.
Use a blank label.** and is never attached. Offline, **New QR label** is
replaced by **Connect to make a new label. You can still scan a blank
label.** When NFC is unavailable, a clear message is shown and you can still
return to the form.

## LBL-02 Start from a UPC

**Goal and category.** Alternate entry point, invalid input and duplicates.

**Preconditions and inputs.** Valid synthetic UPC-A `012345678905` and its
13-digit form `0012345678905`. Invalid codes: `01234567890` (11 digits),
`012345678906` (wrong check digit), `0123456789O5` (letter O) and
` 012345678905 ` with spaces. A second valid code, `123456789012`, assigned in
the web record editor's **Barcode** field to two marked items.

1. Choose **Scan UPC** and enter each invalid value in **UPC digits**, then
   choose **Check UPC**.
2. Enter `012345678905`. Save the new item `Playtest UPC item`. Repeat with
   the 13-digit form.
3. Enter `123456789012` and choose between the two matches. Repeat it.
4. Disconnect and enter a new valid UPC. Reconnect after saving.

**Expected and observe.** Invalid digits keep the field and show **Scan a
product UPC or enter the digits printed under it.** The first valid code
starts an item with **UPC: 012345678905**. The equivalent form opens the same
item. Two matches show **Several existing items have this UPC. Choose the one
to open.** The phone then remembers that choice. Record what happens to an
offline UPC that matches nothing and whether the message is clear.

## LBL-03 Queue on the phone and print from the browser

**Goal and category.** Cross-device workflow, cleanup and boundaries.

**Preconditions and inputs.** LBL-01 items, a marked bin from ADD-05 and a
marked item in another inventory location the owner can access.

1. In the browser, open **Labels** and confirm **Your print queue is empty.**
   On the phone, choose **Queue label** on item A, the marked bin and the item
   in the other location. Queue item A twice.
2. In the browser, choose **Refresh**. Filter by **Inventory location** and by
   **Items** and **Places**, then choose **Prepare labels** for Home items.
   Move item A to TV unit on the phone and queue it again.
3. Move the marked bin to Trash in the browser. Choose **Refresh**.
4. Choose **Open print batch**, then **AirPrint / share**. Return and choose
   **Remove** for one entry. Prepare again and choose **Yes, printed OK**.
5. Open **More → Print label sheets** on the phone and check its print queue.

**Expected and observe.** Each record is listed once per location. Queuing it
again does not add a duplicate row. A prepared batch keeps the location it was
prepared for, and a moved record is listed only in its current location. A
trashed record shows **Record unavailable** and does not stop the batch. **Yes,
printed OK** removes only that batch's entries, and they no longer count as
unprinted. The phone and browser lists agree, and the page heading levels
follow the page's order on each surface.

## LBL-04 Templates and printer settings without a printer

**Goal and category.** Settings persistence, unavailable device and print
boundaries.

**Preconditions and inputs.** Connected Simulator with Bluetooth unavailable
or denied, and a prepared batch from LBL-03. Printer profile name `Playtest
B1 <marker>`.

1. Open **Thermal printing** from item A's **QR and NFC label** screen.
   Choose **View templates** and compare **Standard inventory label**, **QR
   code and item details**, **QR code, category and contents** and
   **Small-parts drawer**. Choose **Use template** on one of them.
2. Choose **Printer settings** from the print screen, then **Find nearby
   printers** and **Check printer status**. Return to the draft.
3. Choose **50 × 30 mm**, change an offset, and choose **Save printer
   profile**. Choose **Prepare calibration print** and **Prepare labels**.
   Try 41 pages, a range that ends before it starts, 21 copies and 0 copies.
4. Relaunch the app, open **More → Settings → Printer settings**, and reopen
   the batch from the print queue.

**Expected and observe.** The chosen template is marked **Selected** and is
kept on reopening the batch. Printer settings return to the same draft.
Without Bluetooth, you are told what to change and can still use **System
print dialog**. Out-of-range pages and copies are blocked before any job
starts. The profile, stock and calibration persist after relaunch. Forget the
profile when the card is complete.
