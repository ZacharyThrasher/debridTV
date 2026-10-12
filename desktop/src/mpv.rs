//! mpv as a child process, drawing into our picture window (`--wid`) and taking
//! commands over its JSON IPC pipe. A separate process keeps a player crash from
//! taking the window down, and keeps mpv (GPL) a separate program we run, not code
//! we link.

use crate::app::UserEvent;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command};
use std::time::Duration;
use tao::event_loop::EventLoopProxy;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::ClientOptions;
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct Mpv {
    child: Child,
    tx: UnboundedSender<String>,
}

impl Mpv {
    pub fn start(exe: &Path, wid: isize, data: Option<&Path>, proxy: EventLoopProxy<UserEvent>) -> Result<Mpv, String> {
        let pipe = format!(r"\\.\pipe\debridtv-mpv-{}", std::process::id());
        let mut cmd = Command::new(exe);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.arg(format!("--wid={wid}"))
            .arg(format!("--input-ipc-server={pipe}"))
            // Idle in a black window until the page asks for something.
            .args(["--idle=yes", "--force-window=yes", "--keep-open=no", "--background-color=#000000"])
            // The page is the only interface: no mpv keys, mouse, on-screen controls or scripts.
            .args(["--osc=no", "--osd-level=0", "--input-default-bindings=no", "--input-vo-keyboard=no", "--input-cursor=no", "--cursor-autohide=no"])
            .args(["--load-scripts=no", "--ytdl=no", "--sub-auto=no", "--audio-file-auto=no", "--resume-playback=no", "--save-position-on-quit=no"])
            // Best picture the GPU can do, hardware decoding where it's safe.
            .args(["--vo=gpu-next,gpu,", "--gpu-context=d3d11", "--hwdec=auto-safe"])
            // Read ahead in memory, and ride out short provider hiccups.
            .args(["--cache=yes", "--demuxer-max-bytes=128MiB", "--demuxer-max-back-bytes=64MiB"])
            .arg("--stream-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_on_network_error=1,reconnect_delay_max=15")
            .args(["--audio-client-name=DebridTV", "--title=DebridTV", "--msg-level=all=warn"]);
        match data {
            // The viewer's own mpv.conf, if they want one, lives next to the window's data.
            Some(d) => {
                let dir = d.join("mpv");
                let _ = std::fs::create_dir_all(&dir);
                cmd.arg(format!("--config-dir={}", dir.display()));
                cmd.arg(format!("--log-file={}", d.join("mpv.log").display()));
            }
            None => {
                cmd.arg("--no-config");
            }
        }
        // Extra mpv options for tests and support, e.g. "--audio-spdif=ac3,dts" for a receiver.
        if let Ok(extra) = std::env::var("DEBRIDTV_MPV_ARGS") {
            cmd.args(extra.split_whitespace());
        }
        let child = cmd.spawn().map_err(|e| format!("{}: {e}", exe.display()))?;
        kill_with_us(&child);

        let (tx, mut rx) = unbounded_channel::<String>();
        std::thread::spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                Ok(rt) => rt,
                Err(_) => return,
            };
            rt.block_on(async move {
                // mpv opens the pipe a moment after it starts.
                let mut client = None;
                for _ in 0..100 {
                    match ClientOptions::new().open(&pipe) {
                        Ok(c) => {
                            client = Some(c);
                            break;
                        }
                        Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
                    }
                }
                let Some(client) = client else {
                    let _ = proxy.send_event(UserEvent::MpvGone);
                    return;
                };
                let (read, mut write) = tokio::io::split(client);
                let writer = tokio::spawn(async move {
                    while let Some(line) = rx.recv().await {
                        // One command per line; a stray newline would split it in two.
                        let line = line.replace(['\n', '\r'], " ");
                        if write.write_all(format!("{line}\n").as_bytes()).await.is_err() {
                            break;
                        }
                    }
                });
                let mut lines = BufReader::new(read).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if proxy.send_event(UserEvent::FromMpv(line)).is_err() {
                        break;
                    }
                }
                writer.abort();
                let _ = proxy.send_event(UserEvent::MpvGone);
            });
        });
        Ok(Mpv { child, tx })
    }

    /// Where the page's commands go.
    pub fn sender(&self) -> UnboundedSender<String> {
        self.tx.clone()
    }

    pub fn quit(mut self) {
        let _ = self.tx.send("{\"command\":[\"quit\"]}".into());
        for _ in 0..20 {
            if let Ok(Some(_)) = self.child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = self.child.kill();
    }
}

/// mpv ends when the window ends, even if the window is killed: a job object that
/// closes with this process takes mpv with it.
fn kill_with_us(child: &Child) {
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        AssignProcessToJobObject(job, child.as_raw_handle() as _);
        // The handle stays open for the life of this process on purpose.
    }
}
