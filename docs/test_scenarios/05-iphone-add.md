# iPhone Add item and Add box

These cards use the IOS-01 connection to a fixture started with `--seed --ai-mock`.
Before starting, record the destinations Home › Office › Desk drawer › Cable box
and Home › Living room › TV unit. Use the run marker in the notes of every item
and in the name of every box.

## ADD-01 Add several items from one screen

**Goal and category.** Primary happy path, persistence of the remembered
destination and relaunch.

**Preconditions and inputs.** Use a fresh app data container, so no item has
been added yet. Add a synthetic photo to the Simulator Photos library. Use
`Playtest extension lead`, then `Playtest spare fuse` with quantity `4`.

1. On Home, check the empty **Recently used boxes** message, then choose
   **Add manually**. Check that **Add item** is selected in the Item and Box
   switch. Check the order of the controls: description,
   **Scan UPC** and **Start with NFC**, then **Camera**, **Photos**, **Files** and
   **Clipboard**, then the destination and a collapsed **Details** with its
   hint. Check that the destination is Unplaced or the default location.
2. Tap **Change** and pick Cable box. Enter the first description, attach the
   photo with **Photos**, then open **Details**. Set **Action** to **Add
   contents** and pick one category. Tap **Save item** once.
3. Check that the status under the header says the item is saved, the form
   clears, focus returns to the description, and **Action** and the category
   are still selected. Save the second item with its quantity, then check the
   batch counts under the form.
4. Open TV unit from Browse without adding anything, then return to Home and
   choose **Add manually**. Terminate and relaunch the app and choose **Add
   with camera**, then cancel the camera or picker.

**Expected and observe.** Each item saves after one tap, and the batch counts
move from saved on device to synced. The destination stays on Cable box after
TV unit is opened and after relaunch, because only adding changes it. Cable
box is listed under **Recently used boxes** on Home. Cancelling **Add with
camera** returns to Home without an empty draft. In web inventory, Cable box contains each item once, with the photo,
**Add contents** history and the quantity. Watch for focus loss, a stale
status line, and categories that are kept but not shown.

## ADD-02 Reject bad input before anything is queued

**Goal and category.** Invalid and boundary input, error clarity.

**Preconditions and inputs.** ADD-01 destination. Synthetic files: a 25 MB
JPEG, a JPEG just over 25 MB, a `.txt` file, a zero-byte `.pdf` and 21 small
images. Quantities `0`, `-1`, `abc`, `1.2.3`, `1O` (letter O) and `2.5`.
Descriptions of whitespace only, 300 characters, and
`Playtest 🎄 décor زينة` with leading and trailing spaces.

1. Tap **Save item** with an empty description, then with whitespace only.
2. Open **Details** and try each quantity with a valid description. Note
   which values are blocked while typing and which reach **Enter a quantity
   greater than zero.**
3. Use **Files** to pick the 21 images, the oversized JPEG, the `.txt` file
   and the empty PDF. Tap **Clipboard** with nothing copied, then with text
   copied.
4. Save the long and the multilingual descriptions with valid quantities.
   Find both items in web inventory.

**Expected and observe.** Invalid saves leave the outbox and batch counts
unchanged and keep the other values. The file limit message is **Choose up to
20 files, each no larger than 25 MB.** The clipboard message is **Copy a photo
first, then try again.** Check whether a text-only clipboard and the empty
PDF give equally clear messages. Saved descriptions are trimmed, and their
text is unchanged in search. Note whether `2.5` is accepted and how it is
shown, and how the 300-character description is cut off, if at all.

## ADD-03 Pick AI suggestions field by field

**Goal and category.** Secondary happy path, partial acceptance and failed
dependency.

**Preconditions and inputs.** The `--ai-mock` fixture with AI enabled for the
location, two synthetic photos, and a description typed before analysis:
`Playtest kit`, quantity `3`.

1. Attach both photos and choose **Suggest details**. Check that each
   suggested description, quantity, note and category has its own row and
   shows what it replaces.
2. Tick only the note and one category that does not exist yet, then choose
   **Use 2 selected**. Check that **Review multiple items** stays hidden while
   suggestions are shown. Save the item.
