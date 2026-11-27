# Monkey runs

A monkey run taps and types in ways no real user would plan. Each run follows
a new random script made from a fresh seed, so no two runs are alike. The seed
also lets someone replay a run that found a problem.

## Rules for every monkey run

**Make the script.** Generate a seed and a 60-step script, then copy both into
the report before the first step:

```sh
SEED=$(od -An -N4 -tu4 /dev/urandom | tr -d ' ')
echo "seed $SEED, fixture monkey-$(echo "$SEED" | tr 0-9 a-j), $(awk --version 2>&1 | head -1)"
awk -v s="$SEED" 'BEGIN { srand(s); for (i = 1; i <= 60; i++)
  printf "%2d  where=%2d  do=%2d  junk=%d  pick=%2d\n", i,
    int(rand()*12)+1, int(rand()*10)+1, int(rand()*6)+1, int(rand()*100) }'
```

To replay a run, use its seed with `awk` on the same machine. Do not reuse a
seed for a new run.

**Use a fixture of its own.** From `apps/web`, start a seeded fixture used only
by this run, under the fixture name printed above:
`node --conditions=kept-dist e2e/serve.mjs <fixture name> <unused port> --seed
--ai-mock`. Everything in it is disposable, and it is dropped when the process
stops. Never point a monkey at a shared, staging or production server.

**Read each line.** `where` selects the screen from the card's table.
`do` selects the action, and `junk` selects the text from the junk table.
`pick` selects the control: count the controls you can see in reading order
(top to bottom, then start to end) and use number `pick × count ÷ 100 + 1`,
rounded down. When the selected control is disabled, tap it anyway, then use
the next enabled one. Log each step as it happens: the line, the control you
used, and what you saw.

**Junk table.**

| junk | Text to type or paste |
| --- | --- |
| 1 | A 10–40 character keyboard mash, such as `qwpoe;;''kzz]]` |
| 2 | `🦆🦆 زينة é̀ 中文 👩🏽‍🔧 Ω` |
| 3 | Spaces, a tab and three newlines only |
| 4 | One of `-0`, `1e309`, `00012`, `NaN`, `٣`, `1,5` or `999999999999`, chosen in order by `pick` |
| 5 | 1,200 characters of filler text that end with the seed |
| 6 | `<b>bold</b> {{name}} %s %@ \n ../../x` |

**Answering dialogs.** Answer a confirmation with the button that `pick`
selects, like any other control. This means some deletes, moves and discards
go through, which is intended. Treat **Sign out** as an exception: cancel it
the first time, confirm it the second time, then sign in again with the
fixture's owner. If the monkey deletes the location it is working in, restore
it from **Settings → Locations** in the web app and carry on. Cancel every share sheet, print dialog, file picker after one
look, and any system permission prompt that would reach outside the
Simulator or browser profile.

**When something breaks.** A crash, blank screen, error page, spinner that
lasts more than 15 seconds, missing tab bar, or a screen with no way back
counts as a finding. Record the step, take a screenshot and copy the logs.
Then recover in the simplest way, such as relaunching or reloading, and carry
on with the next line. If the same problem happens three times, stop the run.

**Checkpoints.** After steps 20, 40 and 60, go back to Home without typing
anything. Note the sync status line and the Home counts, and check that the
last step's action either finished or was clearly cancelled.

**After the run.** Reconnect if needed and wait for sync. Then check:

- No item or box exists twice because of one Save.
- Every saved record whose text came from the junk table looks the same in
  web inventory, search and History as it did on the phone.
- **More → Recent capture batches** has no **Needs attention** entry the log
  cannot explain.
- **More → Logs** and the browser console have no unhandled errors.
- The seeded records the log never touched are unchanged.

Stop only the fixture you started.

## MONKEY-01 iPhone monkey

**Goal and category.** Exploratory seam testing of the native app with
random navigation, input, interruption and network changes.

