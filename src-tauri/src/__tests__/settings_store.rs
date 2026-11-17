use super::*;
use serde_json::json;
fn changes(value: Value) -> BTreeMap<String, Value> {
    serde_json::from_value(value).unwrap()
}
#[test]
fn migrates_preferences_and_voice_once_without_resurrecting_keys() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("preferences.json"), r#"{"language":"zh-CN","zoomLevel":1.2}"#).unwrap();
    std::fs::write(
        dir.path().join("voice-settings.json"),
        r#"{"enabled":false,"settings":{"provider":"doubao","doubaoResourceId":""}}"#,
    )
    .unwrap();
    std::fs::write(dir.path().join("voice-credentials.json"), r#"{"doubao":"test-secret"}"#).unwrap();
    let mut store = SettingsStore::load(dir.path().into()).unwrap();
    assert_eq!(store.values["general.language"], json!("zh-CN"));
    assert_eq!(store.values["voice.enabled"], false);
    assert_eq!(store.values["voice.doubao.resourceId"], "volc.seedasr.sauc.duration");
    assert_eq!(store.secret("voice.doubao.apiKey").unwrap().as_deref(), Some("test-secret"));
    store.remove_secret("voice.doubao.apiKey").unwrap();
    let restarted = SettingsStore::load(dir.path().into()).unwrap();
    assert_eq!(restarted.secret("voice.doubao.apiKey").unwrap(), None);
    assert!(!std::fs::read_to_string(dir.path().join("settings.json")).unwrap().contains("test-secret"));
}
#[test]
fn ordinary_updates_reject_secrets_unknown_keys_and_stale_forms() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = SettingsStore::load(dir.path().into()).unwrap();
    assert!(s.update(changes(json!({"voice.doubao.apiKey":"secret"})), None).is_err());
    assert!(s.update(changes(json!({"unknown.option":true})), None).is_err());
    let revision = s.snapshot().unwrap().0;
    s.update(changes(json!({"voice.enabled":false})), None).unwrap();
    assert!(s.update(changes(json!({"voice.provider":"vui"})), Some(revision)).is_err());
    assert_eq!(s.values["voice.enabled"], false);
}
#[test]
fn fixed_four_and_screen_capture_keys_are_accepted() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = SettingsStore::load(dir.path().into()).unwrap();
    s.update(
        changes(json!({
            "appearance.fixedFour": true,
            "computer.screenCaptureRequested": true
        })),
        None,
    )
    .unwrap();
    assert_eq!(s.values["appearance.fixedFour"], true);
    assert_eq!(s.values["computer.screenCaptureRequested"], true);
}
#[test]
fn four_columns_default_is_a_registered_boolean_setting() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = SettingsStore::load(dir.path().into()).unwrap();
    // The Appearance pane writes this key through `updateSettings`. Before it was registered,
    // validate() answered "Unknown or private settings key" and the switch silently did nothing.
    s.update(changes(json!({"appearance.fourColumnsDefault": false})), None)
        .unwrap();
    assert_eq!(s.values["appearance.fourColumnsDefault"], false);
    let (known, private) = partition_settings(s.values.clone());
    assert_eq!(known["appearance.fourColumnsDefault"], false);
    assert!(!private.contains_key("appearance.fourColumnsDefault"));
    assert!(s
        .update(changes(json!({"appearance.fourColumnsDefault": "no"})), None)
        .is_err());
    let restarted = SettingsStore::load(dir.path().into()).unwrap();
    assert_eq!(restarted.values["appearance.fourColumnsDefault"], false);
}
#[test]
fn workspace_column_visibility_is_a_persisted_boolean() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = SettingsStore::load(dir.path().into()).unwrap();
    s.update(changes(json!({"workspace.treeVisible": false})), None).unwrap();
    assert_eq!(s.values["workspace.treeVisible"], false);
    // A closed file column survives the next launch.
    let restarted = SettingsStore::load(dir.path().into()).unwrap();
    assert_eq!(restarted.values["workspace.treeVisible"], false);
    assert!(s.update(changes(json!({"workspace.treeVisible": "no"})), None).is_err());
}

