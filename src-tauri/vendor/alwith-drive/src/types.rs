//! 契约 DTO 与 UI 快照类型。字段名 / 顺序对齐 docs/drive-sync-api-contract.md。
//! Public wire types, the one source for both sides: the private engine compiles this file too.
//! No business logic and no Tauri dependency here.

use serde::{Deserialize, Serialize};

/// 服务端 id(projectId / fileId / versionId / folderId):契约未钉死是数字还是字符串,
/// 两种都原样收发;索引里按 `as_key()` 存文本。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(untagged)]
pub enum RemoteId {
    Number(i64),
    Text(String),
}

impl RemoteId {
    pub fn as_key(&self) -> String {
        match self {
            RemoteId::Number(value) => value.to_string(),
            RemoteId::Text(value) => value.clone(),
        }
    }

    pub fn from_key(key: &str) -> Self {
        match key.parse::<i64>() {
            Ok(value) => RemoteId::Number(value),
            Err(_) => RemoteId::Text(key.to_string()),
        }
    }
}

impl std::fmt::Display for RemoteId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.as_key())
    }
}

/// 响应信封 `{success, message, data}`;吊销时 401 + `code: DEVICE_REVOKED`。
#[derive(Debug, Deserialize)]
#[serde(bound(deserialize = "T: serde::Deserialize<'de>"))]
pub struct Envelope<T> {
    pub success: bool,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub data: Option<T>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ProjectKind {
    Material,
    Knowledge,
    Skill,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ProjectScope {
    Personal,
    Dept,
    Team,
    Company,
}

/// `GET /sync/roots` 的一项。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRoot {
    pub project_id: RemoteId,
    pub project_key: String,
    pub name: String,
    pub kind: ProjectKind,
    /// 契约 4.1:scope 可能为空,客户端按有无 deptName 归到 DEPT / COMPANY
    #[serde(default)]
    pub scope: Option<ProjectScope>,
    #[serde(default)]
    pub dept_name: Option<String>,
    /// 一律用服务端返回值,客户端不自行推导。
    ///
    /// **可以为 null**(服务端 7662157):SKILL 项目不再进目录树 —— 它走 `skills_path` 装进
    /// `~/.alwith/skills/`,人不需要浏览。null 的一律挡在同步与目录树之外。
    #[serde(default)]
    pub drive_path: Option<String>,
    /// 树上的哪一节:`PERSONAL` / `DEPT` / `COMPANY`(TEAM 归其上级部门);SKILL 为 null。
    #[serde(default)]
    pub node: Option<String>,
    /// 这一节里的哪个容器:`MATERIAL`(资料库)/ `KNOWLEDGE`(知识库);SKILL 为 null。
    #[serde(default)]
    pub container: Option<String>,
    /// 分组用的节点路径:`我的空间` / `部门/<部门名>` / `公司`。
    ///
    /// **画树按它分组,不要去切 `drive_path` 的字符串** —— 服务端特意给了这个字段,
    /// 切字符串会在部门名自己带斜杠时炸。
    #[serde(default)]
    pub node_path: Option<String>,
    pub sync_enabled: bool,
    pub can_write: bool,
    pub cloud_only: bool,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub skills_path: Option<String>,
    /// 项目所属部门 id。**按 id 比对,不按 `deptName` 显示名** —— 显示名会带尾空格、会被改名,
    /// 用它判「是不是本人部门的」曾经把人挡在外面。老服务端不返回 → None,回落 `dept_name`。
    #[serde(default)]
    pub department_id: Option<RemoteId>,
    /// 项目归属人(DEPT / COMPANY 为 null)。服务端新加的字段,老服务端不返回 → None
    #[serde(default)]
    pub owner_id: Option<RemoteId>,
    /// 是否归属当前用户。「我的空间」看它而不是 `scope == PERSONAL`:管理员对全公司每个人的
    /// 个人知识库都有读权限,按 scope 分组会把 280 个别人的库全塞进「我的空间」。
    /// 老服务端不返回 → None,调用方回落 `scope == PERSONAL`。
    #[serde(default)]
    pub is_mine: Option<bool>,
}

/// `GET /sync/snapshot` 的一个文件。
///
/// 除 `fileId` / `path` 外一律按「服务端可能不给」处理:老库里 `file_versions` 有 sha256 / size 为
/// NULL 的历史行(2026-06 前上传的文件),一个必填字段就能让整个项目的 snapshot 反序列化失败、
/// 整轮同步中断。缺 sha256 时改按 versionId 判定变更、按文件下载(见 engine.rs)。
/// 其余未知字段由 serde 默认忽略(没有 deny_unknown_fields)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotFile {
    pub file_id: RemoteId,
    pub path: String,
    #[serde(default)]
    pub version_id: Option<RemoteId>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub cloud_only: bool,
    /// 为什么不给内容:`archive` / `session` / `no_download_permission`。**服务端目前不返回它**
    /// (只有 `cloudOnly: bool`),客户端据此在占位文件里写「未知」而不是猜一个 —— 给了就照写。
    #[serde(default)]
    pub cloud_only_reason: Option<String>,
    /// 需要走修改申请的文件:**正常下载到本地**,但本地改动不上行(见 `FileState::ReadOnly`)。
    /// 与 `cloud_only` 是两回事 —— cloudOnly 是「本地根本没有内容」,readOnly 是「有内容、不许改」。
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub updated_at: Option<String>,
    /// 6.7:中继上报 active_clients>0 的文件,桌面端停止上行、下行照常
    #[serde(default)]
    pub collab_active: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotFolder {
    pub folder_id: RemoteId,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub files: Vec<SnapshotFile>,
    /// 目录只在**第一页**给(见服务端 SyncService.snapshot)
    pub folders: Vec<SnapshotFolder>,
    /// 事件高水位。取自服务端翻第一页之前 —— 要等最后一页到手才写进自己的游标
    pub cursor: String,
    #[serde(default)]
    pub has_more: bool,
    /// 下一页从这个 fileId 之后开始
    #[serde(default)]
    pub next_after: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EventType {
    FileCreated,
    FileUpdated,
    FileRenamed,
    FileMoved,
    FileDeleted,
    FolderCreated,
    FolderRenamed,
    FolderMoved,
    FolderDeleted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEvent {
    pub seq: i64,
    pub event_type: EventType,
    #[serde(default)]
    pub file_id: Option<RemoteId>,
    #[serde(default)]
    pub folder_id: Option<RemoteId>,
    pub path: String,
    #[serde(default)]
    pub old_path: Option<String>,
    #[serde(default)]
    pub version_id: Option<RemoteId>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub actor_id: Option<RemoteId>,
    #[serde(default)]
    pub cloud_only: bool,
    /// 见 `SnapshotFile::cloud_only_reason`
    #[serde(default)]
    pub cloud_only_reason: Option<String>,
    /// 见 `SnapshotFile::read_only`
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub collab_active: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangesPage {
    pub events: Vec<ChangeEvent>,
    pub next_cursor: String,
    pub has_more: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobInfo {
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BatchOpKind {
    Create,
    Update,
    Rename,
    Move,
    Delete,
    Mkdir,
    Rmdir,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchOp {
    pub op_id: String,
    pub op: BatchOpKind,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_version_id: Option<RemoteId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_id: Option<RemoteId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRequest {
    pub project_id: RemoteId,
    pub device_id: String,
    pub ops: Vec<BatchOp>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BatchStatus {
    Ok,
    Conflict,
    Forbidden,
    MissingBlob,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteVersion {
    pub version_id: RemoteId,
    /// 同 `SnapshotFile::sha256`:历史版本行可能为 NULL,缺了就按 fileId 下载
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub updated_by: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    pub op_id: String,
    pub status: BatchStatus,
    #[serde(default)]
    pub file_id: Option<RemoteId>,
    #[serde(default)]
    pub version_id: Option<RemoteId>,
    #[serde(default)]
    pub remote: Option<RemoteVersion>,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResponse {
    pub results: Vec<BatchResult>,
    #[serde(default)]
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterDeviceRequest {
    pub device_name: String,
    pub platform: String,
    pub client_version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRegistration {
    pub device_id: String,
    pub token: String,
    #[serde(default)]
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub device_id: String,
    #[serde(default)]
    pub device_name: Option<String>,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub client_version: Option<String>,
    #[serde(default)]
    pub last_seen_at: Option<String>,
    #[serde(default)]
    pub revoked_at: Option<String>,
}

// ─── 引擎 / UI 快照 ───────────────────────────────────────────────────────────

/// 单个文件的同步状态(文件树角标)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum FileState {
    Synced,
    Pending,
    Uploading,
    Conflict,
    CloudOnly,
    Ignored,
    SkippedTooLarge,
    /// 超过「自动下载」阈值的大文件:云端有、本地只有一个 `.yupcloud` 占位,**点一下就拉**。
    ///
    /// 与 `CloudOnly` 是两回事,不能混:`CloudOnly` 是「这份内容不许落到你的盘上」(权限 /
    /// 会话原文 / 归档),点多少下都不会下来;这个只是「默认先不下,免得几十兆的原始数据表
    /// 把同步占满」,用户想要随时能拿(2026-09-07 老板拍板:大文件不自动下载,标注,按需下载)。
    NotDownloaded,
    /// 正在按需下载(用户点了那个占位)。给文件树上的转圈用
    Downloading,
    /// 服务端 FORBIDDEN(受管控文件 / 需审批删除 / sync_enabled=false),不重试
    Forbidden,
    /// 服务端 `readOnly=true`:内容正常落到本地,但本地改动**不上行**,改要走网页上的修改申请
    ReadOnly,
    Error,
    /// 协同中(服务端 collabActive=true):Yjs 文档是真相,本地不上行、下行照常
    Collab,
}

impl FileState {
    pub fn as_str(self) -> &'static str {
        match self {
            FileState::Synced => "synced",
            FileState::Pending => "pending",
            FileState::Uploading => "uploading",
            FileState::Conflict => "conflict",
            FileState::CloudOnly => "cloudOnly",
            FileState::Ignored => "ignored",
            FileState::SkippedTooLarge => "skippedTooLarge",
            FileState::NotDownloaded => "notDownloaded",
            FileState::Downloading => "downloading",
            FileState::Forbidden => "forbidden",
            FileState::ReadOnly => "readOnly",
            FileState::Error => "error",
            FileState::Collab => "collab",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "synced" => FileState::Synced,
            "pending" => FileState::Pending,
            "uploading" => FileState::Uploading,
            "conflict" => FileState::Conflict,
            "cloudOnly" => FileState::CloudOnly,
            "ignored" => FileState::Ignored,
            "skippedTooLarge" => FileState::SkippedTooLarge,
            "notDownloaded" => FileState::NotDownloaded,
            "downloading" => FileState::Downloading,
            "forbidden" => FileState::Forbidden,
            "readOnly" => FileState::ReadOnly,
            "error" => FileState::Error,
            "collab" => FileState::Collab,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EngineState {
    Idle,
    Scanning,
    Syncing,
    Paused,
    Error { message: String },
}

/// 索引里的根(服务端根 + 本地 pinned / cursor)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RootInfo {
    pub project_id: RemoteId,
    pub project_key: String,
    pub name: String,
    pub kind: ProjectKind,
    pub scope: ProjectScope,
    pub dept_name: Option<String>,
    /// 见 `SyncRoot::drive_path`。**空串 = 不进目录树**(SKILL)。
    pub drive_path: String,
    /// 见 `SyncRoot::node` / `container` / `node_path`。面板按 `node_path` 分组
    pub node: Option<String>,
    pub container: Option<String>,
    pub node_path: Option<String>,
    pub skills_path: Option<String>,
    pub sync_enabled: bool,
    pub can_write: bool,
    pub cloud_only: bool,
    pub cursor: Option<String>,
    pub pinned: bool,
    /// 见 `SyncRoot::department_id`
    pub department_id: Option<RemoteId>,
    /// 见 `SyncRoot::owner_id`;服务端没给就是 None
    pub owner_id: Option<RemoteId>,
    /// 见 `SyncRoot::is_mine`;None = 老服务端,前端回落按 scope 分组
    pub is_mine: Option<bool>,
    /// 本地绝对路径(`<local_root>/<drivePath>`)
    pub local_path: String,
    /// 是否在本轮同步范围内 = 自己的(`isMine`)+ 公司级 + 本人部门的 + 用户点开过的,且 `syncEnabled`。
    /// 归属判不出且个人库数量超阈值时的兜底见 `engine::LEGACY_PERSONAL_ROOT_LIMIT` 与 `OwnershipGuard`
    pub selected: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FileStateEvent {
    pub project_id: RemoteId,
    /// 云端相对路径
    pub path: String,
    /// 本地绝对路径
    pub local_path: String,
    pub state: FileState,
    /// 云端记的字节数(索引里没有这一行时是 0)。
    ///
    /// 给文件树上那个占位用:「这份还没下,12.4 MB,点一下拉」——只说「还没下」而不说多大,
    /// 用户没法判断值不值得点(2026-09-07 老板拍板大文件按需下载时明确要「标注 + 大小」)。
    #[serde(default)]
    pub size: u64,
}

/// 用户改了一个 `readOnly=true` 的文件。这类文件正常落到本地(能看、能被 agent 读),
/// 但改动不上行 —— 静默丢弃是最糟的:用户以为存上去了。桌面端据此提示「这份文件需要走修改申请」,
/// 并给一个 `<webBase>/file/<fileId>` 的入口。
///
/// 每个 (文件, 内容 sha256) 只报一次(引擎内去重),否则每一轮同步都会再弹一次。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReadOnlyChange {
    pub project_id: RemoteId,
    /// 云端相对路径
    pub path: String,
    /// 本地绝对路径
    pub local_path: String,
    /// 文件名(提示语里用)
    pub name: String,
    /// 服务端 fileId;还没上过云的文件没有 → 只能给项目级入口
    pub file_id: Option<RemoteId>,
}

/// 批量删除安全阀触发:某个 root 一轮里净删除达到阈值,已挂起、等用户确认是否也从云端删除。
/// 前端据此弹一个 Dropbox 式确认(确认删除 / 取消恢复)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PendingDeletes {
    pub project_id: RemoteId,
    /// 项目在云盘里的路径 / 名字(提示语里用,比裸 id 好认)
    pub drive_path: String,
    /// 本轮被拦下的净删除文件数
    pub count: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictRecord {
    pub project_id: RemoteId,
    pub path: String,
    pub local_path: String,
    /// 本地版本另存的冲突副本(本地绝对路径);远端在本地删除后又改过的那种冲突没有副本
    pub conflict_copy_path: Option<String>,
    pub remote_updated_by: Option<String>,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncError {
    pub project_id: Option<RemoteId>,
    pub path: Option<String>,
    pub message: String,
    pub at: String,
}

/// 一条失败记录是**哪个方向**的。两句话不一样,用户能做的动作也不一样:
/// 「没传上去」要等重试 / 去要权限,「没下下来」可以当场点一下手动拉。
///
/// 2026-09-07 之前下行失败只落在内存 ring 里,重启就没 —— 于是「下载卡死十分钟」在界面上
/// 一片安静。方向这个字段是把下行接进同一套可见性的前提。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum SyncDirection {
    Upload,
    Download,
}

impl SyncDirection {
    pub fn as_str(self) -> &'static str {
        match self {
            SyncDirection::Upload => "upload",
            SyncDirection::Download => "download",
        }
    }

    /// 认不出来的一律当上行:老库里的记录都是上行留下的(v7 之前只有上行会写这张表)。
    pub fn parse(raw: &str) -> Self {
        if raw == "download" { SyncDirection::Download } else { SyncDirection::Upload }
    }
}

/// 一个同步失败、至今没落地的文件。`StatusSnapshot::failed` 是它的计数,这里是明细
/// (哪个文件、服务端原话是什么、试了几次、下次什么时候再试)。
///
/// `message` 一律**原样**保留服务端那句话:`PARENT_FOLDER_NOT_FOUND: 上级目录不存在: …`
/// 这种错误的价值全在细节里,翻译成「上传失败」等于把排查线索扔了。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FailedUpload {
    pub project_id: RemoteId,
    /// 云端相对路径
    pub path: String,
    /// 本地绝对路径(项目根已经不在索引里时为空串)
    pub local_path: String,
    /// 文件名(提示语里用)
    pub name: String,
    /// `error`(会按退避重试)或 `forbidden`(要人去处理权限,内容再变才重发)
    pub state: FileState,
    /// 服务端原话
    pub message: String,
    /// 已经试过几次
    pub attempts: u32,
    /// 上行还是下行 —— UI 那句话不一样
    pub direction: SyncDirection,
    pub first_at: String,
    pub last_at: String,
    /// 下一次会重试的时间;已经到点了就是过去的时间
    pub next_attempt_at: String,
    /// 这条还会不会自己再试。`false` = 再试也是同一个答案(目录非空、没权限、云端那份
    /// 已经没了……),引擎已经停手,得有人去处理 —— UI 必须说清楚,不然用户看到的就是
    /// 一条「已试 21 次」永远挂在那里,既不成功也不消失(2026-09-15 用户原话)。
    pub retryable: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StatusSnapshot {
    pub state: EngineState,
    /// 本轮待上传文件数
    pub pending: u32,
    /// 正在上传
    pub uploading: u32,
    /// 本轮还没下完的文件数(下行)。状态栏的「同步中 N 个文件」用它 + `uploading`
    pub downloading: u32,
    /// 累计已同步文件数(索引里 synced 行数)
    pub synced: u32,
    /// 上行失败、至今没传上去的文件数(状态栏那句「N 个文件没传上去」)。
    ///
    /// 2026-09-07 之前这个数不存在:失败的行停在 `FileState::Error`,重试六轮还是同一句
    /// `PARENT_FOLDER_NOT_FOUND`,而 UI 上一个字都没有 —— 用户以为文件已经在云上了。
    /// 静默失败比失败本身更伤人。明细见 `Engine::failed_uploads`
    pub failed: u32,
    pub conflicts: Vec<ConflictRecord>,
    pub errors: Vec<SyncError>,
    pub last_sync_at: Option<String>,
    /// `/ws/sync` 变更推送是否在线;离线时回落 60 秒轮询
    pub push_connected: bool,
}

impl Default for StatusSnapshot {
    fn default() -> Self {
        Self {
            state: EngineState::Idle,
            pending: 0,
            uploading: 0,
            downloading: 0,
            synced: 0,
            failed: 0,
            conflicts: Vec::new(),
            errors: Vec::new(),
            last_sync_at: None,
            push_connected: false,
        }
    }
}

// ─── 6.1 SSO ─────────────────────────────────────────────────────────────────

/// `GET /auth/sso/config`(公开)。`enabled=false` 时其余字段可缺。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SsoConfig {
    pub enabled: bool,
    #[serde(default)]
    pub issuer: Option<String>,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub authorization_endpoint: Option<String>,
    #[serde(default)]
    pub token_endpoint: Option<String>,
    #[serde(default)]
    pub redirect_uris: Vec<String>,
    /// 服务端可能给 `"openid profile email"` 一个串,也可能给数组;统一收成列表
    #[serde(default, deserialize_with = "string_or_list")]
    #[specta(type = Vec<String>)]
    pub scopes: Vec<String>,
}

fn string_or_list<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Vec<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum StringOrList {
        Text(String),
        List(Vec<String>),
    }
    Ok(match StringOrList::deserialize(deserializer)? {
        StringOrList::Text(text) => text.split_whitespace().map(str::to_string).collect(),
        StringOrList::List(list) => list,
    })
}

/// `POST /auth/sso/exchange` 请求体。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SsoExchangeRequest {
    pub id_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SsoUser {
    pub user_id: RemoteId,
    pub display_name: String,
    #[serde(default)]
    pub employee_no: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub feishu_open_id: Option<String>,
}

/// `POST /auth/sso/exchange` 响应:带 deviceName 时 `deviceId` 有值且 `token` 是设备 token。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SsoExchangeResponse {
    pub token: String,
    pub user: SsoUser,
    #[serde(default)]
    pub device_id: Option<String>,
}

// ─── 6.7 协同 ────────────────────────────────────────────────────────────────

/// `GET /files/{id}` 里协同要看的那一点:`canWrite`(镜像文件 / sync_enabled=false 项目为 false)。
/// 服务端目前尚未在文件详情里带这个字段,缺省时按根的 canWrite 判。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAccess {
    #[serde(default)]
    pub can_write: Option<bool>,
    /// 文件所有者。「采纳建议替换」只对他显示;没有所有者的文件谁都不是所有者,不是缺省值
    #[serde(default)]
    pub owner_id: Option<RemoteId>,
}

// ─── 文件评论 ────────────────────────────────────────────────────────────────

/// 评论里出现的人:采纳者、以及 @ 到的人、`GET /users/search` 的搜人结果。服务端 `UserBrief` 原样。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UserBrief {
    pub id: RemoteId,
    #[serde(default)]
    pub employee_no: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

/// `GET /files/{fileId}/comments` 的一项。**服务端直接给嵌套树**(根评论带 `replies`),
/// 客户端不按 `parentId` 自己拼。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FileComment {
    pub id: RemoteId,
    pub file_id: RemoteId,
    #[serde(default)]
    pub parent_id: Option<RemoteId>,
    pub author_id: RemoteId,
    #[serde(default)]
    pub author_name: Option<String>,
    #[serde(default)]
    pub author_employee_no: Option<String>,
    /// 软删除的墓碑(还有回复挂着)body / quote 都是 null,UI 显示「已删除」占位
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub quote: Option<String>,
    /// 引文在正文纯文本里的字符偏移;老评论没有。多处重复引文靠它消歧
    #[serde(default)]
    pub quote_offset: Option<i64>,
    #[serde(default)]
    pub is_ai: bool,
    /// 这条评论 @ 到的人(服务端回的,带名字)。**显示名字不显示 id** —— 正文里本来就是
    /// `@名字`,这份列表是给「谁被提到了」这类判断用的
    #[serde(default)]
    pub mentions: Option<Vec<UserBrief>>,
    #[serde(default)]
    pub deleted: bool,
    pub created_at: String,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub replies: Vec<FileComment>,
    #[serde(default)]
    pub suggested_replacement: Option<String>,
    #[serde(default)]
    pub applied_at: Option<String>,
    #[serde(default)]
    pub applied_by: Option<UserBrief>,
    #[serde(default)]
    pub applied_version_id: Option<RemoteId>,
}

/// `POST /files/{fileId}/comments` 的请求体。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateCommentRequest {
    pub body: String,
    /// 这条评论 @ 到了谁。服务端(`FileCommentEntity.mentionedUserIds`)据此发通知。
    ///
    /// **正文里同时留着 `@名字` 的字面文本**(与网页端同一做法):id 只用来通知,
    /// 显示靠正文本身 —— 这样老客户端、纯文本导出、AI 读到的都是人话而不是一串数字。
    /// 没 @ 任何人时发 `null`(**不是空数组**)。服务端把 null 与「字段不在」当同一回事 ——
    /// 与同结构体里的 `parent_id` 同一处理。
    /// (不能用 `skip_serializing_if`:这个结构体同时是命令入参,specta 的统一模式表达不了条件省略。)
    pub mentioned_user_ids: Option<Vec<RemoteId>>,
    /// 回复谁(根评论为 None)。服务端把 null 与「字段不在」当同一回事,所以照发 null
    pub parent_id: Option<RemoteId>,
    pub quote: Option<String>,
    pub quote_offset: Option<i64>,
    /// 建议替换文本:文件所有者可以「采纳」它生成新版本。有它就必须有 quote
    pub suggested_replacement: Option<String>,
}

/// 打开评论抽屉前要问清的三件事:这份文件在服务端是谁、我是谁、我能不能采纳建议。
/// 不在 Drive 里 / 没登录时命令返回 None —— 那时根本不该出现评论入口。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CommentContext {
    pub file_id: RemoteId,
    pub current_user_id: RemoteId,
    /// 文件所有者本人 → 建议替换旁边出现「采纳」
    pub is_owner: bool,
}

// ─── 6.2 变更推送 ────────────────────────────────────────────────────────────

/// `/ws/sync` 上的 JSON 帧,双向共用一个 tagged enum。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PushMessage {
    Subscribe {
        #[serde(rename = "projectIds")]
        project_ids: Vec<RemoteId>,
    },
    /// 服务端对 `subscribe` 的确认(契约里没写,实测有);收到只记 debug,不做别的
    Subscribed {
        #[serde(rename = "projectIds", default)]
        project_ids: Vec<RemoteId>,
    },
    FileEvents {
        #[serde(rename = "projectId")]
        project_id: RemoteId,
        seq: i64,
    },
    /// 打开着评论抽屉的文件集(整份替换,不是增量)。
    SubscribeFiles {
        #[serde(rename = "fileIds")]
        file_ids: Vec<RemoteId>,
    },
    /// 服务端对 `subscribe_files` 的确认:**没有 READ 权的 fileId 会被剔除**,
    /// 所以回来的集合可能比发出去的小 —— 少掉的那些永远收不到 comment_event。
    FilesSubscribed {
        #[serde(rename = "fileIds", default)]
        file_ids: Vec<RemoteId>,
    },
    /// 某文件的评论变了。**只是信号**:客户端据此重拉一次列表,不做增量拼装。
    CommentEvent {
        #[serde(rename = "fileId")]
        file_id: RemoteId,
        #[serde(rename = "commentId")]
        comment_id: RemoteId,
        /// `created` / `updated` / `deleted` / `applied`。保持字符串:新增动作时老客户端
        /// 照样能收下并重拉列表,不必为了一个没见过的取值把整帧丢掉
        action: String,
        /// 服务端全局 NON_NULL:actorId / at 为空时整个字段不出现
        #[serde(rename = "actorId", default)]
        actor_id: Option<RemoteId>,
        #[serde(default)]
        at: Option<String>,
    },
    Ping,
    Pong,
}

// ─── 6.8 新建项目向导 ────────────────────────────────────────────────────────

/// `GET /project-templates` 一项(服务端 `project_templates` 实体原样)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTemplate {
    pub id: RemoteId,
    #[serde(default)]
    pub code: Option<String>,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub builtin: bool,
}

/// `GET /departments` 一项(扁平列表)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Department {
    pub id: RemoteId,
    #[serde(default)]
    pub code: Option<String>,
    pub name: String,
    #[serde(default)]
    pub parent_id: Option<RemoteId>,
    #[serde(default, rename = "type")]
    pub department_type: Option<String>,
    /// 层级路径(`GET /departments?q=` 搜出来的带它,契约 §6.18);列表接口不给 → None
    #[serde(default)]
    pub path: Option<String>,
}

/// `POST /projects/from-template` 请求体。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectFromTemplateRequest {
    pub template_id: RemoteId,
    pub name: String,
    pub scope: ProjectScope,
    /// 不带就发 null(specta 不接受 skip_serializing_if 的命令参数)
    #[serde(default)]
    pub department_id: Option<RemoteId>,
    #[serde(default)]
    pub topic_id: Option<RemoteId>,
}

/// `POST /projects/from-template` 响应:只取定位根所需的字段,其余原样忽略。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedProject {
    #[serde(alias = "projectId")]
    pub id: RemoteId,
    pub project_key: String,
    pub name: String,
}

