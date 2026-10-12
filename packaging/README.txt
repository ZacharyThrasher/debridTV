DebridTV
========

Start
  Double-click DebridTV.exe. A small black window opens, then the DebridTV
  window with the guide. Keep the small window open while you watch; closing it
  turns DebridTV off. Phones and TVs on your home network still use their
  browser (see Settings > Home network).

  Windows may say "Windows protected your PC" the first time, because this copy
  isn't signed. Click "More info", then "Run anyway".

Your settings
  Keys, channels, library and watch history live in %APPDATA%\DebridTV, not next
  to this file. Replacing DebridTV.exe with a newer one keeps all of it. If you
  ran DebridTV from a git checkout before, it uses the same folder, so nothing
  needs moving.

Compatibility mode
  Sets itself up. The first start downloads ffmpeg (about 110 MB, from gyan.dev,
  checked against its published checksum) into %LOCALAPPDATA%\DebridTV\ffmpeg.
  Settings > Sources shows progress; reload the page when it says ready. Most
  files play before it finishes. An ffmpeg you already have is used instead.

The video player
  The DebridTV window plays video with mpv, which plays every format as it is:
  Dolby Digital, DTS, TrueHD, HEVC, 10-bit and picture subtitles, with no
  conversion. The first start downloads mpv (about 40 MB, the mpv project's own
  release from github.com/mpv-player/mpv, checked against a pinned checksum)
  into %LOCALAPPDATA%\DebridTV\mpv. Until it's there, the window plays video
  the way Microsoft Edge does. Your own mpv.conf can go in
  %LOCALAPPDATA%\DebridTV\webview\mpv.

Options
  DebridTV.exe --browser       open the guide in your browser instead
  DebridTV.exe --no-browser    start without opening any window
  set PORT=7340                use a different port (before starting)

Licenses
  LICENSE-node.txt covers the Node.js runtime packed inside DebridTV.exe.
  THIRD-PARTY.txt covers the app window's libraries and the mpv player.