#[test]
fn appearance_column_switches_are_registered_and_projected() {
    // The Appearance pane writes these two keys. When they were missing from the registry the
    // client rejected the write ("这个设置项未被识别") and, because partition_settings dropped
    // them, the live layout preview never received a new value and stayed on its defaults.
    let dir = tempfile::tempdir().unwrap();
    let mut s = SettingsStore::load(dir.path().into()).unwrap();
    s.update(
        changes(json!({
            "workspace.previewVisible": false,
            "workspace.sidebarAutoCollapse": true
        })),
        None,
    )
    .unwrap();
    assert_eq!(s.values["workspace.previewVisible"], false);
    assert_eq!(s.values["workspace.sidebarAutoCollapse"], true);
    let (known, private) = partition_settings(s.values.clone());
    assert_eq!(known["workspace.previewVisible"], false);
    assert_eq!(known["workspace.sidebarAutoCollapse"], true);
    assert!(!private.contains_key("workspace.previewVisible"));
    assert!(!private.contains_key("workspace.sidebarAutoCollapse"));
    // Both survive a restart, and neither accepts a non-boolean value.
    let restarted = SettingsStore::load(dir.path().into()).unwrap();
    assert_eq!(restarted.values["workspace.previewVisible"], false);
    assert_eq!(restarted.values["workspace.sidebarAutoCollapse"], true);
    assert!(s.update(changes(json!({"workspace.previewVisible": "off"})), None).is_err());
    assert!(s.update(changes(json!({"workspace.sidebarAutoCollapse": 1})), None).is_err());
}
#[test]
fn local_profile_overrides_are_accepted_within_their_bounds() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = SettingsStore::load(dir.path().into()).unwrap();
    s.update(
        changes(json!({
            "profile.nickname": "小哥哥",
            "profile.owner": "6f1c2a34-0000-4000-8000-000000000000",
            "profile.avatar": "data:image/jpeg;base64,AAAA"
        })),
        None,
    )
    .unwrap();
    assert_eq!(s.values["profile.nickname"], "小哥哥");
    assert_eq!(s.values["profile.avatar"], "data:image/jpeg;base64,AAAA");
    // The picker never writes these shapes, so the store refuses them.
    assert!(s.update(changes(json!({"profile.nickname": "x".repeat(65)})), None).is_err());
    assert!(s.update(changes(json!({"profile.avatar": "https://cdn.example/leo.png"})), None).is_err());
    // Dropping the override is always allowed; a null value removes the key.
    s.update(changes(json!({"profile.avatar": null})), None).unwrap();
    assert!(!s.values.contains_key("profile.avatar"));
}
#[test]
fn voice_configuration_and_secret_survive_restart_together() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = SettingsStore::load(dir.path().into()).unwrap();
    s.save_voice(
        changes(json!({"voice.provider":"doubao"})),
        Some(("voice.doubao.apiKey".into(), "test-key".into())),
        s.snapshot().unwrap().0,
        || Ok(()),
    )
    .unwrap();
    let restarted = SettingsStore::load(dir.path().into()).unwrap();
    assert_eq!(restarted.values["voice.provider"], "doubao");
    assert_eq!(restarted.secret("voice.doubao.apiKey").unwrap().as_deref(), Some("test-key"));
}