// ─── 会话归档(上行专用根)/ 知识回流 / 版本保存 ───────────────────────────────

/// `GET /projects/by-key/{projectKey}`:只取定位归档项目所需的字段。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    #[serde(alias = "projectId")]
    pub id: RemoteId,
    #[serde(default)]
    pub project_key: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub sync_enabled: Option<bool>,
}

/// `GET /auth/me`:归档路径前缀用邮箱前缀(插件同款 `<email 前缀>/<YYYY-MM>/`)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInfo {
    #[serde(default)]
    pub id: Option<RemoteId>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
}

/// `GET /sync/me`:当前用户。契约钉死的只有 `{userId, displayName, employeeNo}`;部门字段
/// **各版本名字不一、也可能压根没有**,所以全按可选解析(客户端在 `client::parse_sync_me` 里
/// 把常见的几种写法都认一遍)。拿不到部门时 SKILL 自动分发退化成「只装公司级」——
/// 宁可少装,不可把别的部门的规范装到这台机器上。
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncMe {
    pub user_id: Option<RemoteId>,
    pub display_name: Option<String>,
    pub employee_no: Option<String>,
    /// 服务端待补(见 docs/drive.md「待服务端」):有了它就能按 id 而不是显示名匹配部门
    pub department_id: Option<RemoteId>,
    pub dept_name: Option<String>,
}