**Preconditions and inputs.** Simulator signed in to this run's fixture as in
IOS-01, a synthetic photo and a small PDF in the Simulator, and the script
for this run. Allow 30–45 minutes.

| where | Screen to go to |
| --- | --- |
| 1–2 | Stay on the current screen |
| 3 | **Home** tab |
| 4 | **Browse** tab |
| 5 | **Scan** tab |
| 6 | **History** tab |
| 7 | **More**, then the row that `pick` selects |
| 8 | Home → **Add manually** |
| 9 | Home → **Add with camera** |
| 10 | Home → **Add to bin** |
| 11 | A record from **Recently used boxes**, or from Browse when that list is empty |
| 12 | **Assistant** in the header |

| do | Action |
| --- | --- |
| 1 | Tap the selected control |
| 2 | Tap the selected control three times as fast as possible |
| 3 | Type the junk into the nearest text field, then tap the selected control |
| 4 | Type the junk, then go Back at once, before anything finishes |
| 5 | Start typing the junk, then tap another tab halfway through |
| 6 | Open the selected control, then dismiss what opens by swiping down, tapping outside it or choosing **Cancel** |
| 7 | Send the app to the background with Shift-Command-H, wait 3–10 seconds and reopen it. Every third time, terminate and relaunch it instead. |
| 8 | Rotate with Command-Left Arrow, or switch appearance with Shift-Command-A, alternating |
| 9 | Disconnect or reconnect the fixture as in IOS-02. At most once every 8 steps; otherwise use action 1. |
| 10 | Do something nonsensical that is not in this table, and describe it in the log |

**Expected and observe.** The app never crashes, shows a blank web view or
gets stuck without a way back to Home. Every tap that saves something saves it
once. Offline actions either queue with a clear status or explain why they
need a connection. Junk text is accepted, trimmed or refused with a message,
but never changes the layout so much that a control becomes unreachable.
After relaunch, the app returns to a sensible screen and keeps drafts it said
were saved.

## MONKEY-02 Browser monkey

**Goal and category.** Exploratory seam testing of the web app with random
navigation, keyboard use, reloads and resizing.

**Preconditions and inputs.** A fresh browser profile signed in to this run's
fixture as the seeded owner, a 1280 px window, the browser console open, and
the script for this run. Allow 30–45 minutes. A native browser alert or
confirmation blocks automated browser tools. If one appears, record it as a
finding and dismiss it by hand.

| where | Screen to go to |
| --- | --- |
| 1–2 | Stay on the current screen |
| 3 | Home |
| 4 | The search field |
| 5 | A location's places or map |
| 6 | Cable box |
| 7 | HDMI cable, 2 m |
| 8 | **Labels**, including **Print queue** and **Thermal printing** |
| 9 | Settings, then the section that `pick` selects |
| 10 | Trash |
| 11 | Assistant |
| 12 | Add a thing from wherever the current screen offers it |

| do | Action |
| --- | --- |
| 1 | Click the selected control |
| 2 | Triple-click the selected control |
| 3 | Type the junk into the nearest field and press Enter |
| 4 | Type the junk, then press the browser's Back button at once |
| 5 | Press 5–15 keys at random from Tab, Shift-Tab, Enter, Space, Escape and the arrow keys |
| 6 | Open the selected control, then dismiss what opens with Escape or a click outside it |
| 7 | Reload, or use the browser's Back and Forward buttons, alternating |
| 8 | Resize between 375 px and 1280 px wide, or zoom to 200% and back, alternating |
| 9 | Switch the network to offline or back to online in the developer tools, or open the current page in a second tab and keep going there, alternating |
| 10 | Do something nonsensical that is not in this table, and describe it in the log |

**Expected and observe.** No step produces an unhandled error page, a console
error, or a screen without navigation. Focus stays visible and Escape closes
whatever is on top. Reload, Back and Forward give the same screen and data
each time. Two tabs show the same data after a reload, and a stale tab's edit
is refused with a clear message rather than silently overwriting newer data.
Junk text shows as plain text everywhere, including headings, search results,
labels and History.