#[test]
fn failed_write_keeps_active_settings_and_old_file() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = SettingsStore::load(dir.path().into()).unwrap();
    s.update(changes(json!({"voice.enabled":false})), None).unwrap();
    let old = std::fs::read(dir.path().join("settings.json")).unwrap();
    s.root = dir.path().join("blocked");
    std::fs::write(&s.root, "file").unwrap();
    assert!(s.update(changes(json!({"voice.enabled":true})), None).is_err());
    assert_eq!(s.values["voice.enabled"], false);
    assert_eq!(std::fs::read(dir.path().join("settings.json")).unwrap(), old);
}
#[test]
fn durable_commit_recovers_after_interruption_without_exposing_keys() {
    let dir = tempfile::tempdir().unwrap();
    let s = SettingsStore::load(dir.path().into()).unwrap();
    let tx = Transaction {
        settings: s.document(&changes(json!({"voice.provider":"doubao"})), 1, false),
        credentials: BTreeMap::from([("voice.doubao.apiKey".into(), "pending-key".into())]),
    };
    write_json(&dir.path().join(".settings-transaction.json"), &tx).unwrap();
    let restarted = SettingsStore::load(dir.path().into()).unwrap();
    assert_eq!(restarted.secret("voice.doubao.apiKey").unwrap().as_deref(), Some("pending-key"));
    assert_eq!(restarted.values["voice.provider"], "doubao");
    assert!(!dir.path().join(".settings-transaction.json").exists());
    assert!(!serde_json::to_string(&restarted.snapshot().unwrap()).unwrap().contains("pending-key"));
}
#[test]
fn partial_commit_blocks_reads_until_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = SettingsStore::load(dir.path().into()).unwrap();
    // A directory cannot be replaced by a settings file; credentials are already committed.
    std::fs::remove_file(dir.path().join("settings.json")).unwrap();
    std::fs::create_dir(dir.path().join("settings.json")).unwrap();
    assert!(
        s.save_voice(
            changes(json!({"voice.provider":"doubao"})),
            Some(("voice.doubao.apiKey".into(), "pending".into())),
            s.snapshot().unwrap().0,
            || Ok(())
        )
        .is_err()
    );
    assert!(s.snapshot().is_err());
    assert!(s.secret("voice.doubao.apiKey").is_err());
    assert!(s.update(changes(json!({"voice.enabled":false})), None).is_err());
    std::fs::remove_dir(dir.path().join("settings.json")).unwrap();
    let restarted = SettingsStore::load(dir.path().into()).unwrap();
    assert_eq!(restarted.values["voice.provider"], "doubao");
    assert_eq!(restarted.secret("voice.doubao.apiKey").unwrap().as_deref(), Some("pending"));
}
#[test]
fn browser_migration_is_one_time_and_does_not_overwrite_native_settings() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = SettingsStore::load(dir.path().into()).unwrap();
    s.update(changes(json!({"appearance.theme":"dark"})), None).unwrap();
    s.import_browser(changes(json!({"appearance.theme":"light","editor.fontSize":18}))).unwrap();
    assert_eq!(s.values["appearance.theme"], "dark");
    assert_eq!(s.values["editor.fontSize"], 18);
    s.update(changes(json!({"editor.fontSize":null})), None).unwrap();
    let mut restarted = SettingsStore::load(dir.path().into()).unwrap();
    restarted.import_browser(changes(json!({"editor.fontSize":18}))).unwrap();
    assert!(!restarted.values.contains_key("editor.fontSize"));
}
#[test]
fn corrupt_settings_are_not_overwritten_and_parse_errors_do_not_echo_values() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    std::fs::write(&path, "\"private-input\"").unwrap();
    let error = SettingsStore::load(dir.path().into()).err().unwrap();
    assert!(!error.contains("private-input"));
    assert_eq!(std::fs::read_to_string(path).unwrap(), "\"private-input\"");
}
#[test]
fn validates_voice_modes_and_silence_limits_at_the_native_boundary() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = SettingsStore::load(dir.path().into()).unwrap();
    for mode in ["dictation", "send", "handsfree"] {
        s.update(changes(json!({"voice.inputMode":mode})), None).unwrap();
    }
    for mode in ["none", "scale", "auto"] {
        s.update(changes(json!({"chat.navigationSoundMode":mode})), None).unwrap();
    }
    assert!(s.update(changes(json!({"voice.doubao.resourceId":"invalid resource"})), None).is_err());
    assert!(
        s.update(
            changes(
                json!({"voice.silence":{"threshold":0,"silenceMs":1400,"initialSilenceMs":10000,"maxDurationMs":60000}})
            ),
            None
        )
        .is_err()
    );
    s.update(changes(json!({"voice.silence":{"threshold":0.015,"silenceMs":1400,"initialSilenceMs":10000,"maxDurationMs":60000}})),None).unwrap();
}
#[test]
fn rejected_voice_saves_do_not_cancel_recording() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = SettingsStore::load(dir.path().into()).unwrap();
    let old = store.snapshot().unwrap().0;
    store.update(changes(json!({"voice.enabled":false})), None).unwrap();
    let mut cancelled = false;
    assert!(
        store
            .save_voice(
                changes(json!({"voice.provider":"doubao"})),
                Some(("voice.doubao.apiKey".into(), "test-key".into())),
                old,
                || {
                    cancelled = true;
                    Ok(())
                }
            )
            .is_err()
    );
    assert!(!cancelled);
    assert!(
        store
            .save_voice(changes(json!({"voice.provider":"invalid"})), None, store.snapshot().unwrap().0, || {
                cancelled = true;
                Ok(())
            })
            .is_err()
    );
    assert!(!cancelled);
    assert_eq!(store.secret("voice.doubao.apiKey").unwrap(), None);
}

