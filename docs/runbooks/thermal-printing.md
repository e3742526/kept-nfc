# Thermal label printing

Open **Labels → Thermal printing** in a location, or choose **Thermal printing** in an existing
record’s label builder. On iPhone, open **Print label sheets** from the app’s menu or **QR and NFC
label** on a record. Choose a printer profile and physical stock independently. To reuse a printer,
save its name, queue, resolution and calibration in **Save printer profile**.

| Stock | Physical size | PDF page (points) | At 203 DPI | At 300 DPI |
| --- | --- | --- | --- | --- |
| Compact Thermal | 50 × 20 mm | 141.7323 × 56.6929 | 400 × 160 | 591 × 236 |
| Large | 4 × 6 in · 101.6 × 152.4 mm | 288 × 432 | 812 × 1218 | 1200 × 1800 |
| Small | 2 × 1 in · 50.8 × 25.4 mm | 144 × 72 | 406 × 203 | 600 × 300 |
| Micro | 1.75 × 0.75 in · 44.45 × 19.05 mm | 126 × 54 | 355 × 152 | 525 × 225 |
| Micro Thermal | 1.2 × 0.8 in · 30.48 × 20.32 mm | 86.4 × 57.6 | 244 × 162 | 360 × 240 |

New thermal setups start with **Compact Thermal — 50 × 20 mm**. Select and save a stock in a
printer profile to make it that profile’s default. The compact layout places the QR on the left
and the complete identifier at the top right. It fits a short name, size or model, and registered tag
indicators as space permits. For temporary labels, use the available space for handwriting.

The 50 × 20 profile matches the advertised BrokSilent 310-label gap roll. Measure the gap on the
physical roll. Enter the printer’s minimum media width and feed length when known and position its
optical sensor over the stock gap. The reference queue offers speed 3 and darkness 8 as starting
settings. Verify the setting units in your driver before applying them.

The 1.2 × 0.8 profile matches the advertised LUCKIPLUS 1,000-label direct thermal roll. Measure
the gap on the actual roll. The calibration label uses a QR with a known scale chosen from the
active resolution and printable area, with position and readability references printed beside it.

The 4 × 6 stock also offers cut-apart layouts for two 4 × 3, six 2 × 2 or twelve 2 × 1 labels.
Follow the printed guides to cut the sticker by hand. Office stock, including OL330 / Spartan S002
on US Letter, and the older thermal and tape sizes are available under **Office sheets and other
stock**.

## Configure a printer

1. Add the printer with its supported driver or an IPP queue in your operating system. Use the
   printer's minimum and maximum media widths to check that it accepts the roll. Follow its guide
   for positioning the roll, aligning the sensor and running a media calibration.
2. In SheepKeep choose **Thermal printing**, select the roll and save a profile. For direct
   thermal gap stock, choose gap tracking and measure the physical gap. Set DPI and enter the
   available printable width and height. Apply the corresponding paper size, tracking, darkness
   and speed in the system print dialog or queue. Driver options vary.
3. Choose **Prepare calibration print** and print one sticker at 100% with headers, footers, fit to
   page and extra margins disabled. Check the top marker, border and center ticks. Edge ticks
   are 5 mm apart. Confirm the complete sample ID and scan the QR. Check which side feeds first.
4. Adjust the X/Y offsets and margins in SheepKeep, then save the calibration for that printer
   and stock. DPI, orientation, QR size and driver settings are also remembered for that
   pair when saved. The physical page size stays fixed. On a new roll or printer, check the first few
   consecutive labels to detect alignment drift before using a full batch.

### macOS and the LOSRECAL reference printer

The LOSRECAL ITPP128 used here identifies over USB as a 4BARCODE 4B-2054M. The community driver
builds a native ARM64 CUPS filter and uses Apple’s USB backend. Follow the driver's build,
architecture check and installation instructions, then select its PPD when adding the USB
printer. Use `lpstat -p -d` and `lpoptions -p <queue> -l` to find your queue and its supported
media, resolution and tracking options. `LOSRECAL_Open` is the reference machine’s queue name.
Keep the queue's normal defaults and select custom media for each job. [Open-source driver](https://github.com/glaucusec/4barcode-macos-driver).

Open an exported PDF in Preview or use SheepKeep’s browser **Print** button. For a CUPS queue that
advertises custom media, a one-label test can also be sent from the computer that owns the queue:

```sh
lp -d YOUR_QUEUE -n 1 -o media=Custom.50x20mm -o print-scaling=none calibration.pdf
```

