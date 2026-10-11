# Probe fixtures

Tiny files (each under 60 KB) used by `test/probe.test.ts`. Regenerate from this directory with ffmpeg
(libx264, libx265, libvpx-vp9, libopus, ac3/eac3 encoders required). Expected durations in the test
were measured with `ffprobe -show_entries format=duration`.

```sh
V="-f lavfi -i testsrc=size=160x90:rate=10"
A="-f lavfi -i sine=frequency=440"

ffmpeg -y $V $A -t 7.5 -c:v libx264 -preset ultrafast -crf 40 -c:a aac -b:a 16k fixture-h264-aac.mkv
ffmpeg -y $V $A -t 5.2 -c:v libx264 -preset ultrafast -crf 40 -c:a ac3 -b:a 32k fixture-h264-ac3.mkv
ffmpeg -y $V $A -t 5.0 -c:v libx265 -preset ultrafast -crf 40 -x265-params log-level=none -c:a eac3 -b:a 32k fixture-hevc-eac3.mkv
ffmpeg -y $V $A -t 4.4 -c:v libvpx-vp9 -crf 50 -b:v 0 -deadline realtime -c:a libopus -b:a 16k fixture-vp9-opus.mkv

# moov at the end (ffmpeg default for mp4)
ffmpeg -y $V $A -t 7.5 -c:v libx264 -preset ultrafast -crf 40 -c:a aac -b:a 16k fixture-h264-aac-moov-end.mp4
# moov at the start
ffmpeg -y $V $A -t 7.5 -c:v libx264 -preset ultrafast -crf 40 -c:a aac -b:a 16k -movflags +faststart fixture-h264-aac-faststart.mp4
```

| file | container | video | audio | duration (ffprobe) |
| --- | --- | --- | --- | --- |
| fixture-h264-aac.mkv | matroska | h264 | aac | 7.523 s |
| fixture-h264-ac3.mkv | matroska | h264 | ac3 | 5.200 s |
| fixture-hevc-eac3.mkv | matroska | hevc | eac3 | 5.000 s |
| fixture-vp9-opus.mkv | matroska | vp9 | opus | 4.408 s |
| fixture-h264-aac-moov-end.mp4 | mp4 (moov last) | h264 | aac | 7.500 s |
| fixture-h264-aac-faststart.mp4 | mp4 (moov first) | h264 | aac | 7.500 s |

`fixture-tracks-chapters.mkv` (tracks and chapters; 8.023 s): two audio tracks (eng, spa titled "Español", not
default), one forced English SRT subtitle, chapters at 0 / 2 / 5 s.

```sh
printf ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=2000\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=2000\nEND=5000\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=5000\nEND=8000\n' > ch.txt
printf '1\n00:00:00,500 --> 00:00:02,000\nHello\n' > s.srt
ffmpeg -y $V $A -f lavfi -i sine=frequency=660 -i s.srt -i ch.txt -t 8 -map 0:v -map 1:a -map 2:a -map 3:s \
  -map_metadata 4 -map_chapters 4 -c:v libx264 -preset ultrafast -crf 40 -c:a aac -b:a 16k -c:s srt \
  -metadata:s:a:0 language=eng -metadata:s:a:1 language=spa -metadata:s:a:1 title=Español \
  -metadata:s:s:0 language=eng -disposition:a:1 0 -disposition:s:0 forced fixture-tracks-chapters.mkv
```

`fixture-chapters.mp4` / `fixture-chapters-qt.mp4` (MP4 chapters at 0 / 2 / 5 s): the first carries both a Nero
`chpl` list and a QuickTime chapter track with moov first; the second only the chapter track, moov last.

```sh
printf ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=2000\ntitle=One\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=2000\nEND=5000\ntitle=Two\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=5000\nEND=7500\ntitle=Three\n' > ch.txt
ffmpeg -y -i fixture-h264-aac-faststart.mp4 -i ch.txt -map 0 -map_metadata 1 -map_chapters 1 -c copy -movflags +faststart fixture-chapters.mp4
ffmpeg -y -i fixture-h264-aac-faststart.mp4 -i ch.txt -map 0 -map_metadata 1 -map_chapters 1 -c copy -movflags +disable_chpl fixture-chapters-qt.mp4
```

`fixture-hdr10-51.mkv` / `.mp4` (HEVC 10-bit tagged PQ/BT.2020, 5.1 AAC, 1 s):

```sh
ffmpeg -y $V $A -t 1 -c:v libx265 -preset ultrafast -crf 40 -x265-params log-level=none -pix_fmt yuv420p10le \
  -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc -c:a aac -ac 6 -b:a 64k fixture-hdr10-51.mkv
ffmpeg -y -i fixture-hdr10-51.mkv -c copy -tag:v hvc1 -movflags +faststart fixture-hdr10-51.mp4
```

## Audio (music channel, N-23a)

Made with ffmpeg from a 3 s 440 Hz sine, mono:

- `audio-cbr.mp3`: libmp3lame 32k CBR, ID3v2.3 title "Night Drive", artist "The Tapes", album "Cassette", track 3, year 1987, genre Synthpop. 3.056 s.
- `audio-vbr.mp3`: libmp3lame -q:a 6 (Xing header), ID3v2.4 title "Ünïcode Song". 3.056 s.
- `audio.flac`: 22.05 kHz, Vorbis comments as above (no genre). 3.000 s.
- `audio.ogg`: Vorbis q0, title and artist. 3.000 s.
- `audio.opus`: Opus 16k at 48 kHz, title and artist. 3.0065 s per ffprobe (3.000 s after pre-skip).
- `audio.wav`: 8 kHz unsigned 8-bit PCM, no tags. 3.000 s.
