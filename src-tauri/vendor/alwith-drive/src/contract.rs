//! Public Drive requests, responses and events, the one source for both sides: the private
//! `alwith-drive-impl` crate compiles this file too. No business logic and no Tauri dependency.
use crate::types::*;
use serde::{Deserialize, Serialize};
use specta::Type;

/// The compatibility generation. 2: `recheckCloudOnly` answers its counts instead of `done`.
pub const CONTRACT_VERSION: u32 = 2;

#[derive(Deserialize, Type, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AccessRequestType {
    FileAccess,
    ProjectJoin,
}

#[derive(Serialize, Type, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AccessRequestOutcome {
    Submitted,
    AlreadyPending,
}

#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub version: u32,
    pub generation: u32,
    pub sequence: u32,
    pub configured: bool,
    pub running: bool,
    pub base_url: String,
    pub local_root: String,
    pub web_base_url: Option<String>,
    pub status: Option<StatusSnapshot>,
    pub roots: Vec<RootInfo>,
    pub pending_deletes: Vec<PendingDeletes>,
    pub files: Vec<FileStateEvent>,
    pub projects: Vec<ProjectProgress>,
    pub error: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
pub enum Payload {
    Snapshot(Snapshot),
    Status(StatusSnapshot),
    File(FileStateEvent),
    Project(ProjectProgress),
    Conflict(ConflictRecord),
    ReadOnly(ReadOnlyChange),
    Changed(Vec<String>),
    Reconcile,
    Comment(CommentEvent),
    /// A cloud-only recheck changed files: restored, hidden, repaired or relisted counts.
    CloudOnly(CloudOnlyRecheck),
    /// The native session archive started or finished a round (`syncing`).
    Archive(ArchiveStatus),
    Error(String),
}

/// A Drive change. `generation` and `sequence` order events; a snapshot resets both.
#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DriveEvent {
    pub version: u32,
    pub generation: u32,
    pub sequence: u32,
    pub payload: Payload,
}

#[derive(Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommentEvent {
    pub file_id: RemoteId,
    pub comment_id: RemoteId,
    pub action: String,
    pub actor_id: Option<RemoteId>,
    pub at: Option<String>,
}

#[derive(Serialize, Type, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Configuration {
    pub device_id: Option<String>,
    pub user_name: Option<String>,
    pub user_id: Option<String>,
    pub client_config: Option<ClientConfig>,
}

#[derive(Serialize, Type, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabSession {
    pub file_id: RemoteId,
    pub server_url: String,
    pub room: String,
    pub token: String,
    pub can_write: bool,
}

#[derive(Serialize, Type, Deserialize)]
pub struct McpHeader {
    pub name: String,
    pub value: String,
}

/// The result of moving items into a cloud folder that has not landed locally.
#[derive(Serialize, Type, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudMove {
    /// How many sources moved, in order.
    pub moved: u32,
    /// The error that stopped the remaining sources.
    pub error: Option<String>,
}

/// Local server settings for servers that do not publish them through their client
/// configuration. Addresses apply only while the server's configuration was not fetched; the
/// numeric limits are preferences (`maxUploadMb` yields to a server limit).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Type, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerOverrides {
    /// Web address for "open in browser" links.
    #[serde(default)]
    pub web_base_url: Option<String>,
    /// Collaboration relay: a host, an http(s) or a ws(s) address, with or without `/collab`.
    #[serde(default)]
    pub collab_relay_url: Option<String>,
    /// Concurrent file transfers, 1 to 64.
    #[serde(default)]
    pub transfer_concurrency: Option<u32>,
    /// Upload limit per file in MB when the server publishes none; 0 means unlimited.
    #[serde(default)]
    pub max_upload_mb: Option<u64>,
}

#[derive(Serialize, Type, Deserialize)]
pub struct McpSessionConfig {
    pub url: String,
    pub headers: Vec<McpHeader>,
}

