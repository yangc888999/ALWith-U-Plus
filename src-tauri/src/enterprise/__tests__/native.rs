use alwith_enterprise_client::{EnterpriseClient, Protocol};
use serde_json::Value;
use std::path::PathBuf;

const GATEWAY: &str = "https://ai-enterprise-ai-gateway-api-dev.finture.id";

/// 0.6.5 起企业会话由原生持有：`open_gateway` 拿走一个**会话文件**（必须是绝对路径），
/// 身份只给网关地址 + 账号 uuid + 邮箱 + 环境 + 申请名，应用不再经手 access token。
async fn prepare(client: &EnterpriseClient, account: &str) -> Result<u64, Value> {
    client
        .prepare_gateway(
            GATEWAY.into(),
            account.into(),
            format!("{account}@yup.id"),
            "development".into(),
            "alwith-u".into(),
        )
        .await
}

#[test]
fn enterprise_native_preserves_generation_and_owner_lifecycle() {
    tauri::async_runtime::block_on(async {
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/native");

        // 相对路径会让会话文件落到进程 cwd 下，原生直接拒绝。
        let relative = PathBuf::from("enterprise-gateway-sessions.json");
        assert!(EnterpriseClient::open_gateway(&directory, &relative).await.is_err());

        let storage = tempfile::tempdir().unwrap();
        let sessions = storage.path().join("enterprise-gateway-sessions.json");
        let client = EnterpriseClient::open_gateway(&directory, &sessions)
            .await
            .expect("stage enterprise before Rust tests");
        // 同一个会话文件只允许一个 owner：第二个 open 必须失败，而不是共享令牌状态。
        let second_owner = EnterpriseClient::open_gateway(&directory, &sessions).await;
        assert_eq!(second_owner.map(|_| ()).unwrap_err()["message"], "Enterprise owner is already open");

        let first = prepare(&client, "first-account").await.unwrap();
        let status = client.status(first).await.unwrap();
        assert_eq!(status["automatic_renewal"], false);
        assert_eq!(status["requires_login"], true);
        assert_eq!(status["generation"], first);

        let second = prepare(&client, "second-account").await.unwrap();
        assert_ne!(first, second);
        // 换账号后旧 generation 立刻失效，不能拿它继续读状态或续期。
        let error = client.status(first).await.unwrap_err();
        assert!(error.is_object());
        assert!(error["message"].is_string());
        assert!(!error.to_string().contains("Enterprise owner is already open"));

        // 未登录的 generation 不能借 relay 拿到网关凭据。
        let relay = client.relay(second, GATEWAY.into(), Protocol::Responses).await;
        assert_eq!(relay.map(|_| ()).unwrap_err()["message"], "enterprise_login_required");
        client.suspend(second).await.unwrap();

        // A pending native event read must not prevent the application from closing its owner.
        let reader = client.clone();
        let events = tauri::async_runtime::spawn(async move { reader.next_event().await });
        client.close().await.unwrap();
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), events).await.unwrap().unwrap();
        // Reads admitted before close return null; later reads reject the retired handle.
        assert!(result == Ok(Value::Null) || result.unwrap_err()["message"].is_string());
        assert!(client.status(second).await.is_err());

        // 关闭后同一个会话文件可以重新打开。
        let reopened = EnterpriseClient::open_gateway(&directory, &sessions).await.unwrap();
        reopened.close().await.unwrap();
    });
}
