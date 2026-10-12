//! DebridTV's app window on Windows.
//!
//! One window, two layers: mpv draws the picture in a native child window at the
//! bottom, and the DebridTV page sits on top of it in WebView2 with a see-through
//! background. The page drives mpv through `native-video.js`, which stands in for
//! the `<video>` element; this program only relays mpv's JSON IPC between the two
//! and keeps the window, the picture and full screen in step.
//!
//! The DebridTV server (DebridTV.exe) starts this window and passes:
//!
//!   debridtv-window.exe --url http://127.0.0.1:7337/ [--mpv C:\...\mpv.exe]
//!                       [--data %LOCALAPPDATA%\DebridTV\webview] [--trace file] [--no-dialog]
//!
//! Without `--mpv` (or when mpv won't start) the page plays video itself, exactly
//! as in a browser, so the window is still useful.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(not(windows))]
fn main() {
    eprintln!("debridtv-window runs on Windows only.");
    std::process::exit(1);
}

#[cfg(windows)]
fn main() {
    if let Err(e) = app::run() {
        // Started by DebridTV.exe, which has other ways to open the guide: just say no.
        if !std::env::args().any(|a| a == "--no-dialog") {
            app::fatal(&e);
        }
        std::process::exit(3);
    }
}

#[cfg(windows)]
mod mpv;