CUPS or the driver may reject this size if the press or filter imposes a minimum. Check the
driver options and feed guides before trying narrow media. [CUPS printing options](https://www.cups.org/doc/options.html).

### Windows, Linux, Raspberry Pi and iPhone

- **Windows:** Add the printer to Windows and select it in the browser or PDF viewer. Define the
  exact media size in the driver if needed, then choose **Actual size**.
- **Linux or Raspberry Pi:** Add a CUPS queue with a Linux-compatible driver or IPP print service
  for your printer. A Pi can expose that queue over IPP on a trusted network. The printer must
  support the requested custom media through the queue. Open the PDF at 100% or use the CUPS
  command above.
- **iPhone or iPad:** Tap **Print** to use the system print sheet with a compatible AirPrint
  network printer. The printer or bridge must advertise the required media. For a USB printer,
  export the PDF and print it from the computer connected to that printer.
  [Apple’s system printing interface](https://developer.apple.com/documentation/uikit/uiprintinteractioncontroller).
- **TSPL2:** The reference CUPS driver handles the conversion for compatible hardware. SheepKeep
  sends a document to the system print interface.

## Choose the label identity and QR type

- **Temporary write-in** issues a batch under `TMP`. **Preprinted category** uses your
  three-letter prefix and category name. A batch such as `TOL-A09Z-0001` has one random Base36
  series key and increasing sequence numbers. Use **Prepare labels** to save the batch before
  printing.
- Existing records use their registered identifier. On 1.2 × 0.8 stock, the dedicated layout
  reserves the full bottom line for the identifier and flows the short name, model and relevant
  tag indicators beside the QR. Choose **Identification only** to leave that space available to
  the QR. Handwriting space is optional and fits when the selected layout leaves room.
- **HTTPS link for phone cameras** is the default. **Compact code for the SheepKeep scanner** is
  an explicit choice on the 50 × 20 mm and 1.2 × 0.8 in stocks and works through SheepKeep’s scanner or code entry.
  The QR has medium error correction and a four-module quiet zone. A long HTTPS address can
  require three dots per module or exceed the available area. Scan a calibration or proof at the
  actual size. Use a shorter permanent HTTPS label address, increase the stock size, or choose
  the compact QR for SheepKeep-only workflows. Thermal PDFs use a standard Latin font. Optional
  text outside its supported character set may be omitted.
- The printed **NFC** mark describes a linked tag verified by iPhone NDEF readback on an
  existing record. Inspect a previously programmed tag from the record’s label screen to save
  verification. Pending or unknown associations leave the mark off. **UHF** indicates a
  registered EPC. Register a reader-supplied EPC using the record’s current label. A compatible
  external reader integration can resolve it through the scan API with format `uhf_rfid`.
  The web and iPhone apps use their existing camera and NFC radios. Product barcodes remain
  product identifiers and several records can share one product code.

## Offline registration, reprints and replacements

Open the thermal screen once while connected to cache the permanent label address and, on the
web, the PDF exporter. An offline temporary or category batch is saved on the device before
printing. It remains pending until the device can register it on the server. Reopen the thermal
screen online or use **Retry registration**. The QR retains its batch guard after registration.

A series collision goes into review. Remove any stickers printed from that batch, keep the
record of the collision and issue a fresh batch. The typed aliases may match another
reservation. The QR includes the batch guard so its resolution fails safely.

Use **Device batch history** or **Recent batches** to reprint existing identifiers. To switch
sizes, choose the destination stock and use **Reprint on selected stock** for a device batch.
For a server batch, choose the stock in its reprint editor. The original identifiers and QR
payloads are reused when changing physical stock. After a partial
print, reprint the missing pages via the system dialog's page range. Confirm only after you have
checked the output. **Replace a label identity** takes a registered, unclaimed label and a reason.
The previous sticker still resolves for authorized users and shows its superseded status. NFC
and UHF associations remain with the inventory target. Full instance backups retain the label
registry. Portable household exports carry short IDs and replacement audit events. Series
reservations, batch history, live replacement links and NFC/UHF associations require a full
instance backup. Verify and register tags again when moving inventory through a portable import.

## If printing fails or produces blank labels

- Check the queue state, USB cable, roll face and direct thermal setting. The original reference
  printer’s USB fault was resolved by changing its cable.
- Compare the PDF page size with the driver's media selection. Turn off fit to page and choose
  no extra margins. Ensure the sensor mode and measured gap match the roll.
- Start with one calibration label. Check the printer's media calibration, darkness and speed
  before retrying. Reopen the existing batch when its identifiers have already been printed.
- CUPS job completion reports spooler status. Look at the physical label before confirming.

One 4 × 6 calibration document from this renderer printed through the reference macOS CUPS queue.
The 50 × 20 mm, 2 × 1 in, 1.75 × 0.75 in and 1.2 × 0.8 in rolls still require feed, gap,
speed, darkness, alignment and phone-camera qualification on physical stock. For 50 × 20 mm,
check consecutive labels, NFC operation through the sticker and adhesion on your bin and tool
surfaces. Automated rendering and decoding cover both 203
and 300 DPI.
