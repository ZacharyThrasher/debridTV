# Player parity: mpv / VLC features in a YouTube-style bar

Zachary's ask (2026-10-12): the player should do what mpv and VLC do, in a
YouTube-style package. This register lists each standard player capability,
whether DebridTV has it, and the plan. Status is scored from behaviour in a
browser test or a screenshot, never from a button existing.

Status (2026-10-12, branch claude/player-overhaul-minlr9, browser tests in test/ui/controls.test.ts):
**Y** works · **P** partly (limit noted) · **R3** later ·
**L** browser limit (what we do instead) · **N** not doing (why).

Routes, for the limits column: *direct* = the browser plays the file as-is;
*compat* = the PC's ffmpeg converts it (`/media/:id/live`), which can't seek
inside the stream, so a seek restarts it at the new point.

## Transport and timeline

| Capability (mpv / VLC) | Before | Status | How / limit |
|---|---|---|---|
| Play / pause (Space, K, click picture) | Y | Y | Bar button, Space/K, click on the picture, Play/Pause remote keys. |
| Seek bar with drag (scrubbing) | N | Y | YouTube-style scrubber; drag, click, or arrow keys while it has focus. |
| Hover time preview on the bar | N | Y | Time and chapter name tooltip. |
| Thumbnail preview while scrubbing | N | N | Would fetch media bytes for frames the viewer never watches; breaks the "no bytes for unwatched media" rule. |
| Chapter marks on the bar | N | Y | From `/api/item` `chaptersMs` (already probed). |
| Next / previous chapter | N | Y | Shift+←/→ (past the last chapter it skips to the next program). |
| Skip back / forward (10 s / 30 s) | On Demand only | Y | ←/→ everywhere (a channel time-shifts, ADR-0006), bar buttons, double-tap left/right on touch. `[` `]` and the bar's ⏮ ⏭ skip whole programs. |
| Jump to start / end | N | Y | Home = start of the program. End = Back to live on a channel, end of file in On Demand. |
| Elapsed / remaining / total time | Banner only | Y | Bar clock; click toggles elapsed vs remaining. |
| Back to live | On Demand only | Y | LIVE pill turns into "Back to live" when you're behind. |
| Frame step forward / back (. ,) | N | Y | Paused, direct play: one frame (from the file's frame rate, else 1/24 s). Compat streams step forward only. |
| Playback speed 0.25×–4× | N | Y | `<` `>` and the menu, pitch kept. On Demand, and a time-shifted channel in direct play. Live stays 1×, and so does compatibility mode (it drives its own catch-up). |
| A–B loop | N | Y | Menu (Loop → Set A, Set B). Works wherever you can seek. |
| Loop file | N | Y | Menu (Loop → Loop this program). |
| Resume where you left off | Y | Y | On Demand Continue Watching (N-30). |
| Playlist / next file | Y | Y | The channel schedule is the playlist; On Demand shows the next episode. |

## Sound

| Capability | Before | Status | How / limit |
|---|---|---|---|
| Volume, mute | Y (no slider) | Y | Slider on hover, `/` `*` keys, mouse wheel over the picture, M. |
| Volume boost above 100% | N | Y | Up to 200% through a Web Audio gain stage, only created once you go above 100%. |
| Audio track picker | A key cycles | Y | Menu list of tracks with language and codec. A non-default track needs compat mode (browsers can't pick an MKV's other tracks). |
| Audio delay (sync) | N | Y | Sound *later*: Web Audio delay, instant, any route. Sound *earlier*: compat mode shifts the audio on the PC (`&ad=`), restarting the stream at the same point. |
| Normalize / night mode (dynamic range) | N | Y | Web Audio compressor (like mpv `dynaudnorm`, VLC compressor). |
| Downmix 5.1 to stereo | Y | Y | Compat mode always sends stereo; direct play leaves it to the browser. |
| Equalizer | N | Y | Bass and treble (±12 dB) in Sound. |
| Passthrough (bitstream) | N | N | ADR-0004; browsers can't bitstream. |

## Subtitles

| Capability | Before | Status | How / limit |
|---|---|---|---|
| Subtitle track picker / off | C key cycles | Y | The CC button opens the "Easy subtitle controls" sheet (captions.js `openCaptions`) when it is merged; until then it cycles tracks like C. |
| Subtitle style (size, colour, background, position) | N | Y via "Easy subtitle controls" | Same sheet. |
| Subtitle delay | N | Y | Shifts cue times client-side (pref `subDelayMs`); works for any text cue source. Picture (PGS/VobSub) subtitles are burned in on the PC and can't be shifted. |
| Load an external subtitle file (.srt/.vtt) | N | Y | Pick a file from the device; parsed in the browser, never uploaded. |
| Embedded text subs on direct play | N | L | Browsers can't read subtitles inside MKV; choosing captions moves the program to compat mode (N-18a). |

## Picture

| Capability | Before | Status | How / limit |
|---|---|---|---|
| Aspect: auto / stretch / 4:3 / zoom-crop | Y (Z key) | Y | Z key, and in the menu. |
| Zoom | N | Y | Menu: 100–200%, centred. Pan isn't built. |
| Crop (VLC Video → Crop, mpv `video-crop`) | N | Y | Picture → Crop: presets 16:9, 4:3, 1.85:1, 2.39:1, per-edge trims (1% steps, up to 40%), and Auto, which finds black bars in the frame on screen (like mpv's autocrop) without fetching anything. Saved per device; Off restores the picture. Demo channels aren't cropped. |
| Rotate 90° / flip | N | Y | CSS transform; for phone-filmed or mirrored files. |
| Brightness / contrast / saturation | N | Y | CSS filters (VLC "Adjustments"). |
| Deinterlace | N | L | Browsers don't deinterlace; compat mode could (`yadif`) at a CPU cost. Not built until a real file needs it. |
| Screenshot | N | Y | Saves a PNG of the current frame on this device (X key, menu). Demo channels capture the painted picture. |
| Fullscreen | Y | Y | F, double-click the picture, bar button. |
| Picture-in-picture | N | Y | P key and bar button (Chrome/Edge/Safari). |
| HDR / Dolby Vision | P | L | Plays where the browser and screen support it; chips show the format (N-37). |
| Hardware decoding | Y | Y | The browser decides. |

## Info and control

| Capability | Before | Status | How / limit |
|---|---|---|---|
| On-screen controls that auto-hide | Dock only | Y | YouTube-style bar, fades after 3 s without movement; stays while paused or focused. |
| Stats overlay (mpv `i`, YouTube "Stats for nerds") | N | Y | Route, codecs, resolution, dropped frames, buffer, speed, delays. |
| Keyboard shortcuts + help overlay | Welcome card | Y | `?` opens a full shortcut sheet. |
| Mouse wheel volume, double-click fullscreen | N | Y | |
| Touch: tap to show, double-tap to skip, swipe channels | Swipe only | Y | |
| TV remote | Y (no bar) | Y | ←/→ seeks and shows the bar; Down then lands on it; ←/→ move, OK presses, Up or Back leaves. The menu is a remote layer (spatial.js). |
| Remember settings | Some | Y | Volume and boost, night mode, tone, delays and picture adjustments are saved per device. Speed resets at Back to live. |
| Sleep timer | Y | Y | Sign-off hours (N-17). |
| Open a URL / network stream | N | N | Out of scope: DebridTV plays your library; live/M3U is a separate gate. |

## Rules that still hold

Locked items stay locked (the bar shows nothing playable and the menu has no
track list for them); refused copies are never retried; the bar and its
previews fetch no media; the edge cache is filled only from bytes a viewer
already streamed.
