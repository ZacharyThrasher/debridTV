# Live probe runbook (Zachary's PC only)

The live probe reads your own Real-Debrid / TorBox account. It never adds, selects,
deletes or downloads anything, caps media reads at 16 MB, and writes a report with
no keys, links or file names. It must run on your PC, never on a cloud machine
(Real-Debrid treats server traffic as paid Remote Traffic).

Approved scope (2026-10-10): read-only probing. Nothing here goes beyond that.

## 0. Get the latest probe

```powershell
cd C:\Sandbox\debridTV-probe
git fetch origin
git checkout claude/project-thread-y7lgyq   # or the shared branch once this work is merged into it
git pull
```

## 1. Put your key in this window only

Typing the key this way keeps it out of your PowerShell history and out of the screen.

```powershell
$s = Read-Host "Real-Debrid API token" -AsSecureString
$env:RD_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
```

(For TorBox, the same with `$env:TORBOX_TOKEN`.)

## 2. See the numbered list (no links requested)

```powershell
$env:LIST = "1"; node experiments/live-probe.ts; Remove-Item Env:LIST
```

Each video gets a number like `[7]`. Entries marked `[not finished]` can't be picked.
A `[pack]` holds several files: `7` picks its biggest video, `7.2` picks the third one.

## 3. Real-Debrid playback rerun (the open item)

Pick a file you know plays on Real-Debrid (for example, one you've streamed from
their website recently). The first auto-pick was refused with `infringing_file`;
that file stays refused and the probe will not retry it.

```powershell
$env:RD_PICK = "7"; node experiments/live-probe.ts
```

If this one is refused too, that is a result: the probe stops for that file, and you
can pick another number. It never switches to TorBox for the same file.

## 4. Optional: ETag edition test (two extra link requests, 1-byte reads)

Answers: does a file keep the same ETag across links, and does a different version of
the same episode get a different one? If you have two versions of one episode (say a
720p and a 1080p), give the second one's number as `RD_PICK2`.

```powershell
$env:ETAG = "1"; $env:RD_PICK = "7"; $env:RD_PICK2 = "8"; node experiments/live-probe.ts
```

With both keys set and the same file picked on both (`RD_PICK` and `TB_PICK`), the
report also says whether the two providers give it the same ETag. ETags are stored
as short hashes, never raw.

## 5. Clean up and send the report

```powershell
Remove-Item Env:RD_TOKEN, Env:TORBOX_TOKEN, Env:RD_PICK, Env:RD_PICK2, Env:TB_PICK, Env:ETAG -ErrorAction SilentlyContinue
dir experiments\out
```

Send the newest `live-probe-*.json` from `experiments\out` (drag it into the project
chat). It contains timings, sizes, status codes and hashed ETags only.
Never paste a key into the chat; if one gets pasted, rotate it.

## 6. Picture subtitles burned in (no provider traffic)

This checks the one compatibility path the cloud can't: Blu-ray (PGS) or DVD
(VobSub) subtitles drawn into the picture. It only reads a file on your PC.

1. Put one video that has picture subtitles in a folder of its own, for example a
   Blu-ray remux `.mkv` in `C:\Sandbox\pgs-test\`. (MKVToolNix or VLC lists them as
   "HDMV PGS" or "VobSub".)
2. Start the app from the checkout with ffmpeg installed (`ffmpeg -version` works in
   the same window), then open http://127.0.0.1:7337:
   ```powershell
   npm start
   ```
3. Settings, Sources, This PC: add `C:\Sandbox\pgs-test`, then Scan now.
4. Tune to the channel it lands on (the guide shows it), press **C** until the picture
   subtitle track is chosen.
5. Note: do the subtitles appear, are they in step with the speech (within about half
   a second), and does changing channel and coming back keep them? A phone photo of
   the screen is plenty.

Send those three answers (yes/no each) in the project chat.
