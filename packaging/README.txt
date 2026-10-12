DebridTV
========

Start
  Double-click DebridTV.exe. A small black window opens and your browser opens
  the guide at http://127.0.0.1:7337. Keep the window open while you watch;
  closing it turns DebridTV off.

  Windows may say "Windows protected your PC" the first time, because this copy
  isn't signed. Click "More info", then "Run anyway".

Your settings
  Keys, channels, library and watch history live in %APPDATA%\DebridTV, not next
  to this file. Replacing DebridTV.exe with a newer one keeps all of it. If you
  ran DebridTV from a git checkout before, it uses the same folder, so nothing
  needs moving.

Compatibility mode (optional)
  Most files play without it. Files your browser can't decode, other audio
  tracks and subtitles need ffmpeg. Either run this in Command Prompt:
      winget install Gyan.FFmpeg
  or put ffmpeg.exe and ffprobe.exe in the same folder as DebridTV.exe. Then
  close DebridTV and start it again.

Options
  DebridTV.exe --no-browser    start without opening the browser
  set PORT=7340                use a different port (before starting)

Licenses
  LICENSE-node.txt covers the Node.js runtime packed inside DebridTV.exe.
