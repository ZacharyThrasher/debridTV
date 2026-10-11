# PC checks (Zachary's PC only)

Five checks the cloud can't do. Each one is short. Do them in any order; skip any you
don't have time for.

**Rules for every step**
- Run on your PC, never on a cloud machine.
- Read-only: nothing here adds, selects, deletes or downloads anything on your accounts.
- Type keys only into your own PowerShell window (step 1). Never paste a key into the
  chat. If one ever gets pasted, rotate it on the provider's site.
- Send back only the report files and yes/no answers named below.

| # | Check | Needs a key? | Provider traffic |
|---|---|---|---|
| 2 | Real-Debrid playback rerun | RD | a few API calls, ≤ 16 MB |
| 3 | ETag test (optional) | RD (+TorBox) | 2 extra link requests, 1-byte reads |
| 4 | Picture subtitles burned in | no | none |
| 5 | Chrome plays MKV with H.264/HEVC | no | none |
| 6 | Real-provider surfing numbers (optional) | RD or TorBox | streams what you watch |

## 0. Get the latest code (once)

```powershell
cd C:\Sandbox\debridTV-probe
git fetch origin
git checkout claude/debridtv-rnd-9768mu   # the release branch once the PR is merged
git pull
npm ci
```

Until the release PR is merged, use `claude/project-thread-claayu` instead.

## 1. Put your key in this window only

Typing it this way keeps it out of your history and off the screen.

```powershell
$s = Read-Host "Real-Debrid API token" -AsSecureString
$env:RD_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
```

For TorBox, run the same two lines with `$env:TORBOX_TOKEN`.

## 2. Real-Debrid playback rerun

1. See the numbered list (no links requested):
   ```powershell
   $env:LIST = "1"; node experiments/live-probe.ts; Remove-Item Env:LIST
   ```
   Each video gets a number like `[7]`. `[not finished]` can't be picked. In a `[pack]`,
   `7` is its biggest video and `7.2` the third one.
2. Pick a file you know plays on Real-Debrid (one you've streamed from their site lately):
   ```powershell
   $env:RD_PICK = "7"; node experiments/live-probe.ts
   ```
3. If it's refused too, that is a result. The probe never retries a refused file and
   never switches to TorBox for it. You can try another number.

## 3. ETag test (optional)

Do two versions of the same episode keep separate ETags, and does one file keep its ETag
across links? If you have two versions of one episode, give the second as `RD_PICK2`:

```powershell
$env:ETAG = "1"; $env:RD_PICK = "7"; $env:RD_PICK2 = "8"; node experiments/live-probe.ts
```

With both keys set, add `$env:TB_PICK = "<number>"` for the same file on TorBox to compare
providers. ETags are stored only as short hashes.

**Send:** the newest `experiments\out\live-probe-*.json` (drag it into the project chat).
It holds timings, sizes, status codes and hashed ETags only.

## 4. Picture subtitles burned in (no provider traffic)

1. Put one video with picture subtitles in a folder of its own, for example a Blu-ray
   remux in `C:\Sandbox\pgs-test\`. MKVToolNix or VLC lists them as "HDMV PGS" or "VobSub".
2. Check ffmpeg works, then start the app with a throwaway data folder:
   ```powershell
   ffmpeg -version
   $env:DEBRIDTV_HOME = "C:\Sandbox\debridtv-pctest"; npm start
   ```
3. Open http://127.0.0.1:7337. Settings, Sources, This PC: add `C:\Sandbox\pgs-test`,
   then Scan now.
4. Tune to the channel it lands on (the guide shows it). Press **C** until the picture
   subtitle track is chosen.

**Send three yes/no answers:** subtitles appear? In step with the speech (within about
half a second)? Still there after changing channel and coming back?

## 5. Chrome plays MKV with H.264 / HEVC (no provider traffic)

The cloud's test browser has no H.264, so this has only been checked on WebM.

1. Put two `.mkv` files in `C:\Sandbox\mkv-test\`: one H.264 and, if you have one, one
   HEVC (x265). VLC, Tools, Codec Information shows which.
2. With the app from step 4 still running (or started the same way), add
   `C:\Sandbox\mkv-test` under Settings, Sources, This PC, then Scan now.
3. Tune to each file's channel in **Chrome** (and Edge if you use it).
4. Press **I** for the info banner. It says "Compatibility mode" when the app had to
   convert the file instead of playing it directly.

**Send, per file:** codec, plays (yes/no), compatibility mode (yes/no), browser.

## 6. Surfing numbers on a real provider (optional)

This measures the quick channel-flip work (peek and edge cache) against your real
provider. It connects your key to a **throwaway** app data folder, which you delete at the end.

1. Start the app with the throwaway folder (skip if it's still running from step 4):
   ```powershell
   $env:DEBRIDTV_HOME = "C:\Sandbox\debridtv-pctest"; npm start
   ```
2. Settings, Sources: paste your key into the TorBox or Real-Debrid box **on that page**
   (your own browser on your PC, not the chat). Wait for the library to finish.
3. Surf for two minutes: some fast flips (several presses a second), some slow ones
   (about one a second), and revisit two channels you already watched.
4. In a second PowerShell window, save the numbers only:
   ```powershell
   $m = Invoke-RestMethod http://127.0.0.1:7337/api/meters
   $m | Select-Object apiTotal, apiPeak, bytes, cache, streamsOpened, streamsCancelled, peakStreams, tunes |
     ConvertTo-Json -Depth 4 | Set-Content C:\Sandbox\surf-numbers.json
   ```
5. Also note by feel: does a slow flip show a picture in about a second? Is a revisit faster?

**Send:** `C:\Sandbox\surf-numbers.json` and your two impressions.

## 7. Clean up

Stop the app (Ctrl+C), then:

```powershell
Remove-Item Env:RD_TOKEN, Env:TORBOX_TOKEN, Env:RD_PICK, Env:RD_PICK2, Env:TB_PICK, Env:ETAG, Env:DEBRIDTV_HOME -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force C:\Sandbox\debridtv-pctest
```

Deleting that folder removes the key the app saved in step 6.
