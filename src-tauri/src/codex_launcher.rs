//! A CODEX_PATH proxy: serve U's prepared catalog for the adapter's exact lookup;
//! forward other invocations with U's supported interactive capabilities.
use std::ffi::{OsStr, OsString};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

fn catalog_request(args: &[OsString], catalog: Option<OsString>) -> Option<PathBuf> {
    if args == [OsStr::new("debug"), OsStr::new("models")] { catalog.map(PathBuf::from) } else { None }
}

fn write_catalog(path: &Path, output: &mut impl Write) -> io::Result<()> {
    let mut file = std::fs::File::open(path)?;
    io::copy(&mut file, output)?;
    output.flush()
}

/// Fallback bearer for the loopback router. `providers.rs#ROUTER_TOKEN` is the source of truth and
/// is forwarded as `ALWITH_U_ROUTER_TOKEN`; this value only covers a runtime that predates it.
const DEFAULT_ROUTER_TOKEN: &str = "alwith-router";

fn escape_toml(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

/// The router *table*, not only the key that names it.
///
/// Codex resolves `model_provider` against `model_providers` while it boots. A key that names a
/// table the file does not contain makes it exit 1 with "Model provider `alwith` not found" —
/// that is the failure another Mac kept hitting, because `~/.codex/config.toml` is shared with
/// every other Codex client and can be rewritten behind our startup repair at any moment.
///
/// Measured against codex-cli 0.167.0 with throwaway `CODEX_HOME` directories:
///   `model_provider = "alwith"`, no table            -> exit 1, provider not found
///   same file + these overrides                      -> starts, banner reads `provider: alwith`
///   no key and no table + `model_provider` override  -> starts
/// So the engine no longer depends on that file at all. `base_url` is injected only once the
/// bridge has bound a port: without it Codex still boots (measured), which is strictly better
/// than refusing to start — the request then fails visibly instead of taking the ACP agent down.
/// The catalog argument for the engine's command line, when one was prepared for this launch.
///
/// Codex resolves a model's context window and its `auto_compact_token_limit` from the catalog it
/// reads while booting. Measured against 0.167.2 with a throwaway `CODEX_HOME` and a fake
/// upstream: the same catalog named by `model_catalog_json` in `config.toml` was honoured (a 1M
/// model reported 950000 = 1M × 95%), but passing it as the per-thread `config` value the ACP
/// adapter sends left the engine on its 272000 × 95% = 258400 default. The per-thread catalog
/// still fills the picker, so the two disagreed without looking wrong: the app showed a 1M-token
/// company model while the engine compacted at 245k. This is the channel that actually binds, and
/// it stays out of the shared `config.toml` the other Codex clients write to.
fn catalog_override(path: Option<&str>) -> Option<String> {
    let path = path?.trim();
    if path.is_empty() {
        return None;
    }
    Some(format!("model_catalog_json=\"{}\"", escape_toml(path)))
}

fn router_overrides(base: Option<&str>, token: Option<&str>) -> Vec<String> {
    let mut overrides =
        vec!["model_provider=\"alwith\"".to_string(), "model_providers.alwith.name=\"ALWith Router\"".to_string()];
    if let Some(base) = base {
        overrides.push(format!("model_providers.alwith.base_url=\"{}\"", escape_toml(base)));
    }
    overrides.push("model_providers.alwith.wire_api=\"responses\"".to_string());
    // The engine must not retry on its own: on `server_is_overloaded` it would honour the
    // backend's `retry-after` (about 300s) and sleep silently. The bridge owns the retry budget
    // and replays the request immediately without waiting, so keep this at zero.
    overrides.push("model_providers.alwith.request_max_retries=0".to_string());
    overrides.push("model_providers.alwith.stream_max_retries=0".to_string());
    // The engine's own per-chunk SSE idle timer defaults to ~300s. A healthy turn legitimately
    // sits silent far longer than that (measured: one 309s gap between tool results on
    // `gpt-6.1-sol` effort low; upstream `retry-after: 300` sleeps mid-turn), and with stream
    // retries off the engine turns that silence into
    // `stream disconnected before completion: idle timeout waiting for SSE` — the "model keeps
    // interrupting" reports of 2026-11-08 (three turns of 425s/444s/525s, all healthy shapes).
    // Align the engine with the app's one and only stream contract: 20 minutes of silence.
    overrides.push("model_providers.alwith.stream_idle_timeout_ms=1200000".to_string());
    overrides.push(format!(
        "model_providers.alwith.experimental_bearer_token=\"{}\"",
        escape_toml(token.unwrap_or(DEFAULT_ROUTER_TOKEN))
    ));
    overrides
}

#[cfg(not(test))]
fn main() {
    if let Err(error) = run() {
        eprintln!("alwith-codex-launcher: {error}");
        std::process::exit(1);
    }
}

#[cfg(not(test))]
fn run() -> io::Result<()> {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    if let Some(path) = catalog_request(&args, std::env::var_os("ALWITH_U_CODEX_CATALOG")) {
        return write_catalog(&path, &mut io::stdout().lock());
    }
    let binary = std::env::var_os("ALWITH_U_CODEX_PATH")
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::other("ALWITH_U_CODEX_PATH is missing"))?;
    if !binary.is_absolute() || std::fs::canonicalize(&binary)? == std::fs::canonicalize(std::env::current_exe()?)? {
        return Err(io::Error::other("ALWITH_U_CODEX_PATH must name the original Codex executable"));
    }
    let mut command = std::process::Command::new(binary);
    // Force U's shared router at process launch, and carry its definition with us.
    //
    // The old form injected only `model_provider="alwith"` and relied on `repair_router_provider`
    // to have written `[model_providers.alwith]` into the shared `~/.codex/config.toml`. That file
    // belongs to every Codex client on the machine: a desktop build, a CLI run, or a reconcile
    // pass can drop the table after the repair and before this engine boots, and Codex then exits
    // 1 with "Model provider `alwith` not found" before ACP can answer — so the repair that would
    // have fixed it can never run again. Injecting the table here removes that dependency.
    let base = std::env::var("ALWITH_U_ROUTER_BASE").ok().filter(|value| !value.trim().is_empty());
    let token = std::env::var("ALWITH_U_ROUTER_TOKEN").ok().filter(|value| !value.trim().is_empty());
    for override_value in router_overrides(base.as_deref(), token.as_deref()) {
        command.args(["-c", override_value.as_str()]);
    }
    if let Some(catalog) = catalog_override(std::env::var("ALWITH_U_MODEL_CATALOG").ok().as_deref()) {
        command.args(["-c", catalog.as_str()]);
    }
    // U renders ACP form elicitations in both collaboration modes. Enable Codex's
    // default-mode question tool for this process only, without editing user config.
    command.args(["--enable", "default_mode_request_user_input"]);
    // Suppress the experimental-feature banner only for U's Codex process.
    command.args(["-c", "suppress_unstable_features_warning=true"]);
    command.args(args);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Replace this process: stdin, stdout, stderr, signals and exit status stay native.
        Err(command.exec())
    }
    #[cfg(windows)]
    {
        windows_job::contain_current_process()?;
        let status = command.status()?;
        std::process::exit(status.code().unwrap_or(1));
    }
}