/// `POST /files/upload` 与 `POST /files/{id}/upload-version` 的响应(插件用的上传接口,归档回落路径)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadedFile {
    pub file_id: RemoteId,
    #[serde(default)]
    pub version_id: Option<RemoteId>,
    #[serde(default)]
    pub current_version_id: Option<RemoteId>,
}

/// `POST /files/{id}/save-content` 的响应。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedContent {
    #[serde(default)]
    pub new_version_id: Option<RemoteId>,
    #[serde(default)]
    pub merged_with_previous: bool,
}

/// `GET /ai/search` 一条命中(6.10;`mode` 缺省时 data 是数组,semantic / hybrid 时是 `{items,total}`,客户端两种都收)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AiSearchHit {
    pub file_id: RemoteId,
    pub name: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub project_name: Option<String>,
    #[serde(default)]
    pub folder_path: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub snippet: Option<String>,
    #[serde(default)]
    pub human_url: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub score: Option<f64>,
}

/// 设置页「已装的部门 Skill」的一条:SKILL 项目不进云盘列表(它是给机器读的),
/// 但用户得能找到它装在哪。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillMirror {
    pub project_id: RemoteId,
    pub project_key: String,
    pub name: String,
    /// 公司级 / 本人部门的 SKILL 会**自动**装;别的部门的只有用户手动固定才装
    pub auto_installed: bool,
    pub pinned: bool,
    /// DEPT / TEAM 的部门名;公司级为空
    pub dept_name: Option<String>,
    /// `~/YUP Drive/<drivePath>`
    pub local_path: String,
    /// `~/.alwith/skills/.yup-drive/<projectKey>`;没配 skills_dir 时为空
    pub skills_path: Option<String>,
    /// 是否已经同步到本地(目录存在)
    pub installed: bool,
}

