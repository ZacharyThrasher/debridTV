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
