// Native playback for the DebridTV desktop app (Windows). The app window hosts this
// page in WebView2 and runs mpv in a native window underneath it. mpv plays every
// format (Dolby Digital, DTS, TrueHD, HEVC, 10-bit, PGS subtitles) without
// conversion, and the page stays see-through where the picture is.
//
// Nothing else in the player has to know: this module stands in for the #video
// element. It keeps the element in the page (layout, captions, focus) but answers
// its media properties, methods and events from mpv, so player.js, controls.js and
// the rest drive mpv exactly as they drive a <video>.
//
// In a normal browser window.__DTV_NATIVE is missing and this module does nothing.
// The host relays mpv's JSON IPC both ways: send() takes one mpv command object,
// and the host calls window.__dtvMpv(message) for each reply or event.

const host = window.__DTV_NATIVE;
const video = document.getElementById("video");

if (host && video) install();

function install() {
  document.documentElement.classList.add("native-video");
  const style = document.createElement("style");
  // The picture is behind the page: everything between it and the window must be
  // see-through. Anything drawn on top (cards, guide, bars) stays as it is.
  style.textContent = `html.native-video, html.native-video body, html.native-video #stage, html.native-video #video { background: transparent !important; }`;
  document.head.append(style);

  // ---------------------------------------------------------------- mpv link

  let nextId = 1;
  const pending = new Map();
  const send = (command) => host.send(JSON.stringify({ command }));
  const ask = (command) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      host.send(JSON.stringify({ command, request_id: id }));
    });
  const setProp = (name, value) => send(["set_property", name, value]);

  const OBSERVED = ["duration", "seeking", "paused-for-cache", "demuxer-cache-state", "video-params", "track-list", "speed", "idle-active", "frame-drop-count", "estimated-vf-fps"];

  // ---------------------------------------------------------------- state

  const st = {
    src: null, // what the page set, as written
    loaded: null, // { base, start, a, s, ad } of the file mpv has open
    loading: false,
    pos: 0, // mpv time-pos (seconds into the file) at posAt
    posAt: 0,
    duration: NaN,
    paused: true,
    seeking: false,
    waiting: false,
    readyState: 0,
    ended: false,
    error: null,
    volume: 1,
    muted: false,
    rate: 1,
    ranges: [],
    w: 0,
    h: 0,
    tracks: [],
    drops: 0,
    fps: 0,
    startedAt: 0,
    loadQueued: false,
  };
  const fire = (type) => video.dispatchEvent(new Event(type));
  // Seconds of the stream as the page counts them: a compatibility URL (/live?start=)
  // counts from its start point, a direct file from 0.
  const base = () => st.loaded?.start ?? 0;
  const filePos = () => (st.paused || st.seeking || st.waiting || !st.loaded ? st.pos : st.pos + ((performance.now() - st.posAt) / 1000) * st.rate);

  // ---------------------------------------------------------------- the element

  const define = (name, get, set) => Object.defineProperty(video, name, { configurable: true, get, set });
  define("src", () => (st.src ? new URL(st.src, location.href).href : ""), (v) => setSrc(v));
  define("currentSrc", () => (st.src ? new URL(st.src, location.href).href : ""));
  define("currentTime", () => Math.max(0, filePos() - base()), (t) => seekTo(Number(t) + base()));
  define("duration", () => (Number.isFinite(st.duration) ? Math.max(0, st.duration - base()) : NaN));
  define("paused", () => st.paused);
  define("ended", () => st.ended);
  define("seeking", () => st.seeking);
  define("readyState", () => st.readyState);
  define("networkState", () => (st.loaded ? 2 : st.src ? 2 : 0));
  define("error", () => st.error);
  define("volume", () => st.volume, (v) => {
    st.volume = Math.min(1, Math.max(0, Number(v) || 0));
    setProp("volume", Math.round(st.volume * 100));
    fire("volumechange");
  });
  define("muted", () => st.muted, (v) => {
    st.muted = !!v;
    setProp("mute", st.muted);
    fire("volumechange");
  });
  define("playbackRate", () => st.rate, (v) => {
    const r = Number(v) || 1;
    if (r === st.rate) return;
    st.pos = filePos();
    st.posAt = performance.now();
    st.rate = r;
    setProp("speed", r);
    fire("ratechange");
  });
  define("defaultPlaybackRate", () => 1, () => {});
  define("preservesPitch", () => true, () => {}); // mpv keeps pitch at any speed
  define("preload", () => "auto", () => {});
  define("videoWidth", () => st.w);
  define("videoHeight", () => st.h);
  define("buffered", () => ranges(st.ranges.map(([a, b]) => [Math.max(0, a - base()), Math.max(0, b - base())])));
  define("seekable", () => ranges(Number.isFinite(st.duration) ? [[0, Math.max(0, st.duration - base())]] : []));

  const attr = { get: video.getAttribute, has: video.hasAttribute, remove: video.removeAttribute, set: video.setAttribute };
  video.getAttribute = function (n) {
    return String(n).toLowerCase() === "src" ? st.src : attr.get.call(this, n);
  };
  video.hasAttribute = function (n) {
    return String(n).toLowerCase() === "src" ? st.src != null : attr.has.call(this, n);
  };
  video.removeAttribute = function (n) {
    if (String(n).toLowerCase() === "src") return void (st.src = null, (st.paused = true));
    return attr.remove.call(this, n);
  };
  video.setAttribute = function (n, v) {
    if (String(n).toLowerCase() === "src") return void (video.src = v);
    return attr.set.call(this, n, v);
  };
  video.load = () => queueLoad();
  video.play = () => {
    if (!st.src) return Promise.reject(new DOMException("No source", "NotSupportedError"));
    if (st.paused) {
      st.paused = false;
      st.posAt = performance.now();
      st.ended = false;
      setProp("pause", false);
      fire("play");
      if (st.readyState >= 3 && !st.seeking) fire("playing");
    }
    return Promise.resolve();
  };
  video.pause = () => {
    if (st.paused) return;
    st.pos = filePos();
    st.paused = true;
    setProp("pause", true);
    fire("pause");
  };
  video.fastSeek = (t) => (video.currentTime = t);
  video.canPlayType = () => "probably";
  video.requestPictureInPicture = () => Promise.reject(new DOMException("Not in the app window", "NotSupportedError"));
  video.getVideoPlaybackQuality = () => {
    const secs = st.startedAt ? (performance.now() - st.startedAt) / 1000 : 0;
    return { droppedVideoFrames: st.drops, totalVideoFrames: Math.round(secs * (st.fps || 24)) + st.drops, corruptedVideoFrames: 0, creationTime: performance.now() };
  };
  video.requestVideoFrameCallback = (cb) =>
    requestAnimationFrame((now) => cb(now, { mediaTime: video.currentTime, presentedFrames: 0, width: st.w, height: st.h, expectedDisplayTime: now }));
  video.cancelVideoFrameCallback = (id) => cancelAnimationFrame(id);
  // Every <video> in this window answers "yes, I can play that": mpv can. The player
  // then plays files directly instead of asking for compatibility mode.
  HTMLMediaElement.prototype.canPlayType = function () {
    return "probably";
  };

  // ---------------------------------------------------------------- loading

  /** What a page URL asks for: the file, where to start, and which tracks. */
  function parse(src) {
    const u = new URL(src, location.href);
    const live = u.pathname.match(/^(\/media\/[^/]+)\/live$/);
    const q = u.searchParams;
    const num = (k) => (q.has(k) && q.get(k) !== "" && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : null);
    if (!live) return { url: u.href, base: u.pathname + u.search, start: null, a: null, s: null, ad: 0 };
    // A compatibility-mode URL. mpv needs no conversion, so it plays the file itself
    // from the same point, with the same tracks and the same sound delay.
    const direct = new URL(live[1], location.href);
    return { url: direct.href, base: direct.pathname, start: num("start") ?? 0, a: num("a"), s: num("s"), ad: num("ad") ?? 0 };
  }

  /** A new source starts paused, as in a browser; play() right after it still plays. */
  function setSrc(v) {
    const next = v == null || v === "" ? null : String(v);
    if (next !== st.src) st.paused = true;
    st.src = next;
    queueLoad();
  }

  /** Setting src and calling load() in the same moment opens the file once. */
  function queueLoad() {
    if (st.loadQueued) return;
    st.loadQueued = true;
    queueMicrotask(() => {
      st.loadQueued = false;
      load();
    });
  }

  function load() {
    if (!st.src) {
      if (st.loaded || st.loading) send(["stop"]);
      reset();
      fire("emptied");
      return;
    }
    const want = parse(st.src);
    const same = st.loaded && !st.loading && st.loaded.base === want.base && st.loaded.a === want.a && st.loaded.s === want.s && st.loaded.ad === want.ad;
    st.ended = false;
    st.error = null;
    fire("loadstart");
    if (same) {
      // The same file from another point (a compatibility stream restarting after a
      // seek): mpv just seeks, no reopening.
      st.loaded = { ...want, start: want.start ?? 0 };
      seekTo(want.start ?? 0);
      return;
    }
    reset(true);
    st.loading = true;
    st.loaded = { ...want, start: want.start ?? 0 };
    st.pos = want.start ?? 0;
    st.posAt = performance.now();
    setProp("start", want.start != null ? String(want.start) : "none");
    setProp("audio-delay", want.ad / 1000);
    setProp("pause", st.paused);
    setProp("speed", st.rate);
    send(["loadfile", want.url, "replace"]);
  }

  function reset(keepSrc = false) {
    st.loaded = keepSrc ? st.loaded : null;
    st.loading = false;
    st.readyState = 0;
    st.duration = NaN;
    st.ranges = [];
    st.seeking = false;
    st.waiting = false;
    st.w = st.h = 0;
    st.drops = 0;
    st.startedAt = 0;
    if (!keepSrc) {
      st.paused = true;
      st.pos = 0;
    }
  }

  function seekTo(fileSecs) {
    if (!st.loaded) return;
    st.pos = Math.max(0, fileSecs);
    st.posAt = performance.now();
    st.seeking = true;
    st.ended = false;
    fire("seeking");
    send(["seek", st.pos, "absolute+exact"]);
  }

  /** Pick the file's audio and caption tracks by their stream number in the file. */
  function pickTracks() {
    const L = st.loaded;
    if (!L) return;
    const byIndex = (type, i) => st.tracks.find((t) => t.type === type && t["ff-index"] === i);
    if (L.a != null) {
      const t = byIndex("audio", L.a);
      if (t) setProp("aid", t.id);
    }
    if (L.s != null) {
      const t = byIndex("sub", L.s);
      if (t) setProp("sid", t.id);
    } else setProp("sid", "no");
  }

  // ---------------------------------------------------------------- from mpv

  window.__dtvMpv = (msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.request_id && pending.has(msg.request_id)) {
      const p = pending.get(msg.request_id);
      pending.delete(msg.request_id);
      return msg.error === "success" ? p.resolve(msg.data) : p.reject(new Error(msg.error));
    }
    switch (msg.event) {
      case "property-change":
        return onProp(msg.name, msg.data);
      case "file-loaded":
        st.loading = false;
        st.readyState = 1;
        pickTracks();
        fire("durationchange");
        fire("loadedmetadata");
        st.readyState = 2;
        fire("loadeddata");
        return;
      case "seek":
        if (!st.seeking && st.loaded && !st.loading) {
          // A seek mpv started on its own (none today), so the page still hears of it.
          st.seeking = true;
          fire("seeking");
        }
        return;
      case "playback-restart":
        return restarted();
      case "end-file":
        if (msg.reason === "eof") {
          st.pos = filePos();
          st.paused = true;
          st.ended = true;
          st.loaded = null;
          fire("pause");
          fire("ended");
        } else if (msg.reason === "error") {
          st.loaded = null;
          st.loading = false;
          st.readyState = 0;
          st.error = { code: 4, message: msg.file_error || "mpv couldn't open this file" };
          fire("error");
        }
        return;
      case "shutdown":
        return;
    }
  };

  function restarted() {
    // The picture is up at a new spot: after a load or a seek.
    poll();
    st.posAt = performance.now();
    st.readyState = 4;
    st.waiting = false;
    if (!st.startedAt) st.startedAt = performance.now();
    if (st.seeking) {
      st.seeking = false;
      fire("seeked");
    }
    fire("canplay");
    fire("canplaythrough");
    if (!st.paused) fire("playing");
  }

  function onProp(name, v) {
    switch (name) {
      case "duration":
        st.duration = typeof v === "number" ? v : NaN;
        return fire("durationchange");
      case "paused-for-cache":
        if (v === true && !st.waiting && st.loaded && !st.paused) {
          st.pos = filePos();
          st.waiting = true;
          st.readyState = 2;
          fire("waiting");
        } else if (v === false && st.waiting) {
          st.waiting = false;
          st.posAt = performance.now();
          st.readyState = 4;
          if (!st.paused) fire("playing");
        }
        return;
      case "demuxer-cache-state":
        st.ranges = (v?.["seekable-ranges"] ?? []).map((r) => [r.start, r.end]).filter(([a, b]) => b > a);
        return fire("progress");
      case "video-params":
        if (v && (v.dw !== st.w || v.dh !== st.h)) {
          st.w = v.dw || v.w || 0;
          st.h = v.dh || v.h || 0;
          fire("resize");
        }
        return;
      case "track-list":
        st.tracks = Array.isArray(v) ? v : [];
        return;
      case "frame-drop-count":
        st.drops = Number(v) || 0;
        return;
      case "estimated-vf-fps":
        st.fps = Number(v) || st.fps;
        return;
      case "idle-active":
        if (v === true && st.loaded && !st.loading && !st.ended) {
          st.loaded = null;
          st.readyState = 0;
        }
        return;
    }
  }

  // Where the picture is, a few times a second: currentTime runs smoothly in between.
  let polling = false;
  function poll() {
    if (polling) return;
    polling = true;
    ask(["get_property", "time-pos"])
      .then((t) => {
        if (typeof t === "number" && !st.seeking) {
          st.pos = t;
          st.posAt = performance.now();
        }
      })
      .catch(() => {})
      .finally(() => (polling = false));
  }
  setInterval(() => {
    if (!st.loaded || st.loading) return;
    poll();
    if (!st.paused && !st.seeking) fire("timeupdate");
  }, 250);

  // ---------------------------------------------------------------- the picture's place

  // mpv fills the window; margins put the picture where the #video box is (the
  // guide's preview corner, a resized stage), so it lines up with the page.
  let lastBox = "";
  function placePicture() {
    const r = video.getBoundingClientRect();
    const W = window.innerWidth || 1;
    const H = window.innerHeight || 1;
    const visible = r.width > 1 && r.height > 1 && getComputedStyle(video).visibility !== "hidden";
    const m = visible
      ? [r.left / W, (W - r.right) / W, r.top / H, (H - r.bottom) / H].map((x) => Math.min(0.99, Math.max(0, x)))
      : [0, 0, 0, 0];
    const key = m.map((x) => x.toFixed(4)).join(",") + visible;
    if (key !== lastBox) {
      lastBox = key;
      setProp("video-margin-ratio-left", m[0]);
      setProp("video-margin-ratio-right", m[1]);
      setProp("video-margin-ratio-top", m[2]);
      setProp("video-margin-ratio-bottom", m[3]);
    }
    requestAnimationFrame(placePicture);
  }

  // ---------------------------------------------------------------- the window

  // Full screen means the whole app window, not just the page inside it.
  document.addEventListener("fullscreenchange", () => host.send(JSON.stringify({ dtv: "fullscreen", on: !!document.fullscreenElement })));

  // A reload starts clean: the page has forgotten what mpv was playing.
  send(["stop"]);
  OBSERVED.forEach((name, i) => send(["observe_property", 1000 + i, name]));
  setProp("volume", 100);
  requestAnimationFrame(placePicture);

  // For tests and support: what mpv is doing right now.
  window.__dtvNativeState = () => ({ ...st, tracks: st.tracks.length, currentTime: video.currentTime });
  window.__dtvMpvGet = (name) => ask(["get_property", name]);
}

function ranges(list) {
  return {
    length: list.length,
    start: (i) => {
      if (i < 0 || i >= list.length) throw new DOMException("Index out of range", "IndexSizeError");
      return list[i][0];
    },
    end: (i) => {
      if (i < 0 || i >= list.length) throw new DOMException("Index out of range", "IndexSizeError");
      return list[i][1];
    },
  };
}
