#[cfg(target_os = "macos")]
#[test]
fn login_registration_requires_an_app_bundle_executable() {
    use std::path::Path;
    assert!(super::is_app_executable(Path::new("/Applications/ALWith U⁺.app/Contents/MacOS/alwith-u")));
    for path in [
        "/project/src-tauri/target/debug/alwith-u",
        "/project/src-tauri/target/release/alwith-u",
        "/project.app/src-tauri/target/debug/alwith-u",
        "/Applications/ALWith U⁺.app/alwith-u",
    ] {
        assert!(!super::is_app_executable(Path::new(path)), "{path}");
    }
}