#[cfg(windows)]
mod app {
    use crate::mpv::Mpv;
    use std::fs::OpenOptions;
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};
    use tao::dpi::{LogicalSize, PhysicalPosition, PhysicalSize};
    use tao::event::{Event, StartCause, WindowEvent};
    use tao::event_loop::{ControlFlow, EventLoopBuilder};
    use tao::platform::windows::WindowExtWindows;
    use tao::window::{Fullscreen, Icon, WindowBuilder};
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, MessageBoxW, MoveWindow, MB_ICONERROR, MB_OK, WS_CHILD,
        WS_CLIPSIBLINGS, WS_DISABLED, WS_VISIBLE,
    };
    /// A STATIC control that paints itself black.
    const SS_BLACKRECT: u32 = 0x4;
    use wry::{Rect, WebContext, WebViewBuilder, WebViewBuilderExtWindows};

    pub enum UserEvent {
        /// One line of JSON from mpv: a reply or an event.
        FromMpv(String),
        /// mpv quit or crashed.
        MpvGone,
        /// The page went in or out of full screen.
        Fullscreen(bool),
    }

    struct Args {
        url: String,
        mpv: Option<PathBuf>,
        data: Option<PathBuf>,
        trace: Option<PathBuf>,
    }

    fn args() -> Result<Args, String> {
        let mut a = Args { url: String::new(), mpv: None, data: None, trace: None };
        let mut it = std::env::args().skip(1);
        while let Some(k) = it.next() {
            let mut v = || it.next().ok_or_else(|| format!("{k} needs a value"));
            match k.as_str() {
                "--url" => a.url = v()?,
                "--mpv" => a.mpv = Some(PathBuf::from(v()?)),
                "--data" => a.data = Some(PathBuf::from(v()?)),
                "--trace" => a.trace = Some(PathBuf::from(v()?)),
                "--no-dialog" => {}
                _ => return Err(format!("unknown option {k}")),
            }
        }
        // Only DebridTV's own server on this PC: the page gets control of a player.
        let local = ["http://127.0.0.1:", "http://localhost:"].iter().any(|p| a.url.starts_with(p));
        if !local {
            return Err("--url must be DebridTV on this PC (http://127.0.0.1:port/)".into());
        }
        Ok(a)
    }

    pub fn fatal(msg: &str) {
        let text: Vec<u16> = format!("DebridTV couldn't open its window: {msg}\0").encode_utf16().collect();
        let title: Vec<u16> = "DebridTV\0".encode_utf16().collect();
        unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR) };
    }

    /// Lines for `--trace`: what went to and came from mpv, for tests and support.
    type Trace = Option<Arc<Mutex<std::fs::File>>>;
    fn trace(t: &Trace, dir: &str, line: &str) {
        if let Some(f) = t {
            if let Ok(mut f) = f.lock() {
                let _ = writeln!(f, "{dir} {line}");
            }
        }
    }

    pub fn run() -> Result<(), String> {
        let args = args()?;
        let tr: Trace = match &args.trace {
            Some(p) => Some(Arc::new(Mutex::new(OpenOptions::new().create(true).append(true).open(p).map_err(|e| e.to_string())?))),
            None => None,
        };

        let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
        let window = WindowBuilder::new()
            .with_title("DebridTV")
            .with_inner_size(LogicalSize::new(1280.0, 760.0))
            .with_min_inner_size(LogicalSize::new(480.0, 300.0))
            .with_window_icon(icon())
            .build(&event_loop)
            .map_err(|e| e.to_string())?;
        let parent = window.hwnd() as HWND;
        let size = window.inner_size();

        // The picture's layer: a plain black child window at the bottom. mpv draws
        // inside it; the page (created next, so above it) shows it where it's clear.
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let picture = unsafe {
            CreateWindowExW(
                0,
                class.as_ptr(),
                std::ptr::null(),
                WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_DISABLED | SS_BLACKRECT,
                0,
                0,
                size.width as i32,
                size.height as i32,
                parent,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        if picture.is_null() {
            return Err("couldn't create the picture layer".into());
        }

        let proxy = event_loop.create_proxy();
        let mpv = match &args.mpv {
            Some(exe) => match Mpv::start(exe, picture as isize, args.data.as_deref(), proxy.clone()) {
                Ok(m) => Some(m),
                Err(e) => {
                    // Still a working window: the page plays video itself.
                    trace(&tr, "!", &format!("mpv didn't start: {e}"));
                    None
                }
            },
            None => None,
        };

        let mut context = WebContext::new(args.data.clone());
        let to_mpv = mpv.as_ref().map(|m| m.sender());
        let ipc_trace = tr.clone();
        let fs_proxy = proxy.clone();
        let mut builder = WebViewBuilder::new_with_web_context(&mut context)
            .with_url(&args.url)
            .with_transparent(true)
            .with_autoplay(true)
            .with_devtools(cfg!(debug_assertions))
            .with_additional_browser_args("--autoplay-policy=no-user-gesture-required --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection")
            .with_ipc_handler(move |req| {
                let body = req.body();
                if body.starts_with("{\"dtv\"") {
                    // A request for the window itself.
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
                        if v["dtv"] == "fullscreen" {
                            let _ = fs_proxy.send_event(UserEvent::Fullscreen(v["on"].as_bool().unwrap_or(false)));
                        }
                    }
                    return;
                }
                trace(&ipc_trace, ">", body);
                if let Some(tx) = &to_mpv {
                    let _ = tx.send(body.to_string());
                }
            });
        if mpv.is_some() {
            builder = builder.with_initialization_script(
                "window.__DTV_NATIVE = Object.freeze({ send: (s) => window.ipc.postMessage(String(s)) });",
            );
        }
        let webview = builder.build(&window).map_err(|e| e.to_string())?;
        let _ = webview.focus();

        let mut mpv = mpv;
        event_loop.run(move |event, _, flow| {
            *flow = ControlFlow::Wait;
            match event {
                Event::NewEvents(StartCause::Init) => {}
                Event::WindowEvent { event: WindowEvent::Resized(PhysicalSize { width, height }), .. } => {
                    unsafe { MoveWindow(picture, 0, 0, width as i32, height as i32, 1) };
                    let _ = webview.set_bounds(Rect {
                        position: PhysicalPosition::new(0, 0).into(),
                        size: PhysicalSize::new(width, height).into(),
                    });
                }
                Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                    if let Some(m) = mpv.take() {
                        m.quit();
                    }
                    *flow = ControlFlow::Exit;
                }
                Event::UserEvent(UserEvent::FromMpv(line)) => {
                    trace(&tr, "<", &line);
                    // mpv's JSON is a valid JavaScript expression; it goes in as data.
                    let _ = webview.evaluate_script(&format!("window.__dtvMpv && window.__dtvMpv({line})"));
                }
                Event::UserEvent(UserEvent::Fullscreen(on)) => {
                    window.set_fullscreen(if on { Some(Fullscreen::Borderless(None)) } else { None });
                }
                Event::UserEvent(UserEvent::MpvGone) => {
                    trace(&tr, "!", "mpv stopped");
                    let _ = webview.evaluate_script(
                        "window.__dtvMpv && window.__dtvMpv({event:'end-file',reason:'error',file_error:'the player stopped'})",
                    );
                }
                _ => {}
            }
        });
    }

    /// The DebridTV mark for the title bar and taskbar: a white "TV" tile on black.
    fn icon() -> Option<Icon> {
        const N: u32 = 64;
        let mut px = vec![0u8; (N * N * 4) as usize];
        for y in 0..N {
            for x in 0..N {
                let i = ((y * N + x) * 4) as usize;
                // Black tile with a 2 px radius look, a red tally dot, a white screen.
                let screen = (10..54).contains(&x) && (14..46).contains(&y);
                let inner = (14..50).contains(&x) && (18..42).contains(&y);
                let dot = (x as i32 - 48).pow(2) + (y as i32 - 52).pow(2) <= 9;
                let (r, g, b) = if dot { (0xf0, 0x40, 0x2f) } else if screen && !inner { (0xff, 0xff, 0xff) } else { (0x0b, 0x0c, 0x0d) };
                px[i..i + 4].copy_from_slice(&[r, g, b, 0xff]);
            }
        }
        Icon::from_rgba(px, N, N).ok()
    }
}
