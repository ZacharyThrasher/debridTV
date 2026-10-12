# Player parity: mpv / VLC features in a YouTube-style bar

Zachary's ask (2026-10-12): the player should do what mpv and VLC do, in a
YouTube-style package. This register lists each standard player capability,
whether DebridTV has it, and the plan. Status is scored from behaviour in a
browser test or a screenshot, never from a button existing.

Status: **Y** works · **P** partly (limit noted) · **R1/R2/R3** planned round ·
**L** browser limit (what we do instead) · **N** not doing (why).

Routes, for the limits column: *direct* = the browser plays the file as-is;
*compat* = the PC's ffmpeg converts it (`/media/:id/live`), which can't seek
inside the stream, so a seek restarts it at the new point.

## Transport and timeline

| Capability (mpv / VLC) | Before | Status | How / limit |
|---|---|---|---|
| Play / pause (Space, K, click picture) | Y | Y | Bar button, Space/K, click on the picture, Play/Pause remote keys. |
| Seek bar with drag (scrubbing) | N | R1 | YouTube-style scrubber; drag, click, or arrow keys while it has focus. |
| Hover time preview on the bar | N | R1 | Time and chapter name tooltip. |
| Thumbnail preview while scrubbing | N | N | Would fetch media bytes for frames the viewer never watches; breaks the "no bytes for unwatched media" rule. |
| Chapter marks on the bar | N | R1 | From `/api/item` `chaptersMs` (already probed). |
| Next / previous chapter | N | R1 | Shift+←/→, and in the menu. |
| Skip back / forward (10 s / 30 s) | On Demand only | R1 | ←/→ (On Demand), bar buttons, double-tap left/right on touch. Live-channel seeking comes from the "free seeking" thread; the bar calls its `seekTo`. |
| Jump to start / end | N | R1 | Home / End. |
| Elapsed / remaining / total time | Banner only | R1 | Bar clock; click toggles elapsed vs remaining. |
| Back to live | On Demand only | R1 | LIVE pill turns into "Back to live" when you're behind. |
| Frame step forward / back (. ,) | N | R1 | Paused, direct play: one frame (from the file's frame rate, else 1/24 s). Compat streams step forward only. |
| Playback speed 0.25×–4× | N | R1 | `<` `>` and the menu, pitch kept. Offered when not pinned to live (On Demand or time-shifted); on a live channel speed would drift off the schedule. |
| A–B loop | N | R2 | Menu; direct play and On Demand. |
| Loop file | N | R2 | Menu, On Demand only. |
| Resume where you left off | Y | Y | On Demand Continue Watching (N-30). |
| Playlist / next file | Y | Y | The channel schedule is the playlist; On Demand shows the next episode. |

## Sound

| Capability | Before | Status | How / limit |
|---|---|---|---|
| Volume, mute | Y (no slider) | R1 | Slider on hover, `/` `*` keys, mouse wheel over the picture, M. |
| Volume boost above 100% | N | R1 | Up to 200% through a Web Audio gain stage, only created once you go above 100%. |
| Audio track picker | A key cycles | R1 | Menu list of tracks with language and codec. A non-default track needs compat mode (browsers can't pick an MKV's other tracks). |
| Audio delay (sync) | N | R2 | Sound *later*: Web Audio delay, instant, any route. Sound *earlier*: compat mode shifts the audio on the PC (`&ad=`), restarting the stream at the same point. |
| Normalize / night mode (dynamic range) | N | R2 | Web Audio compressor (like mpv `dynaudnorm`, VLC compressor). |
| Downmix 5.1 to stereo | Y | Y | Compat mode always sends stereo; direct play leaves it to the browser. |
| Equalizer | N | R3 | Simple bass/treble shelf in the menu. |
| Passthrough (bitstream) | N | N | ADR-0004; browsers can't bitstream. |

## Subtitles

| Capability | Before | Status | How / limit |
|---|---|---|---|
| Subtitle track picker / off | C key cycles | Y via "Easy subtitle controls" | That thread's captions sheet; the bar's CC button opens it. |
| Subtitle style (size, colour, background, position) | N | Y via "Easy subtitle controls" | Same sheet. |
| Subtitle delay | N | R2 | Shifts cue times client-side (pref `subDelayMs`); works for any text cue source. Picture (PGS/VobSub) subtitles are burned in on the PC and can't be shifted. |
| Load an external subtitle file (.srt/.vtt) | N | R2 | Pick a file from the device; parsed in the browser, never uploaded. |
| Embedded text subs on direct play | N | L | Browsers can't read subtitles inside MKV; choosing captions moves the program to compat mode (N-18a). |

## Picture

| Capability | Before | Status | How / limit |
|---|---|---|---|
| Aspect: auto / stretch / 4:3 / zoom-crop | Y (Z key) | Y + R1 menu | Z key, and in the menu. |
| Zoom and pan | N | R2 | Menu: 100–200% zoom. |
| Rotate 90° / flip | N | R2 | CSS transform; for phone-filmed or mirrored files. |
| Brightness / contrast / saturation | N | R2 | CSS filters (VLC "Adjustments"). |
| Deinterlace | N | L | Browsers don't deinterlace; compat mode could (`yadif`) at a CPU cost. Not built until a real file needs it. |
| Screenshot | N | R2 | Saves a PNG of the current frame on this device (X key, menu). Demo channels capture the painted picture. |
| Fullscreen | Y | Y | F, double-click the picture, bar button. |
| Picture-in-picture | N | R1 | P key and bar button (Chrome/Edge/Safari). |
| HDR / Dolby Vision | P | L | Plays where the browser and screen support it; chips show the format (N-37). |
| Hardware decoding | Y | Y | The browser decides. |

## Info and control

| Capability | Before | Status | How / limit |
|---|---|---|---|
| On-screen controls that auto-hide | Dock only | R1 | YouTube-style bar, fades after 3 s without movement; stays while paused or focused. |
| Stats overlay (mpv `i`, YouTube "Stats for nerds") | N | R2 | Route, codecs, resolution, dropped frames, buffer, speed, delays. |
| Keyboard shortcuts + help overlay | Welcome card | R1 | `?` opens a full shortcut sheet. |
| Mouse wheel volume, double-click fullscreen | N | R1 | |
| Touch: tap to show, double-tap to skip, swipe channels | Swipe only | R1 | |
| TV remote | Y (no bar) | R1 | Down from the picture or OK on the bar reaches it; ←/→ move, OK presses, Back hides. |
| Remember settings | Some | R1 | Volume, speed (On Demand), delays, picture adjustments are saved per device. |
| Sleep timer | Y | Y | Sign-off hours (N-17). |
| Open a URL / network stream | N | N | Out of scope: DebridTV plays your library; live/M3U is a separate gate. |

## Rules that still hold

Locked items stay locked (the bar shows nothing playable and the menu has no
track list for them); refused copies are never retried; the bar and its
previews fetch no media; the edge cache is filled only from bytes a viewer
already streamed.