/// 会话归档的状态快照(设置页「AI 对话归档」用)。`enabled` 由桌面侧按设置填。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveStatus {
    pub enabled: bool,
    pub syncing: bool,
    /// 上次扫描时间(不论有没有上传)
    pub last_run_at: Option<String>,
    /// 上次真正上传了会话的时间
    pub last_upload_at: Option<String>,
    /// 已归档会话数(索引里的行数)
    pub synced: u32,
    /// 上次运行上传的条数
    pub last_uploaded: u32,
    pub last_error: Option<String>,
    /// `batch`(走 /sync/batch)或 `upload`(服务端对该项目 FORBIDDEN,回落 /files/upload)
    pub mode: Option<String>,
}

/// 归属兜底防线的状态(见 `engine::LEGACY_PERSONAL_ROOT_LIMIT`)。
///
/// 老服务端不返回 `isMine` / `ownerId`,桌面端只能按 `scope == PERSONAL` 回落。对普通员工没问题
/// (自己就一个个人库),对管理员是灾难 —— 他对全公司每个人的个人知识库都有读权限,回落会把几百个
/// 同事的库全拉到本地磁盘(2026-09-04 生产联调实报 279 个)。这里把「归属判不出」这件事单独暴露给
/// UI,让用户看到防线为什么生效、并能显式覆盖它。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OwnershipGuard {
    /// 服务端既没给 `isMine` 也没给 `ownerId` 的 PERSONAL 根数量
    pub unknown_personal_roots: u32,
    /// 超过这个数量就只同步已固定的(`engine::LEGACY_PERSONAL_ROOT_LIMIT`)
    pub threshold: u32,
    /// 用户是否已显式点过「全部同步」覆盖这道防线
    pub sync_all_personal: bool,
    /// 防线是否正在生效:归属判不出 + 数量超阈值 + 用户没覆盖 → 只同步已固定的
    pub active: bool,
}