#[test]
fn computer_preference_survives_restart_and_rejects_non_boolean_values() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = SettingsStore::load(dir.path().into()).unwrap();
    assert!(!store.values.contains_key("computer.enabled"));
    for enabled in [true, false] {
        store.update(changes(json!({"computer.enabled": enabled})), None).unwrap();
        store = SettingsStore::load(dir.path().into()).unwrap();
        assert_eq!(store.values["computer.enabled"], enabled);
    }
    assert!(store.update(changes(json!({"computer.enabled": "true"})), None).is_err());
}

#[test]
fn collections_persist_references_and_reject_invalid_memberships() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = SettingsStore::load(dir.path().into()).unwrap();
    let data = json!({"collections": {
        "collection-default": {"id":"collection-default","name":"","collapsed":false,"sessionIds":["one"]},
        "work": {"id":"work","name":"Work","collapsed":true,"emoji":"📦","sessionIds":["two"]}
    }, "order":["collection-default","work"]});
    store.update(changes(json!({"collections.data":data})), None).unwrap();
    let restarted = SettingsStore::load(dir.path().into()).unwrap();
    assert_eq!(restarted.values["collections.data"], data);
    let mut duplicate = data.clone();
    duplicate["collections"]["work"]["sessionIds"] = json!(["one"]);
    assert!(store.update(changes(json!({"collections.data":duplicate})), None).is_err());
    let mut metadata = data.clone();
    metadata["sessionMeta"] = json!({"one":{"title":"Second store"}});
    assert!(store.update(changes(json!({"collections.data":metadata})), None).is_err());
    let mut order = data.clone();
    order["order"] = json!(["work", "collection-default"]);
    assert!(store.update(changes(json!({"collections.data":order})), None).is_err());
    assert_eq!(store.values["collections.data"], data);
}

#[test]
fn migrates_retired_trackpad_preference_without_overwriting_current_choice() {
    for (legacy, current, expected) in [(true, None, true), (false, None, false), (true, Some(false), false)] {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::load(dir.path().into()).unwrap();
        let mut values = changes(json!({"trackpad.enabled": legacy, "appearance.theme": "dark"}));
        if let Some(current) = current {
            values.insert("appearance.threeFingerSwipe".into(), json!(current));
        }
        write_json(&dir.path().join("settings.json"), &store.document(&values, 7, true)).unwrap();
        let mut migrated = SettingsStore::load(dir.path().into()).unwrap();
        assert_eq!(migrated.values["appearance.threeFingerSwipe"], expected);
        assert_eq!(migrated.values["appearance.theme"], "dark");
        assert_eq!(migrated.snapshot().unwrap().0, 7);
        assert!(migrated.browser_migrated());
        assert!(!migrated.values.contains_key("trackpad.enabled"));
        assert!(migrated.update(changes(json!({"trackpad.enabled": true})), None).is_err());
        let persisted = read_json::<BTreeMap<String, Value>>(&dir.path().join("settings.json")).unwrap().unwrap();
        assert!(!persisted.contains_key("trackpad.enabled"));
        let restarted = SettingsStore::load(dir.path().into()).unwrap();
        assert_eq!(restarted.values, migrated.values);
    }
}