#[cfg(all(windows, not(test)))]
mod windows_job {
    use std::ffi::c_void;
    use std::io;
    type Handle = *mut c_void;
    #[repr(C)]
    #[derive(Default)]
    struct BasicLimits {
        process_time: i64,
        job_time: i64,
        flags: u32,
        min_working_set: usize,
        max_working_set: usize,
        active_processes: u32,
        affinity: usize,
        priority: u32,
        scheduling: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimits {
        basic: BasicLimits,
        io_counters: [u64; 6],
        process_memory: usize,
        job_memory: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }
    #[repr(C)]
    struct ProcessEntry {
        size: u32,
        usage: u32,
        pid: u32,
        heap: usize,
        module: u32,
        threads: u32,
        parent_pid: u32,
        priority: i32,
        flags: u32,
        executable: [u16; 260],
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: i32, info: *const c_void, size: u32) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn GetCurrentProcess() -> Handle;
        fn CloseHandle(handle: Handle) -> i32;
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> Handle;
        fn Process32FirstW(snapshot: Handle, entry: *mut ProcessEntry) -> i32;
        fn Process32NextW(snapshot: Handle, entry: *mut ProcessEntry) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
    }
    fn parent_handle() -> io::Result<Handle> {
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(2, 0); // TH32CS_SNAPPROCESS
            if snapshot == -1_isize as Handle {
                return Err(io::Error::last_os_error());
            }
            let mut entry: ProcessEntry = std::mem::zeroed();
            entry.size = size_of::<ProcessEntry>() as u32;
            let mut present = Process32FirstW(snapshot, &mut entry);
            let mut parent_pid = None;
            while present != 0 {
                if entry.pid == std::process::id() {
                    parent_pid = Some(entry.parent_pid);
                    break;
                }
                present = Process32NextW(snapshot, &mut entry);
            }
            CloseHandle(snapshot);
            let pid = parent_pid.ok_or_else(|| io::Error::other("Cannot identify the launcher parent process"))?;
            let parent = OpenProcess(0x0010_0000, 0, pid); // SYNCHRONIZE
            if parent.is_null() {
                return Err(io::Error::last_os_error());
            }
            Ok(parent)
        }
    }

    pub fn contain_current_process() -> io::Result<()> {
        // The handle is deliberately process-owned, not inherited. Windows closes it on exit,
        // killing descendants even if Runtime terminates the proxy before Codex exits.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(io::Error::last_os_error());
            }
            let mut limits = ExtendedLimits::default();
            limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if SetInformationJobObject(
                job,
                9,
                (&limits as *const ExtendedLimits).cast(),
                size_of::<ExtendedLimits>() as u32,
            ) == 0
                || AssignProcessToJobObject(job, GetCurrentProcess()) == 0
            {
                let error = io::Error::last_os_error();
                CloseHandle(job);
                return Err(error);
            }
        }
        // The adapter launches CODEX_PATH through cmd.exe and may terminate that shell.
        // Observe the shell handle so its death also closes our job, even if Codex ignores EOF.
        let parent = parent_handle()? as usize;
        std::thread::Builder::new().name("codex-parent-watch".into()).spawn(move || unsafe {
            let parent = parent as Handle;
            let result = WaitForSingleObject(parent, u32::MAX);
            let error = io::Error::last_os_error();
            CloseHandle(parent);
            if result != 0 {
                eprintln!("alwith-codex-launcher: parent wait failed: {error}");
            }
            std::process::exit(1);
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_the_exact_catalog_lookup_is_intercepted() {
        let path = OsString::from("/private cache/目录.json");
        let args = |values: &[&str]| values.iter().map(OsString::from).collect::<Vec<_>>();
        assert_eq!(catalog_request(&args(&["debug", "models"]), Some(path.clone())), Some(PathBuf::from(&path)));
        for values in [
            vec!["--version"],
            vec!["debug", "models", "--bundled"],
            vec!["-c", "model_catalog_json='a b'", "app-server"],
        ] {
            assert_eq!(catalog_request(&args(&values), Some(path.clone())), None);
        }
        assert_eq!(catalog_request(&args(&["debug", "models"]), None), None);
    }
    #[test]
    fn snapshot_bytes_and_read_errors_are_preserved() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("目录.json");
        let bytes = br#"{"models":[{"slug":"native"}]}"#;
        std::fs::write(&path, bytes).unwrap();
        let mut output = Vec::new();
        write_catalog(&path, &mut output).unwrap();
        assert_eq!(output, bytes);
        assert!(write_catalog(&directory.path().join("missing"), &mut output).is_err());
    }
    #[test]
    fn the_merged_catalog_rides_on_the_command_line_like_the_router_table() {
        // Codex only reads model info from a catalog it sees at boot; the per-thread one is
        // ignored. Quote the path so spaces survive TOML parsing.
        assert_eq!(
            catalog_override(Some("/Users/x/Library/Application Support/ai.alwith.u/model-catalogs/merged.json")),
            Some(
                "model_catalog_json=\"/Users/x/Library/Application Support/ai.alwith.u/model-catalogs/merged.json\""
                    .into()
            )
        );
        assert_eq!(catalog_override(Some("  ")), None);
        assert_eq!(catalog_override(None), None);
    }
    #[test]
    fn router_overrides_define_the_table_not_only_the_key_that_names_it() {
        // A `model_provider` key without its table is precisely the state that makes Codex exit 1
        // before ACP answers. Every key the block needs must ride on the command line.
        let values = router_overrides(Some("http://127.0.0.1:60639/alwith"), Some("alwith-router"));
        assert_eq!(values[0], "model_provider=\"alwith\"");
        for expected in [
            "model_providers.alwith.name=\"ALWith Router\"",
            "model_providers.alwith.base_url=\"http://127.0.0.1:60639/alwith\"",
            "model_providers.alwith.wire_api=\"responses\"",
            "model_providers.alwith.request_max_retries=0",
            "model_providers.alwith.stream_max_retries=0",
            // The engine's default SSE idle cut (~300s) is shorter than a healthy turn's silent
            // gaps; the launcher must carry the same 20-minute contract as bridge and UI.
            "model_providers.alwith.stream_idle_timeout_ms=1200000",
            "model_providers.alwith.experimental_bearer_token=\"alwith-router\"",
        ] {
            assert!(values.iter().any(|value| value == expected), "missing {expected} in {values:?}");
        }
        // The value half is TOML: `0` must stay a bare integer, not a quoted string.
        assert!(!values.iter().any(|value| value.contains("request_max_retries=\"0\"")));
    }
    #[test]
    fn router_overrides_omit_base_url_when_the_bridge_has_no_port_yet() {
        // Codex starts without `base_url` (measured), so a slow bridge must not turn into a
        // provider-not-found failure. The request fails later, visibly, instead.
        assert_eq!(DEFAULT_ROUTER_TOKEN, "alwith-router");
        let values = router_overrides(None, None);
        assert!(values.iter().all(|value| !value.contains("base_url")), "{values:?}");
        assert!(values.iter().any(|value| value.ends_with(&format!("=\"{DEFAULT_ROUTER_TOKEN}\""))));
    }
    #[test]
    fn router_overrides_escape_quotes_so_one_bad_value_cannot_inject_keys() {
        let values = router_overrides(Some("http://127.0.0.1:1/alwith\""), Some("a\"b"));
        let base = values.iter().find(|value| value.contains("base_url")).unwrap();
        assert!(base.ends_with("\\\"\""), "{base}");
        let token = values.iter().find(|value| value.contains("bearer_token")).unwrap();
        assert!(token.contains("a\\\"b"), "{token}");
    }

    #[test]
    fn router_overrides_never_let_the_engine_sleep_on_retry_after() {
        let values = router_overrides(None, None);
        // Replaying an overloaded request without waiting is the bridge's job. If the engine
        // retries too, it honours `retry-after` and the reader waits about five minutes per try.
        assert!(values.iter().any(|v| v == "model_providers.alwith.request_max_retries=0"));
        assert!(values.iter().any(|v| v == "model_providers.alwith.stream_max_retries=0"));
        assert!(values.iter().any(|v| v == "model_providers.alwith.stream_idle_timeout_ms=1200000"));
    }
}