/// 单个项目在同步队列里的处境。云盘面板的行内状态直接映射这四个值 ——
/// 点一个还没落盘的项目后,用户要能一眼看出「在排队 / 在下 / 下完了 / 挂了」,
/// 而不是等一句二十秒后才弹的 toast。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ProjectPhase {
    /// 在本轮同步的队列里等着(用户点过的排在队首)
    Queued,
    /// 正在下行 / 上行这个项目
    Syncing,
    /// 本轮跑完了(`failed > 0` 说明有文件没下来,但项目本身是完成的)
    Done,
    /// 整个项目这一轮失败(拉 snapshot / changes 失败之类),`message` 是原因
    Failed,
}

/// 一个项目一轮同步的进度与结果。`total` 是本轮要处理的文件数(首轮 = snapshot 全量,
/// 增量轮 = 变更事件数),`done` / `failed` 是已处理与失败的个数 —— 结束时这两个数字
/// 就是「成功 N 个、失败 M 个」的汇总。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectProgress {
    pub project_id: RemoteId,
    pub phase: ProjectPhase,
    /// 本轮已处理完的文件数
    pub done: u32,
    /// 本轮要处理的文件数;拿到 snapshot / changes 之前是 0
    pub total: u32,
    /// 本轮失败的文件数(单文件失败不拖垮项目,详情进 `StatusSnapshot::errors`)
    pub failed: u32,
    /// 失败原因摘要;完整错误在 `StatusSnapshot::errors` 里按 projectId 找
    pub message: Option<String>,
    pub at: String,
}

