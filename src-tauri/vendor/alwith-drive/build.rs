const COMMANDS: &[&str] = &["request", "session_request", "collaborative_write"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