3. Start another item with the same photos and choose **Accept all**. Before
   saving, disconnect the fixture and repeat **Suggest details** on a third
   item.
4. Reconnect and check the categories in Browse.

**Expected and observe.** Only the ticked fields change. The quantity and
description you typed stay unless you accept their rows. The new category is
created when it is accepted online and appears once. When AI is unavailable,
the form says so and **Save item** still works without suggestions. Watch for
duplicate categories with different casing, and for **Accept all** replacing a
quantity you typed when the description differs.

## ADD-04 Create a box with listed contents

**Goal and category.** Box workflow, parser boundaries and partial failure.

**Preconditions and inputs.** Connected fixture with Living room › TV unit as
the parent. Box name `Playtest tote <marker>` and type 27-gallon tote. Enter
these contents:

```text
3 x HDMI cable
HDMI cable x3
- bulleted adapter
• dotted remote

0 x ghost item
2.5 x half item
x5
<a line of 210 characters>
```

1. Choose **Add manually**, then disconnect and try **Add box** in the Item
   and Box switch. Reconnect, choose **Add box** and create the box with the
   contents above. Open it and compare each saved item with its line.
2. Create a second box whose contents list has 51 lines. Count the saved items.
3. Create a third box with **Create box and add items**. Add one item, then
   use Back and check that it returns to that box.
4. Optional: to test **Save contents**, stop the fixture just after the box is
   confirmed and before its contents sync.

**Expected and observe.** **Add box** is unavailable offline, and nothing is
queued. Leading and trailing counts give quantity 3, and bullets are removed.
Blank lines are skipped. Note how `0 x ghost item`, `2.5 x`, `x5` and the long
line are saved. At most 50 items are created at once. Note whether line 51 is
left in the field or dropped without a message. After a partial failure, the
field keeps only the lines that were not saved, and **Save contents** retries
without creating a second box or repeating saved lines. The new box becomes
the remembered destination for the next **Add item**, and it appears under
**Recently used boxes**.

## ADD-05 Change the destination and recover from a lost one

**Goal and category.** Navigation stress, cross-screen consistency and
unavailable resource.

**Preconditions and inputs.** ADD-01 has been run. A second connected browser
session for the same owner. In **More → Settings**, the default location is
set to Home.

1. In **Add item**, tap **Change**. Check that **Recent** destinations appear
   at the top and the picker's own **Recent** select is hidden. Pick TV unit
   from Recent and check that the picker closes.
2. Open **Change** again, go to Desk drawer and create **New bin** `Playtest
   bin <marker>`. Choose it as the destination. Tap **Scan place label** and
   observe the Simulator feedback, then return without losing the
   description.
3. Fill in a description and photo, disconnect, and save to the new bin. In
   the browser, move that bin to Trash. Reconnect and follow the recovery
   path for the failed item.
4. Change the default location to Personal and reopen **Add item**.

**Expected and observe.** The destination line always names the full path.
A pending bin can be chosen while offline. A trashed destination makes the
item **Needs attention**, and **Change box → Move and retry** delivers it once.
A remembered destination outside the default location falls back to Unplaced
in the new default location. Unplaced never offers a place label.

## ADD-06 Leave Add midway

**Goal and category.** Interrupted workflow, cancellation and relaunch.

**Preconditions and inputs.** Connected fixture, two photos and a PDF.
Description `Playtest abandoned`.

1. Enter the description, attach the files and tap Back. Choose to keep
   editing, then tap Back again and choose **Discard draft**.
2. Start again. Open **Details → QR or NFC label → New QR label**, and while it
   is being made, tap Back. Start a new item and open the label section.
3. Fill in a third item and terminate the app before saving. Relaunch and
   open **Add item**.
4. Fill in a fourth item, tap **Save item** twice quickly, and check the batch
   counts and the box.

**Expected and observe.** **Discard this draft?** appears only when there is
something to lose. Keeping the draft keeps its files. The label made during the
interrupted reservation is offered for the next item, not lost or attached
twice. Record whether an unsaved draft survives termination. This is a
product question unless documentation promises it. A double tap creates one
item.