/// 「清理未选中的本地副本」的一个候选目录:已落盘,但当前不在同步选择集里。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CleanupEntry {
    pub project_id: RemoteId,
    pub name: String,
    pub drive_path: String,
    pub local_path: String,
    /// 目录里的文件数(给用户一个体量感)
    pub files: u32,
}

/// 必须跳过的理由。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum CleanupSkipReason {
    /// 用户自己固定的项目 —— 哪怕当前没在同步范围内(如 `syncEnabled=false`)也不动
    Pinned,
    /// 目录里有还没上行的本地改动(新增 / 修改 / 删除 / pending / 冲突)
    PendingChanges,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CleanupSkipped {
    pub name: String,
    pub drive_path: String,
    pub local_path: String,
    pub reason: CleanupSkipReason,
}

/// 清理的扫描结果 / 执行结果。扫描阶段 `moved` 恒为空,执行阶段 `candidates` 是这一轮真正处理过的集合。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CleanupReport {
    /// `<本地根>/../YUP Drive 暂存`
    pub staging_dir: String,
    /// 可以移走的目录
    pub candidates: Vec<CleanupEntry>,
    /// 必须跳过的目录与理由
    pub skipped: Vec<CleanupSkipped>,
    /// 真正移走的目录(扫描阶段为空)
    pub moved: Vec<CleanupEntry>,
    /// 移动失败的:`<drivePath>: <原因>`
    pub failed: Vec<String>,
}

// ─── 沉淀(condense)─────────────────────────────────────────────────────────
//
// 「资料自动沉淀为知识」是整个项目的核心卖点,但入口一直只在网页上的一个按钮 —— 而人干活是
// 在 alwith 里。老板原话:「沉淀不是直接在 alwith 里做好了以后直接沉淀为知识的吗」。
//
// **沉淀是服务端的 job,不是本地跑 skill**(契约 §2):`POST /projects/{id}/condense` 建一条
// condense job,执行器拉项目快照 zip、跑 kb-condense、产出草稿进知识库。客户端只负责发起、
// 显示进度、把草稿领回来给人改。这一点必须守住:知识过期检测、`recondense`、网页那个
// 「建议沉淀」列表全挂在这条链上,客户端另跑一份会分叉成两种质量的知识。

/// `GET /jobs/{id}` / `POST /projects/{id}/condense` 回的任务对象(契约 §2,只取客户端用得上的字段)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: RemoteId,
    /// `condense` / `feishu_import` / …
    #[serde(default)]
    pub r#type: Option<String>,
    pub status: JobStatus,
    #[serde(default)]
    pub project_id: Option<RemoteId>,
    /// 0-100;服务端没给就当还没开始
    #[serde(default)]
    pub progress: Option<u32>,
    /// 执行器写的一句人话(「正在拉取快照」之类)
    #[serde(default)]
    pub message: Option<String>,
    /// 失败原因。**原样保留**,这是用户唯一能据以行动的东西
    #[serde(default)]
    pub error: Option<String>,
    /// 成功时的结果;condense 的形状见 `CondenseResult`
    #[serde(default)]
    pub result: Option<CondenseResult>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum JobStatus {
    Pending,
    Claimed,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    /// 夜间扫描建议的沉淀,等人批准才进队列(契约 §6.8)。客户端「主动提」读的就是它
    Proposed,
}

impl JobStatus {
    /// 还在路上(值得继续轮询)。
    pub fn is_live(self) -> bool {
        matches!(self, JobStatus::Pending | JobStatus::Claimed | JobStatus::Running)
    }
}

/// condense 成功后的结果(契约 §2)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CondenseResult {
    pub knowledge_file_id: RemoteId,
    #[serde(default)]
    pub knowledge_title: Option<String>,
    #[serde(default)]
    pub sources_linked: Option<u32>,
    /// 网页上打开这份草稿的地址 —— 本地还没同步到那个知识库项目时的退路
    #[serde(default)]
    pub human_url: Option<String>,
}

/// 沉淀前的对账结果:**这个项目还有什么没上云**。
///
/// 为什么必须有:执行器拉的是**云端**的 zip。他刚干完的活如果还没同步上去,沉淀就是在旧内容
/// 上跑 —— 产出一份看起来没问题、实际漏了今天全部工作的草稿。**这比失败更糟**:失败看得见,
/// 而这个看不见(2026-09-07)。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UnsyncedSummary {
    /// 还没传上去的文件数(等着传的 + 传失败的)
    pub pending: u32,
    /// 其中传失败、需要人处置的
    pub failed: u32,
    /// 具体是哪些(云端相对路径,最多列 20 条 —— 用户要的是「哪几个」,不是一张长清单)
    pub paths: Vec<String>,
}

/// `GET /client/config`(契约 §6.16)—— 登录后问一次,把该由服务端说了算的东西拿回来。
///
/// 老板原话:「配置的时候我认为只需要配置 token 就可以了」。300 个人手工粘三个地址一定会
/// 出错 —— 已经被坑过一次(中继地址填成带 `/collab` 的,协同全废了大半天)。
///
/// 所有字段都可空:老服务端根本没有这个接口,新服务端也可能只配了一半。**拿不到不能让登录
/// 失败**,安静回落到本地那套就是了。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientConfig {
    /// 协同中继根地址(不带 `/collab`,房间路径由客户端拼)。
    /// **空 = 服务端没配中继** → 禁用协同并提示管理员,契约明写「不要回落到猜一个地址」
    #[serde(default)]
    pub collab_relay_url: Option<String>,
    /// 网页端地址(打开文件 / 分享链接用)
    #[serde(default)]
    pub web_base_url: Option<String>,
    #[serde(default)]
    pub server_version: Option<String>,
    /// 自动下载阈值的**服务端默认值**(不是配置,客户端可改)
    #[serde(default)]
    pub large_file_threshold_bytes: Option<u64>,
    /// 单文件上行上限(字节),服务端的硬上限。**0 = 不设限**;老服务端不给 → None,回落内置默认
    #[serde(default)]
    pub max_upload_bytes: Option<u64>,
    /// 特性开关。现在一个都没用上,但**解析时保留** —— 以后加开关不必再改一遍两边
    #[serde(default)]
    pub features: std::collections::HashMap<String, bool>,
}

