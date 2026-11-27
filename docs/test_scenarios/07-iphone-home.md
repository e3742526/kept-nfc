# iPhone Home, places and locations

These cards use the IOS-01 Simulator connection to a seeded fixture and a
fresh browser profile signed in as the same owner.

## HOME-01 Add to a bin from Home and change its type

**Goal and category.** Home shortcut, box types and cross-screen consistency.

**Preconditions and inputs.** Seeded Cable box. New box `Playtest shoe box
<marker>` of type shoe box bin, under Living room › TV unit.

1. On Home, choose **Add to bin**. Tap the plus on Cable box and check that
   **Add item** opens locked to that box. Save `Playtest via Home`.
2. Create the shoe box. Open it, choose **Edit** and change its type to
   cardboard box. Use Back from the edit screen once without saving, then
   save the change.
3. Open the box in the browser and compare its type and contents. Return to
   Home and check the counts and **Recently used boxes**, then open the
   **History** tab. Disconnect and open **History** again.

**Expected and observe.** The plus adds to the chosen box. Note whether that
also changes the destination **Add manually** starts at. Cancelling the edit
keeps the original type. Both devices show the same type and contents, and
Home's counts open lists that match them. Both boxes appear under **Recently
used boxes**, most recent first, and **History** lists the add and the type
change. Offline, **History** explains that it needs a connection, or shows
what it has.

## HOME-02 Mark an item missing and find it

**Goal and category.** Status workflow, offline limits and reversibility.

**Preconditions and inputs.** Marked item `Playtest via Home` from HOME-01.

1. Open the item and choose **Mark missing**. Open **Missing items** on Home
   and check its last recorded location.
2. Disconnect. Open **Missing items** again and try **Mark found here**.
3. Reconnect, choose **Mark found here**, and check the **History** tab. Mark it missing
   again and use **Move** to TV unit instead.

**Expected and observe.** The offline list shows cached records, and changing
the status offline is refused with a clear reason, without changing the
status. **Mark found here** keeps the location. **Move** records the new
location and removes the item from **Missing items**. Each change appears
once in History with the person and time.

## HOME-03 Build places and hide a location

**Goal and category.** Settings, deletion and restore.

**Preconditions and inputs.** Connected owner. Location `Playtest Cabin
<marker>` created in the browser for this card. Place names `Playtest Loft`,
then `Playtest Loft shelf` and the 300-character name
`Playtest <long name>`.

1. Open **Home → Places → Create place** in the cabin. Save with a blank name,
   then with the loft name. Use **Add sub-location** for the shelf. Use
   **Edit** to change the loft's kind to closet and add a description.
2. Disconnect and create one more place. Check it in Places and as an **Add**
   destination, then reconnect.
3. Open **More → Settings → Locations**. Hide Personal, relaunch the app,
   and check navigation. Delete `Playtest Cabin <marker>` only, after
   checking its name in the confirmation.
4. In the browser, restore the cabin from **Settings → Locations**.

**Expected and observe.** A blank name is refused. The defaults are Room at
the top level and Spot inside a place, and edits and moves keep the path
correct. A pending place is a valid destination, and its items wait for it to
sync. Hidden Personal stays hidden after relaunch. Deletion warns that the
location is removed for everyone. Restore brings back the cabin and its
places within 30 days. Show Personal again at the end of the card.
