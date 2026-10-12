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

Compatibility mode
  Sets itself up. The first start downloads ffmpeg (about 110 MB, from gyan.dev,
  checked against its published checksum) into %LOCALAPPDATA%\DebridTV\ffmpeg.
  Settings > Sources shows progress; reload the page when it says ready. Most
  files play before it finishes. An ffmpeg you already have is used instead.

Options
  DebridTV.exe --no-browser    start without opening the browser
  set PORT=7340                use a different port (before starting)

Licenses
  LICENSE-node.txt covers the Node.js runtime packed inside DebridTV.exe.