/// `POST /sessions/archive` 的响应(V61)。
///
/// 落点由**服务端**决定:带 `projectId` → 该项目的 `session/`;不带 → 调用者个人知识库的
/// `session/`。文件打 `content_kind='SESSION'` 并强制 cloudOnly,不进 snapshot / changes,
/// 所以永远不会同步到任何人的笔记本上。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionArchive {
    pub file_id: RemoteId,
    #[serde(default)]
    pub version_id: Option<RemoteId>,
    pub project_id: RemoteId,
    #[serde(default)]
    pub project_name: Option<String>,
    /// 固定为 `session/<文件名>`
    pub path: String,
    /// 对话的稳定身份 —— 同一段对话续写用同一个,服务端据此做幂等 / 出新版本
    pub session_id: String,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub created: bool,
    #[serde(default)]
    pub deduplicated: bool,
    #[serde(default)]
    pub cloud_only: bool,
    /// true = 落在了调用者的个人空间(请求没带 projectId)
    #[serde(default)]
    pub personal: bool,
}

/// 「磁盘占用排名」的一条:一个项目占了多少。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsageProject {
    pub project_id: RemoteId,
    pub name: String,
    pub drive_path: String,
    pub local_path: String,
    pub bytes: u64,
    pub files: u32,
}

/// 「磁盘占用排名」的一条:一个文件占了多少。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsageFile {
    pub project_id: RemoteId,
    pub project_name: String,
    /// 项目内的云端相对路径
    pub path: String,
    pub local_path: String,
    pub bytes: u64,
}

/// 本地云盘占了多少、都被谁占了。
///
/// **看不见就管不了**:真机上 2.9 GB 里 2.69 GB 是一个人目录下的原始数据表(1848 个文件),
/// 真正的文档加起来才几兆 —— 不把这个摆出来,没人会想到问题出在「原始数据跟着文档一起下来了」。
///
/// 数字取自索引(每行都记着 size),不去遍历磁盘:几千个文件 stat 一遍会让设置页卡住,
/// 而索引里的 size 就是那份文件的字节数。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    pub total_bytes: u64,
    pub total_files: u32,
    /// 占用最多的项目,从多到少
    pub projects: Vec<DiskUsageProject>,
    /// 占用最多的单个文件,从多到少
    pub files: Vec<DiskUsageFile>,
}

/// 「重新核对仅云端文件」的结果。
///
/// 为什么需要这个动作:`cloudOnly` 是**分类**不是内容。服务端把一批文件从 cloudOnly 改判成
/// 正常(2026-09-05:「需走修改申请」的文件此前被误判成 cloudOnly),这些文件本身一个字节
/// 都没变,于是不会产生任何 `file_events` —— 走 cursor 增量的客户端**永远**收不到通知,
/// 已经同步过的机器会一直守着 111 个 `.yupcloud` 占位。只有拿 snapshot 整批重新比一遍分类
/// 才能追上。反向(权限被收回 → 变成 cloudOnly)同理,而且那一侧是安全要求。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CloudOnlyRecheck {
    /// 服务端已不再标 cloudOnly:真实内容已拉到本地、`.yupcloud` 占位已删
    pub restored: u32,
    /// 服务端新标成 cloudOnly:本地内容已从盘上删掉、换成 `.yupcloud` 占位
    pub hidden: u32,
    /// 分类没变,但盘上那个 `.yupcloud` 占位不见了(正文本来就不该有)→ 已把占位补回来。
    ///
    /// 这不是小事:一份 cloudOnly 文件在盘上的正确终态是**只有占位、没有正文**。占位也没了的话,
    /// 它所在的目录就成了空目录,用户看到的是「这个文件夹里什么都没有」而不是「这些文件只能在
    /// 云端看」—— 真机上 111 个占位全部消失、索引里还留着 38 条 cloudOnly、盘上多出 149 个空
    /// 目录(2026-09-05)。
    pub repaired: u32,
    /// 云端有、这边**索引和盘上都没有**的文件 → 已经重新登记成「尚未下载」。
    ///
    /// 这不是分类漂移,是下行漏了:一次下载失败之后 cursor 已经往前走,那条 change 事件不会
    /// 再来第二次,而索引里连一行都没有 —— 这份文件就此人间蒸发,服务端日后修好也不会自愈。
    /// 2026-09-07 老板机器上那批下不完的大文件正卡在这个形状里。开机核对顺路把它们登记回来,
    /// 之后按阈值与退避决定是自动拉、还是留个占位等他点。
    pub relisted: u32,
    /// 这一轮实际取过 snapshot 比对的项目数
    pub projects: u32,
}

impl CloudOnlyRecheck {
    pub fn is_empty(&self) -> bool {
        self.restored == 0 && self.hidden == 0 && self.repaired == 0 && self.relisted == 0
    }
}

// ─── 6.18 权限档位与协作者 ───────────────────────────────────────────────────

/// 档位接口**收**的主体类型。ROLE / TEAM / LINK_COMPANY 留给管理后台的规则接口,这里不收;
/// 但列表里会出现它们的只读行,所以 `Grant::subject_type` 是开放的字符串,不是这个枚举。
/// `All` 的 `subjectId` 传 0。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GrantSubjectType {
    User,
    Dept,
    All,
}

/// 档位:一个主体在一个资源上的 ALLOW 动作集合的具名投影。**不是第二个判权维度**,
/// 只在写入和显示时存在。`Custom` = 有 DENY 行或集合不等于三档之一,只读显示,不能从档位接口写。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GrantLevel {
    View,
    Edit,
    Manage,
    Custom,
}

/// 这一行来自哪一层。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GrantSource {
    File,
    Folder,
    Space,
}

/// 档位接口作用在哪种资源上:文件与目录各一套路径,形状完全相同。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GrantResourceKind {
    File,
    Folder,
}

/// 右键那一行对应的云端资源。目录靠 `POST /folders/ensure` 换 id(索引里只记目录路径不记 id)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GrantTarget {
    pub kind: GrantResourceKind,
    pub id: RemoteId,
}

/// `GET .../grants` 的一行:一主体一行,同一主体多层有行时只列真正生效的那一层。
///
/// 服务端还带 `effective` / `overriddenBy`(与规则列表同口径),面板用不着,解析时不收。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    /// **开放枚举**:除 USER / DEPT / ALL 外还会有 ROLE / TEAM / LINK_COMPANY 的只读行(服务端 fe8485d),
    /// 认不出的一律按只读画。能不能画操作按钮看 `editable`,不看这个也不看 `level`
    pub subject_type: String,
    pub subject_id: RemoteId,
    #[serde(default)]
    pub subject_display: Option<String>,
    pub level: GrantLevel,
    /// CUSTOM 时靠它解释;其余档位也带
    #[serde(default)]
    pub actions: Vec<String>,
    #[serde(default)]
    pub source: Option<GrantSource>,
    #[serde(default)]
    pub source_resource_id: Option<RemoteId>,
    #[serde(default)]
    pub source_display: Option<String>,
    /// source != 本资源。继承来的不能在这一层删,只能去源头改
    #[serde(default)]
    pub inherited: bool,
    /// 直接行且调用者有 MANAGE_PERMISSION 才 true
    #[serde(default)]
    pub editable: bool,
}