#[derive(Deserialize, Type, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DriveRequest {
    Preferences,
    ArchivePrivateSessions,
    SetArchivePrivate {
        session_id: String,
        private: bool,
    },
    SetPreferences {
        session_archive: bool,
        knowledge_inject: bool,
    },
    ArchiveSession {
        expected_generation: u32,
        session_id: String,
        cwd: String,
        title: String,
        updated_at: String,
        content: String,
    },
    Configuration,
    Reconfigure {
        local_root: String,
        user_name: String,
    },
    RefreshClientConfig,
    ServerOverrides,
    SetServerOverrides {
        overrides: ServerOverrides,
    },
    McpSessionConfig,
    RetryUpload {
        project_id: RemoteId,
        path: String,
    },
    CloudFolders {
        project_id: RemoteId,
    },
    FileRemoteId {
        path: String,
    },
    CommentContext {
        path: String,
    },
    Comments {
        file_id: RemoteId,
    },
    CommentCreate {
        file_id: RemoteId,
        request: CreateCommentRequest,
    },
    CommentUpdate {
        comment_id: RemoteId,
        body: String,
    },
    CommentDelete {
        comment_id: RemoteId,
    },
    CommentApply {
        comment_id: RemoteId,
    },
    CommentWatch {
        owner_id: String,
        file_ids: Vec<RemoteId>,
    },
    CollabSession {
        path: String,
        owner_id: String,
    },
    CollabEnd {
        path: String,
        owner_id: String,
    },
    CondensePreflight {
        project_id: RemoteId,
        scope_path: Option<String>,
    },
    CondenseStart {
        project_id: RemoteId,
        scope_path: Option<String>,
    },
    Job {
        job_id: RemoteId,
    },
    ProposedCondense {
        project_id: RemoteId,
    },
    ApproveJob {
        job_id: RemoteId,
    },
    CancelJob {
        job_id: RemoteId,
    },
    KnowledgeContext {
        cwd: String,
    },
    SkillMirrors,
    ArchiveStatus,
    /// Run a native session archive round now; requires the host's session directory.
    ArchiveSyncNow,
    SyncProject {
        project_id: RemoteId,
    },
    Snapshot,
    PublishBetweenProjects {
        source: String,
        destination: String,
        is_directory: bool,
    },
    MoveBetweenProjects {
        source: String,
        destination: String,
    },
    /// Move Drive items into a Drive folder that has not landed locally; the server moves them
    /// with their identity and the local copies leave with the next synchronization.
    MoveToCloudDirectory {
        sources: Vec<String>,
        directory: String,
    },
    Login {
        base_url: String,
        token: String,
        local_root: String,
    },
    SsoConfig {
        base_url: String,
    },
    SsoLogin {
        base_url: String,
        local_root: String,
    },
    ResolveRootOwnership {
        generation: u32,
        accept: bool,
    },
    Logout,
    Start,
    Stop,
    MaxAutoDownloadMb,
    SetMaxAutoDownloadMb {
        megabytes: u64,
    },
    Pause {
        paused: bool,
    },
    Sync,
    Roots,
    Pin {
        project_id: RemoteId,
        pinned: bool,
    },
    /// 用户显式开/关某个库的同步(本地 opt-out)。关掉时优先于一切自动判据,
    /// 给 admin 这类「看得到全公司但不想全拉」的人用。
    SetExcluded {
        project_id: RemoteId,
        excluded: bool,
    },
    /// 一键解决一个同步冲突。`keep_local`:true=用我的(冲突副本写回、下一轮上传),
    /// false=用云端(保留已落盘的远端版本)。两种都删掉冲突副本、从面板移除该冲突。
    ResolveConflict {
        project_id: RemoteId,
        path: String,
        keep_local: bool,
    },
    Land {
        project_id: RemoteId,
    },
    File {
        path: String,
    },
    Download {
        project_id: RemoteId,
        path: String,
    },
    ConfirmDeletes {
        project_id: RemoteId,
    },
    CancelDeletes {
        project_id: RemoteId,
    },
    Templates,
    Departments,
    CreateProject {
        request: CreateProjectFromTemplateRequest,
    },
    Shared,
    FailedUploads,
    RetryUploads,
    Reconcile {
        project_id: Option<RemoteId>,
    },
    RecheckCloudOnly,
    DiskUsage {
        limit: u32,
    },
    CleanupScan,
    Cleanup {
        paths: Vec<String>,
    },
    OwnershipGuard,
    SyncAllPersonal {
        enabled: bool,
    },
    GrantTarget {
        path: String,
    },
    Grants {
        target: GrantTarget,
    },
    SetGrant {
        target: GrantTarget,
        request: SetGrantRequest,
    },
    RemoveGrant {
        target: GrantTarget,
        subject_type: String,
        subject_id: RemoteId,
    },
    SearchUsers {
        query: String,
        /// At most this many users, 1 to 50; 20 when absent.
        #[serde(default)]
        limit: Option<u32>,
    },
    SearchDepartments {
        query: String,
    },
    RequestAccess {
        request_type: AccessRequestType,
        target_id: RemoteId,
        message: Option<String>,
    },
    SaveVersion {
        path: String,
    },
    LocalPath {
        file_id: RemoteId,
    },
}

#[derive(Serialize, Type, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
pub enum DriveResponse {
    RootOwnershipConfirmation {
        generation: u32,
        #[serde(rename = "localRoot")]
        local_root: String,
    },
    ArchivePrivateSessions(Vec<String>),
    Preferences(Preferences),
    Configuration(Configuration),
    ClientConfig(ClientConfig),
    ServerOverrides(ServerOverrides),
    CloudMove(CloudMove),
    CloudOnlyRecheck(CloudOnlyRecheck),
    McpSessionConfig(Option<McpSessionConfig>),
    CloudFolders(Vec<crate::types::CloudFolder>),
    CommentContext(Option<CommentContext>),
    Comments(Vec<FileComment>),
    Comment(FileComment),
    CollabSession(Option<CollabSession>),
    Unsynced(UnsyncedSummary),
    Job(Job),
    Jobs(Vec<Job>),
    Text(Option<String>),
    SkillMirrors(Vec<SkillMirror>),
    ArchiveStatus(ArchiveStatus),
    Count(u32),
    MaxAutoDownloadMb(u64),
    Snapshot(Snapshot),
    SsoConfig(SsoConfig),
    Roots(Vec<RootInfo>),
    Root(RootInfo),
    File(Option<FileStateEvent>),
    Templates(Vec<ProjectTemplate>),
    Departments(Vec<Department>),
    Shared(Vec<SharedItem>),
    FailedUploads(Vec<FailedUpload>),
    DiskUsage(DiskUsage),
    Cleanup(CleanupReport),
    OwnershipGuard(OwnershipGuard),
    GrantTarget(Option<GrantTarget>),
    Grants(GrantList),
    GrantWrite(GrantWriteOutcome),
    Users(Vec<UserBrief>),
    AccessRequest(AccessRequestOutcome),
    Id(Option<RemoteId>),
    Path(Option<String>),
    Done,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub session_archive: bool,
    pub knowledge_inject: bool,
}

/// Where the previous ALwith Desktop Drive kept a profile: the `drive` named store (flat JSON with
/// `baseUrl`, `token`, `deviceId`, `localRoot`, `userName`), Desktop's `settings.json` (its
/// `drive.*` keys) and the engine index. Imported once, when the service has no profile file yet.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LegacyDesktopProfile {
    pub store: std::path::PathBuf,
    pub settings: Option<std::path::PathBuf>,
    pub index: std::path::PathBuf,
}