#[test]
fn recovers_transaction_with_retired_trackpad_preference() {
    let dir = tempfile::tempdir().unwrap();
    let store = SettingsStore::load(dir.path().into()).unwrap();
    let tx = Transaction {
        settings: store.document(&changes(json!({"trackpad.enabled": false})), 4, true),
        credentials: BTreeMap::from([("voice.doubao.apiKey".into(), "pending-key".into())]),
    };
    write_json(&dir.path().join(".settings-transaction.json"), &tx).unwrap();
    let recovered = SettingsStore::load(dir.path().into()).unwrap();
    assert_eq!(recovered.values["appearance.threeFingerSwipe"], false);
    assert!(!recovered.values.contains_key("trackpad.enabled"));
    assert_eq!(recovered.secret("voice.doubao.apiKey").unwrap().as_deref(), Some("pending-key"));
    assert!(!dir.path().join(".settings-transaction.json").exists());
}

#[test]
fn invalid_retired_trackpad_preference_leaves_storage_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let store = SettingsStore::load(dir.path().into()).unwrap();
    let path = dir.path().join("settings.json");
    write_json(&path, &store.document(&changes(json!({"trackpad.enabled": "invalid"})), 1, true)).unwrap();
    let original = std::fs::read(&path).unwrap();
    assert!(SettingsStore::load(dir.path().into()).is_err());
    assert_eq!(std::fs::read(path).unwrap(), original);
}

#[test]
fn unrecognized_disk_fields_survive_all_writes_without_entering_snapshots() {
    let dir = tempfile::tempdir().unwrap();
    let store = SettingsStore::load(dir.path().into()).unwrap();
    let retained = changes(json!({
        "retired.option": {"nested": [1, false]},
        "future.option": null,
        "voice.retired.apiKey": "private-legacy-value"
    }));
    let mut values = retained.clone();
    values.insert("appearance.theme".into(), json!("dark"));
    write_json(&dir.path().join("settings.json"), &store.document(&values, 3, false)).unwrap();
    let mut store = SettingsStore::load(dir.path().into()).unwrap();
    assert_eq!(store.snapshot().unwrap().1, changes(json!({"appearance.theme": "dark"})));
    store.update(changes(json!({"general.language": "zh-CN"})), None).unwrap();
    store.import_browser(changes(json!({"editor.fontSize": 18, "editor.retiredOption": true}))).unwrap();
    store.set_secret("voice.doubao.apiKey", "current-key").unwrap();
    store.remove_secret("voice.doubao.apiKey").unwrap();
    let disk = read_json::<BTreeMap<String, Value>>(&dir.path().join("settings.json")).unwrap().unwrap();
    for (key, value) in retained {
        assert_eq!(disk[&key], value);
        assert!(!store.snapshot().unwrap().1.contains_key(&key));
    }
    assert!(!store.values.contains_key("editor.retiredOption"));
    let restarted = SettingsStore::load(dir.path().into()).unwrap();
    assert_eq!(restarted.values, store.values);
    assert_eq!(restarted.unrecognized, store.unrecognized);
    assert!(restarted.browser_migrated());
}

#[test]
fn transaction_recovery_preserves_unrecognized_fields_privately() {
    let dir = tempfile::tempdir().unwrap();
    let store = SettingsStore::load(dir.path().into()).unwrap();
    let tx = Transaction {
        settings: store.document(
            &changes(json!({"future.option": {"enabled": true}, "voice.enabled": false})),
            8,
            true,
        ),
        credentials: BTreeMap::new(),
    };
    write_json(&dir.path().join(".settings-transaction.json"), &tx).unwrap();
    let mut recovered = SettingsStore::load(dir.path().into()).unwrap();
    assert_eq!(recovered.snapshot().unwrap().1, changes(json!({"voice.enabled": false})));
    recovered.update(changes(json!({"appearance.theme": "dark"})), None).unwrap();
    let disk = read_json::<BTreeMap<String, Value>>(&dir.path().join("settings.json")).unwrap().unwrap();
    assert_eq!(disk["future.option"], json!({"enabled": true}));
    assert!(!dir.path().join(".settings-transaction.json").exists());
}