/// 项目角色带来的隐含权限(管理员 / 所有者),`grants` 里不造行,另列一段。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImplicitGrant {
    #[serde(default)]
    pub subject_display: Option<String>,
    pub level: GrantLevel,
    /// `PROJECT_MANAGER | OWNER | FOLDER_CREATOR | GLOBAL_ADMIN`(服务端 fe8485d);认不出的按「隐含权限」画
    #[serde(default)]
    pub reason: Option<String>,
}

/// `GET .../grants` 的响应:顶层是对象不是数组。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GrantList {
    #[serde(default)]
    pub grants: Vec<Grant>,
    #[serde(default)]
    pub implicit: Vec<ImplicitGrant>,
    /// 调用者自己在此资源的档位。**不是 MANAGE 就整个面板只读,不画添加区**。
    /// 服务端没给 → None,按只读处理(宁可少画一个入口,也不给一个点了会 403 的)
    #[serde(default)]
    pub caller_level: Option<GrantLevel>,
}

/// `POST .../grants`:幂等的「设成这个档位」,不是「追加一条」。再 POST 同一主体 = 改档位。
/// `Custom` 不能写(服务端会拒),前端也不给选。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SetGrantRequest {
    pub subject_type: GrantSubjectType,
    pub subject_id: RemoteId,
    pub level: GrantLevel,
}

/// 409 `INHERITED_GRANT` 带回来的「这条行在哪一层」:`{source, resourceId, projectKey, display}`,
/// 在响应体**顶层**(服务端 fe8485d)。每个都可空 —— 缺了也只是引导语少一截,不能让删除整个报错。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InheritedFrom {
    #[serde(default)]
    pub source: Option<GrantSource>,
    #[serde(default)]
    pub resource_id: Option<RemoteId>,
    #[serde(default)]
    pub project_key: Option<String>,
    #[serde(default)]
    pub display: Option<String>,
}

/// `POST` / `DELETE .../grants` 的三种结局。后两种是**规则不是故障**,所以不走 `Err`:
/// - `Inherited`(只有 DELETE):该主体在此资源上只有继承来的行 → 引导去源头改。服务端明说
///   「不能在子节点静默造一条 DENY 去抵消」;
/// - `Custom`(POST / DELETE 都有):该主体有直接 DENY 行 → 档位接口不碰,去网页管理后台改。
///
/// `Applied` 带回来的就是 GET 同一个对象(服务端 fe8485d),直接拿它刷新列表,不必再 GET 一趟。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum GrantWriteOutcome {
    Applied { list: GrantList },
    Inherited { inherited_from: InheritedFrom },
    Custom,
}

// ─── 「分享给我的」(服务端 GrantService#sharedWithMe) ────────────────────────

/// `GET /folders/{id}` 里我们要的那点东西。
///
/// 只为一件事存在:`/shared-with-me` 给了 `projectId` 却**不给路径**,而桌面端要把人送到
/// 本地那个目录,不知道它在项目里的哪一层就只能停在项目根(网页端正是停在那儿,见
/// `pages/shared/index.vue` 的「打开所在项目」)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    #[serde(default)]
    pub id: Option<RemoteId>,
    #[serde(default)]
    pub project_id: Option<RemoteId>,
    /// 数据库里形如 `/a/b/`(首尾都有斜杠);项目根是 `/`。用 `rel_path()` 转成契约那套相对路径
    #[serde(default)]
    pub full_path: Option<String>,
}

impl FolderInfo {
    /// `/a/b/` → `a/b`;`/` 或缺省 → 空串(项目根)。
    ///
    /// 与服务端 `SyncPaths.folderRelPath` 同一套规则。**斜杠必须两头都削**:留着首斜杠去
    /// `PathBuf::join` 的话,在 Unix 上得到的是 `/a/b` 这个绝对路径 —— 项目根被整个丢掉,
    /// 人被送到磁盘根目录下一个不存在的地方。
    pub fn rel_path(&self) -> String {
        let raw = self.full_path.as_deref().unwrap_or_default().replace('\\', "/");
        raw.trim_matches('/').to_string()
    }
}

/// `GET /shared-with-me` 的一行:**直接授给本人**的一个文件或目录。
///
/// 口径是服务端定的(`GrantService#sharedWithMe`):只有 USER 主体的直接授权,部门 / 全公司
/// 的集体授权不算 —— 那是底权限不是「分享给我」,三百人共有的东西列进来这个视图第一天就没法看。
/// 已删除的资源服务端已经跳过。
///
/// 末尾两个字段**服务端不返回,是引擎补的**(见 `Engine::shared_with_me`):服务端那条记录只说
/// 「哪个资源、在哪个项目」,而桌面端要回答的是「它在我这台机器的哪个路径」。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SharedItem {
    /// `FILE` | `FOLDER`。与 §6.18 档位接口的资源种类同一个枚举,拿它能直接拼出 `GrantTarget`
    pub resource_type: GrantResourceKind,
    pub resource_id: RemoteId,
    pub name: String,
    /// 理论上可空(资源行的 `projectId` 为 null)。没有项目就无处可去,行仍然列出来但点不动
    #[serde(default)]
    pub project_id: Option<RemoteId>,
    #[serde(default)]
    pub project_name: Option<String>,
    /// VIEW / EDIT / MANAGE;动作集合凑不成三档之一时服务端给 CUSTOM
    pub level: GrantLevel,
    #[serde(default)]
    pub granted_by_name: Option<String>,
    /// ISO 时间串。**不解析成时间类型**:只用来显示,而各版本服务端的格式未必一致
    #[serde(default)]
    pub granted_at: Option<String>,
    /// 引擎补:FOLDER 行在项目里的相对路径(`GET /folders/{id}` 的 `fullPath` 归一化);
    /// FILE 行与查不到时为 null
    #[serde(default)]
    pub folder_path: Option<String>,
    /// 引擎补:这条在本地磁盘上的绝对路径。**不保证已经存在** —— 项目还没同步下来时它是
    /// 「同步完会落在哪」,前端据此在拉取完成后定位;项目不在索引里(见 `Engine::shared_with_me`)
    /// 则为 null
    #[serde(default)]
    pub local_path: Option<String>,
}

/// 拍平之后的一条云端目录:项目内相对路径 + 服务端 id。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CloudFolder {
    /// 项目内相对路径,例如 `01_用户增长/02_增长策略_Wee`
    pub path: String,
    pub folder_id: RemoteId,
}