#[test]
fn compatibility_does_not_accept_invalid_known_values_or_future_schemas() {
    let dir = tempfile::tempdir().unwrap();
    let store = SettingsStore::load(dir.path().into()).unwrap();
    let path = dir.path().join("settings.json");
    for document in [
        store.document(&changes(json!({"appearance.theme": 42, "future.option": true})), 1, true),
        changes(json!({"$schemaVersion": 2, "$revision": 1, "$browserMigrated": true})),
    ] {
        write_json(&path, &document).unwrap();
        let original = std::fs::read(&path).unwrap();
        assert!(SettingsStore::load(dir.path().into()).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original);
    }
}

#[test]
fn trackpad_master_survives_restart_independently_of_legacy_gesture_migration() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = SettingsStore::load(dir.path().into()).unwrap();
    store
        .update(changes(json!({"appearance.trackpadEnabled": false, "appearance.threeFingerSwipe": true})), None)
        .unwrap();
    let restarted = SettingsStore::load(dir.path().into()).unwrap();
    assert_eq!(restarted.values["appearance.trackpadEnabled"], false);
    assert_eq!(restarted.values["appearance.threeFingerSwipe"], true);
    assert!(store.update(changes(json!({"appearance.trackpadEnabled": "false"})), None).is_err());
}

#[test]
fn mobile_bridge_preference_survives_restart_and_rejects_non_boolean_values() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = SettingsStore::load(dir.path().into()).unwrap();
    store.update(changes(json!({"mobile.bridgeEnabled": true})), None).unwrap();
    assert!(store.update(changes(json!({"mobile.bridgeEnabled": "true"})), None).is_err());
    let restarted = SettingsStore::load(dir.path().into()).unwrap();
    assert_eq!(restarted.values["mobile.bridgeEnabled"], true);
}

#[test]
fn free_model_watch_and_completion_sound_are_registered_booleans() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = SettingsStore::load(dir.path().into()).unwrap();
    assert!(store
        .update(changes(json!({"providers.freeModelWatch": "yes"})), None)
        .is_err());
    assert!(store
        .update(changes(json!({"automation.completionSound": "yes"})), None)
        .is_err());
    store
        .update(
            changes(json!({"providers.freeModelWatch": true, "automation.completionSound": true})),
            None,
        )
        .unwrap();
    let (known, private) = partition_settings(store.values.clone());
    assert_eq!(known["providers.freeModelWatch"], true);
    assert_eq!(known["automation.completionSound"], true);
    assert!(!private.contains_key("providers.freeModelWatch"));
    let restarted = SettingsStore::load(dir.path().into()).unwrap();
    assert_eq!(restarted.values["automation.completionSound"], true);
}

#[test]
fn auto_update_defaults_to_disabled_and_only_accepts_booleans() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = SettingsStore::load(dir.path().into()).unwrap();
    assert!(store.values.get("updater.autoUpdate").is_none());
    assert!(store.update(changes(json!({"updater.autoUpdate": "true"})), None).is_err());
    store.update(changes(json!({"updater.autoUpdate": true})), None).unwrap();
    let restarted = SettingsStore::load(dir.path().into()).unwrap();
    assert_eq!(restarted.values["updater.autoUpdate"], true);
}
#[test]
fn the_drive_master_switch_is_a_registered_boolean_setting() {
    let dir = tempfile::tempdir().unwrap();
    let mut s = SettingsStore::load(dir.path().into()).unwrap();
    // Settings → 通用 → 关闭云盘 writes this key. Unregistered, the confirm dialog answered
    // 「这个设置项未被识别」 and the drive never turned off (2026-11-18).
    s.update(changes(json!({"drive.yupEnabled": false})), None).unwrap();
    assert_eq!(s.values["drive.yupEnabled"], false);
    let (known, private) = partition_settings(s.values.clone());
    assert_eq!(known["drive.yupEnabled"], false);
    assert!(!private.contains_key("drive.yupEnabled"));
    assert!(s.update(changes(json!({"drive.yupEnabled": "no"})), None).is_err());
}
