// 「应用扩展 → 组件 → 飞书 CLI」。
//
// 这里是两个彼此独立的模块，用两张卡承载，不再混在一张卡里：
//   A 组件：二进制是否安装、装在哪、什么版本、检查 / 执行更新。
//   B 飞书账号：本人（user）OAuth 登录态、资料卡、权限清单与补授权。
//
// 为什么必须分开：`auth status --json` 里的 bot 是**应用级凭证**——由 `lark-cli config init`
// 在浏览器引导创建飞书企业自建应用，把 appId + appSecret 存进 ~/.lark-cli/config.json
// （appSecret 进 Keychain），CLI 用它换 tenant_access_token。`auth logout` 只清本人 token，
// bot 仍然 ready。混在一张卡里，用户退出后会看到「机器人身份已开通」和一整块权限清单，
// 误以为主账号还登录着。所以 B 卡只认一个判据：user identity 是否 available。
//
// 首次安装还有一个独立状态：此时 `auth status --json` 返回 `ok:false / not_configured` 且
// **exit code 0**，Rust 会把它解析成 `appId=null, identities=[]`。如果不单独识别，界面会
// 显示「已安装 + 未登录」，点登录只会失败，没有任何出口。

import { QRCodeSVG } from "qrcode.react"
import { isTauri } from "@tauri-apps/api/core"
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  LogInIcon,
  LogOutIcon,
  RefreshCwIcon,
  XCircleIcon
} from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { commands, type LarkAuthIdentity, type LarkAuthLogin, type LarkAuthStatus, type LarkCliStatus, type LarkUpdateCheck, type LarkUserProfile } from "@/bindings"
import { openExternal } from "@/lib/open"

import { SettingRow, SettingsCard, SettingsNote } from "./shared"

/**
 * 本集成真正用到的能力 → `lark-cli auth status --json` 里**真实存在**的 scope 名。
 *
 * 旧版用臆想的名字（docs:document:readonly、bitable:app …）去比对，和 CLI 实际授予的
 * （docx:document:readonly / base:record:read …）对不上，于是「必需 0/14」全是假告警。
 * 一组里命中任意一个就认为具备该能力；申请补授权时取该组的第一个 scope。
 * 只用于本人身份：bot 没有 scope 字段，它的权限在飞书开放平台的应用配置里。
 */
const LARK_CAPABILITIES: Array<{ label: string; scopes: string[] }> = [
  { label: "以你的身份发消息", scopes: ["im:message.send_as_user"] },
  { label: "读取消息与群聊", scopes: ["im:message:readonly", "im:chat:read"] },
  { label: "搜索消息", scopes: ["search:message"] },
  { label: "读取云文档", scopes: ["docx:document:readonly", "docs:document.content:read"] },
  { label: "创建 / 编辑云文档", scopes: ["docx:document:write_only", "docx:document:create"] },
  { label: "读取电子表格", scopes: ["sheets:spreadsheet:read", "sheets:spreadsheet.meta:read"] },
  { label: "编辑电子表格", scopes: ["sheets:spreadsheet:write_only"] },
  { label: "多维表格", scopes: ["base:record:read", "base:table:read"] },
  { label: "云空间文件", scopes: ["drive:file:download", "drive:file:upload"] },
  { label: "知识库", scopes: ["wiki:node:read", "wiki:space:read"] },
  { label: "通讯录 / 搜索成员", scopes: ["contact:user.base:readonly", "contact:user:search"] }
]
const CAPABILITY_SCOPES = new Set(LARK_CAPABILITIES.flatMap((entry) => entry.scopes))

/** 首次安装后必须跑一次，且只能在终端跑：它会在浏览器引导创建 / 绑定飞书应用。 */
const CONFIG_INIT_COMMAND = "lark-cli config init --new"
const FEISHU_CLI_DOCS = "https://www.feishu.cn/feishu-cli"

function hasCapability(entry: (typeof LARK_CAPABILITIES)[number], granted: Set<string>): boolean {
  return entry.scopes.some((scope) => granted.has(scope))
}

/** 飞书头像：CDN 拉不到或图片加载失败就退回首字，永远不会留一张破图。 */
function UserAvatar({ name, url }: { name: string; url: string | null | undefined }) {
  const [failed, setFailed] = useState(false)
  if (url && !failed) {
    return (
      <img
        src={url}
        alt=""
        aria-hidden="true"
        className="size-9 shrink-0 rounded-full object-cover ring-1 ring-border"
        onError={() => setFailed(true)}
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary ring-1 ring-border"
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  )
}

/** 飞书 CLI 组件卡 + 飞书账号卡。两张卡共用一个状态源，但各自独立渲染、互不牵连。 */
export function LarkCliCard() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<LarkCliStatus | null>(null)
  const [auth, setAuth] = useState<LarkAuthStatus | null>(null)
  const [update, setUpdate] = useState<LarkUpdateCheck | null>(null)
  const [busy, setBusy] = useState<{ install?: boolean; check?: boolean; update?: boolean; auth?: boolean; logout?: boolean }>({})
  const [login, setLogin] = useState<LarkAuthLogin | null>(null)
  // 本次扫码要补的 scope。空数组 = 普通登录（弹窗标题「登录飞书账号」）；
  // 非空 = 由下方权限勾选链路发起（弹窗标题「申请所需权限」）。两者语义必须分开。
  const [pendingScopes, setPendingScopes] = useState<string[]>([])
  // 二维码由 CLI 的 expires_in 独立倒计时：device-code 是阻塞轮询，等它自己报错要等满 10 分钟。
  const [remaining, setRemaining] = useState<number | null>(null)
  const [pollError, setPollError] = useState<string | null>(null)
  const [waiting, setWaiting] = useState(false)
  // 安装/更新走应用自己的二进制目录，不再依赖 npm / Node.js，无需再读 nodeStatus。
  // 更新成功后留一句持久提示：磁盘上的 CLI 已换，但当前进程仍指向旧版本。
  const [updatedVersion, setUpdatedVersion] = useState<string | null>(null)
  // 头像 / 真实姓名走 contact +get-user，auth status 里只有 userName 和 openId，没有头像。
  const [profile, setProfile] = useState<LarkUserProfile | null>(null)

  const load = useCallback((): void => {
    if (!isTauri()) return
    void Promise.allSettled([commands.larkCliStatus(), commands.larkCliAuthStatus()]).then(
      ([s, a]) => {
        if (s.status === "fulfilled") setStatus(s.value)
        if (a.status === "fulfilled") setAuth(a.value)
        const hasUser =
          a.status === "fulfilled" &&
          a.value.identities.some((identity) => identity.kind === "user" && identity.available)
        if (!hasUser) {
          setProfile(null)
          return
        }
        // 只有本人身份才能查自己的资料；失败也不影响 auth status 里的名称 / openId 展示。
        void commands
          .larkCliUserProfile()
          .then(setProfile)
          .catch(() => setProfile(null))
      }
    )
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // 弹窗一打开就自动发起 device-code 轮询。`auth login --device-code` 会阻塞到用户扫码 /
  // 码过期 / 出错，返回即代表有结果，用户不需要再点「我已完成登录」。
  //
  // 旧实现反过来：先每 3 秒回读 authStatus 等「已登录」，可 token 恰恰要靠 device-code
  // 这一步才落盘 —— 两个条件互相等待，是死锁，所以只能靠用户手点按钮打破。已删除。
  useEffect(() => {
    if (login === null) return
    const deviceCode = login.deviceCode
    let cancelled = false
    setWaiting(true)
    setPollError(null)
    void commands
      .larkCliAuthComplete({ deviceCode })
      .then((result) => {
        if (cancelled) return
        if (result.ok) {
          toast.success(t(pendingScopes.length > 0 ? "support.scopeSuccess" : "support.authSuccess"))
          setLogin(null)
          setPendingScopes([])
          setRemaining(null)
          load()
        } else {
          // CLI 用 {"ok":false} + exit 0 报告过期 / 失效，Rust 已不再把它当成功。
          setPollError(result.message)
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setPollError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!cancelled) setWaiting(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [login?.deviceCode])

  // 独立倒计时，不依赖 CLI 的阻塞返回；归零就把二维码下架并给出重新获取入口。
  useEffect(() => {
    if (login === null) return
    const total = login.expiresIn ?? 600
    const startedAt = Date.now()
    setRemaining(total)
    const timer = setInterval(() => {
      const left = Math.max(0, total - Math.floor((Date.now() - startedAt) / 1000))
      setRemaining(left)
      if (left === 0) clearInterval(timer)
    }, 1000)
    return () => clearInterval(timer)
  }, [login?.deviceCode, login?.expiresIn])

  const install = (): void => {
    if (!isTauri()) return
    setBusy((b) => ({ ...b, install: true }))
    commands
      .larkCliInstall()
      .then((result) => {
        if (result.ok) {
          toast.success(t("support.larkInstallSuccess"))
          setUpdate(null)
          load()
        } else {
          toast.error(result.message)
        }
      })
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy((b) => ({ ...b, install: false })))
  }

  const checkUpdate = (): void => {
    if (!isTauri() || !status?.available) return
    setUpdatedVersion(null)
    setBusy((b) => ({ ...b, check: true }))
    commands
      .larkCliCheckUpdate()
      .then(setUpdate)
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy((b) => ({ ...b, check: false })))
  }

  const updateNow = (): void => {
    if (!isTauri() || !status?.available) return
    setBusy((b) => ({ ...b, update: true }))
    commands
      .larkCliUpdate()
      .then((result) => {
        if (result.ok) {
          const version = update?.latestVersion ?? ""
          setUpdatedVersion(version)
          setUpdate(null)
          load()
          toast.success(t("support.larkUpdateSuccess", { version }))
        } else {
          toast.error(result.message)
        }
      })
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy((b) => ({ ...b, update: false })))
  }

  const startLogin = (scopes: string[] = []): void => {
    if (!isTauri() || !status?.available) return
    setBusy((b) => ({ ...b, auth: true }))
    setPendingScopes(scopes)
    commands
      .larkCliAuthLogin({ scopes })
      .then(setLogin)
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy((b) => ({ ...b, auth: false })))
  }

  /** 过期 / 失败后换一张新码。沿用原来的 mode（登录仍是登录，补授权仍是补授权）。 */
  const refreshLogin = (): void => {
    setPollError(null)
    setRemaining(null)
    setLogin(null)
    startLogin(pendingScopes)
  }

  const logout = (): void => {
    if (!isTauri() || !status?.available) return
    setBusy((b) => ({ ...b, logout: true }))
    commands
      .larkCliAuthLogout()
      .then(() => {
        toast.success(t("support.logout"))
        // 立刻清掉本人态再回读：退出后权限清单、资料卡、bot 状态一起收口。
        setAuth(null)
        setProfile(null)
        load()
      })
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy((b) => ({ ...b, logout: false })))
  }

  const copyConfigCommand = (): void => {
    const clipboard = navigator.clipboard
    if (!clipboard) {
      toast.error(t("support.configCommandCopyFailed"))
      return
    }
    void clipboard
      .writeText(CONFIG_INIT_COMMAND)
      .then(() => toast.success(t("support.configCommandCopied")))
      .catch(() => toast.error(t("support.configCommandCopyFailed")))
  }

  const installed = status?.available ?? false
  // 三值判据：还没确认 / 已登录 / 未登录。绝不拿 `auth.loggedIn`（任一身份 available）推导——
  // 退出后 bot 仍 ready，那正是「权限和状态还在」的根因。
  const authKnown = auth !== null
  // `auth status --json` 在首次安装时返回 `ok:false / not_configured`（exit 0），
  // Rust 会解析成 appId=null、identities=[]。这是「装好了但还没配置应用凭证」。
  const needsAppConfig = authKnown && (auth?.appId ?? null) === null
  const signedInUser =
    auth?.identities.find((identity) => identity.kind === "user" && identity.available) ?? null
  // 真实资料优先，auth status 兜底：头像请求失败时名字和 openid 仍然在。
  const displayName = profile?.name || signedInUser?.userName || t("support.identityUser")
  const displayOpenId = profile?.openId || signedInUser?.openId || ""
  const dialogMode = pendingScopes.length > 0 ? "scopes" : "login"
  const expired =
    remaining === 0 ||
    (pollError !== null && /expir|过期|invalid|超时|timed out/i.test(pollError))

  // bot 是组件级凭证（appId + appSecret），不是账号登录态：状态属于组件卡，主账户退出后
  // 依然如实显示，但不进「飞书账号」卡，措辞也不用「已开通」那种像主账号还登录着的说法。
  const botIdentity = auth?.identities.find((identity) => identity.kind === "bot") ?? null
  const botReady =
    authKnown &&
    !needsAppConfig &&
    (botIdentity?.available ?? false) &&
    botIdentity?.status === "ready"
  const botDescription =
    auth !== null && auth.appId
      ? t("support.botAppId", { id: auth.appId })
      : t("support.botNoApp")

  // B 卡状态行的说明区。加载中 / 退出中都不渲染任何否定性提示，避免闪一下错误态。
  const accountDescription = (() => {
    if (!installed) return <p>{t("support.installFirst")}</p>
    if (!authKnown) return <p>{busy.logout ? t("support.signingOut") : t("support.accountChecking")}</p>
    if (needsAppConfig) {
      return (
        <div className="mt-1 flex flex-col items-start gap-2">
          <p className="text-sm font-medium text-foreground">{t("support.appNotConfiguredTitle")}</p>
          <p>{t("support.appNotConfigured")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded bg-muted px-2 py-1 font-mono text-[11px] text-foreground">
              {CONFIG_INIT_COMMAND}
            </code>
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={copyConfigCommand}
            >
              {t("support.copyCommand")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={load}
            >
              <RefreshCwIcon className="size-3" />
              {t("support.recheck")}
            </Button>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-[11px] text-primary underline-offset-2 hover:underline"
              onClick={() => void openExternal(FEISHU_CLI_DOCS)}
            >
              <ExternalLinkIcon className="size-3" />
              {t("support.officialDocs")}
            </button>
          </div>
        </div>
      )
    }
    if (signedInUser !== null) {
      return (
        <div className="mt-2 flex min-w-0 items-center gap-2.5">
          <UserAvatar
            key={profile?.avatarUrl ?? "initial"}
            name={displayName}
            url={profile?.avatarUrl}
          />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-sm font-medium text-foreground">{displayName}</span>
              <span className="shrink-0 text-[10px] text-emerald-600">{t("support.signedIn")}</span>
            </div>
            {displayOpenId !== "" && (
              <div
                className="truncate font-mono text-[10px] leading-4 text-muted-foreground"
                title={displayOpenId}
              >
                {displayOpenId}
              </div>
            )}
          </div>
        </div>
      )
    }
    return <p>{t("support.notLoggedInHint")}</p>
  })()

  return (
    <>
      {/* ── 模块 A：组件本身。安装路径、版本、更新信息全在「版本」这一框里，
          行与行之间不再手插 divider（原来 .settings-row 自带 border-bottom，
          叠加手写 border-t 就成了截图里那两条线）。 ── */}
      <SettingsCard
        title={t("support.larkTitle")}
        desc={t("support.larkDesc")}
        action={
          <StatusPill ok={installed} label={installed ? t("support.statusInstalled") : t("support.statusNotInstalled")} />
        }
      >
        {/* 与「构建信息 → 引擎 → Codex CLI 0.167.0 [检查更新]」同一套：版本与检查按钮同一行，
            有更新才多出「立即更新」；更新完成后提醒重启。 */}
        <SettingRow compact title={t("support.version")}>
          <div className="flex min-w-0 flex-col items-end gap-1.5">
            <div className="flex flex-wrap items-center justify-end gap-2">
              <span className="text-sm text-muted-foreground">
                {t("support.larkVersion", { version: status?.version ?? "—" })}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 px-2.5 text-xs"
                disabled={!installed || busy.check || busy.update}
                onClick={checkUpdate}
              >
                {busy.check ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon className="size-3.5" />}
                {t("support.checkUpdate")}
              </Button>
              {update?.hasUpdate === true && (
                <Button size="sm" className="h-7 px-2 text-xs" disabled={busy.update} onClick={updateNow}>
                  {busy.update && <Spinner data-icon="inline-start" />}
                  {t("support.updateNow")}
                </Button>
              )}
            </div>
            {update && (
              <div className="flex flex-col items-end gap-1 text-[11px] leading-4 text-muted-foreground">
                <span>
                  {update.hasUpdate
                    ? t("support.updateAvailable", {
                        current: update.currentVersion ?? "?",
                        latest: update.latestVersion ?? "?"
                      })
                    : t("support.upToDate", { version: update.currentVersion ?? status?.version ?? "?" })}
                </span>
                {update.hasUpdate && (
                  <div className="flex flex-wrap items-center justify-end gap-3">
                    {(update.changelog ?? null) !== null && (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 text-[11px] text-primary underline-offset-2 hover:underline"
                        onClick={() => void openExternal(update.changelog ?? "")}
                      >
                        <ExternalLinkIcon className="size-3" />
                        {t("support.changelog")}
                      </button>
                    )}
                    {(update.url ?? null) !== null && (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 text-[11px] text-primary underline-offset-2 hover:underline"
                        onClick={() => void openExternal(update.url ?? "")}
                      >
                        <ExternalLinkIcon className="size-3" />
                        {t("support.releasePage")}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
            {updatedVersion !== null && (
              <span className="text-[11px] leading-4 text-emerald-600">
                {t("support.larkUpdatedRestart", { version: updatedVersion })}
              </span>
            )}
            {/* 安装路径放在右侧控件列，而不是会被 align-items:center 挤压的 desc 第二行。 */}
            {installed && status?.cliPath && (
              <span
                className="block max-w-full truncate font-mono text-[10px] leading-4 text-muted-foreground/70"
                title={status.cliPath}
              >
                {status.cliPath}
              </span>
            )}
          </div>
        </SettingRow>

        {/* 机器人身份是组件凭证，不是账号登录态：放在组件卡里只读展示，主账户退出后依然如实可见。 */}
        {installed && (
          <SettingRow compact title={t("support.botTitle")} desc={botDescription}>
            {auth === null ? (
              <span className="text-xs text-muted-foreground">{t("support.checking")}</span>
            ) : (
              <StatusPill
                ok={botReady}
                label={botReady ? t("support.botReady") : t("support.botNotReady")}
              />
            )}
          </SettingRow>
        )}

        {!installed && (
          <div className="px-4 pb-3 pt-1">
            <SettingsNote>{t("support.larkInstallNote")}</SettingsNote>
            <Button
              size="sm"
              className="mt-1 h-7 px-2 text-xs"
              disabled={busy.install}
              onClick={install}
            >
              {busy.install && <Spinner data-icon="inline-start" />}
              {t("support.install")}
            </Button>
          </div>
        )}
      </SettingsCard>

      {/* ── 模块 B：飞书账号。只认「本人身份是否登录」；退出后权限区整块消失。 ── */}
      <SettingsCard title={t("support.accountTitle")} desc={t("support.accountDesc")}>
        <SettingRow compact title={t("support.authStatus")} desc={accountDescription}>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2.5 text-xs"
            disabled={!installed || !authKnown || needsAppConfig || busy.auth || busy.logout}
            onClick={signedInUser !== null ? logout : () => startLogin()}
          >
            {busy.auth || busy.logout ? (
              <Spinner data-icon="inline-start" />
            ) : signedInUser !== null ? (
              <LogOutIcon className="size-3.5" />
            ) : (
              <LogInIcon className="size-3.5" />
            )}
            {signedInUser !== null ? t("support.logout") : t("support.login")}
          </Button>
        </SettingRow>

        {/* 权限清单的唯一入口，也只在主账户登录后才存在。授权全部走这里的勾选链路。
            不要再手插 divider：.settings-row 自带 border-bottom，叠加 border-t
            就是上一版截图里那两条贴在一起的线。 */}
        {signedInUser !== null && (
          <>
            <div className="px-4 pt-3">
              <div className="text-sm leading-5 font-medium">{t("support.permissions")}</div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("support.identityHelp")}</p>
            </div>
            <UserPermissions identity={signedInUser} onRequestScopes={startLogin} />
          </>
        )}
      </SettingsCard>

      <AuthDialog
        login={login}
        mode={dialogMode}
        scopes={pendingScopes}
        remaining={remaining}
        expired={expired}
        waiting={waiting}
        error={pollError}
        onRefresh={refreshLogin}
        onCancel={() => {
          setLogin(null)
          setPendingScopes([])
          setPollError(null)
          setRemaining(null)
        }}
      />
    </>
  )
}

/**
 * 本人身份的权限清单，默认折叠成一行摘要；点开才展开明细。
 * 只有主账户已登录时才会渲染——权限数据来自本人 OAuth token，token 清掉后再列 scope
 * 就是展示过期数据。机器人身份不在这里出现：它的权限在飞书开放平台，本机没有 scope。
 */
function UserPermissions({
  identity,
  onRequestScopes
}: {
  identity: LarkAuthIdentity
  onRequestScopes: (scopes: string[]) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [showExtras, setShowExtras] = useState(false)
  const [checked, setChecked] = useState<string[]>([])
  const granted = new Set(identity.scopes)
  const capabilities = LARK_CAPABILITIES.map((entry) => ({
    ...entry,
    granted: hasCapability(entry, granted)
  }))
  const grantedCount = capabilities.filter((entry) => entry.granted).length
  const missingCount = capabilities.length - grantedCount
  const extras = identity.scopes.filter((scope) => !CAPABILITY_SCOPES.has(scope))
  const missing = checked.filter((scope) => !granted.has(scope))
  const toggle = (scope: string): void =>
    setChecked((previous) =>
      previous.includes(scope) ? previous.filter((entry) => entry !== scope) : [...previous, scope]
    )

  return (
    <div className="px-4 pb-3 pt-2">
      <div className="overflow-hidden rounded-md border border-border/50">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-muted/40"
        >
          {open ? (
            <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="text-sm font-medium">{t("support.permissionSummary")}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="rounded-full bg-muted px-2 py-0.5">
              {t("support.permissionsGrantedCount", { count: granted.size })}
            </span>
            <span className="rounded-full bg-muted px-2 py-0.5">
              {t("support.permissionsRequired", { granted: grantedCount, total: capabilities.length })}
            </span>
          </span>
        </button>
        {open && (
          <div className="border-t border-border/50 px-2.5 py-2">
            <p className="mb-1.5 text-[11px] leading-4 text-muted-foreground">{t("support.scopeHelp")}</p>
            <ul className="divide-y divide-border/40">
              {capabilities.map((entry) => {
                const scope = entry.scopes[0] ?? ""
                return (
                  <li key={scope} className="flex items-center gap-2 py-1.5">
                    {entry.granted ? (
                      <CheckCircle2Icon className="size-4 shrink-0 text-emerald-600" />
                    ) : (
                      <input
                        type="checkbox"
                        className="size-3.5 shrink-0 accent-primary"
                        checked={checked.includes(scope)}
                        onChange={() => toggle(scope)}
                        aria-label={entry.label}
                      />
                    )}
                    <span
                      className={`min-w-0 flex-1 truncate text-sm ${
                        entry.granted ? "text-foreground" : "text-muted-foreground"
                      }`}
                      title={scope}
                    >
                      {entry.label}
                    </span>
                    {!entry.granted && (
                      <span className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-600">
                        {t("support.permissionMissing")}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
            {missingCount === 0 ? (
              <p className="mt-2 text-[11px] text-emerald-600">{t("support.allPermissionsReady")}</p>
            ) : (
              missing.length > 0 && (
                <Button
                  size="sm"
                  className="mt-2 h-7 px-2 text-xs"
                  onClick={() => {
                    onRequestScopes(missing)
                    setChecked([])
                  }}
                >
                  {t("support.requestScopes", { count: missing.length })}
                </Button>
              )
            )}
            {extras.length > 0 && (
              <div className="mt-1.5">
                <button
                  type="button"
                  onClick={() => setShowExtras((v) => !v)}
                  className="flex w-full items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  {showExtras ? (
                    <ChevronDownIcon className="size-3.5" />
                  ) : (
                    <ChevronRightIcon className="size-3.5" />
                  )}
                  {t("support.othersGranted", { count: extras.length })}
                </button>
                {showExtras && (
                  <ul className="mt-1.5 flex flex-wrap gap-1">
                    {extras.map((scope) => (
                      <li
                        key={scope}
                        className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                      >
                        {scope}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
}

/**
 * 扫码弹窗：打开即自动等待结果，用户只需要扫码，没有「我已完成登录」按钮。
 * 倒计时由 expires_in 驱动，归零后二维码下架并给出重新获取入口。
 * 底层 login / 补授权共用 device flow，但标题与说明按 mode 分开。
 */
function AuthDialog({
  login,
  mode,
  scopes,
  remaining,
  expired,
  waiting,
  error,
  onRefresh,
  onCancel
}: {
  login: LarkAuthLogin | null
  mode: "login" | "scopes"
  scopes: string[]
  remaining: number | null
  expired: boolean
  waiting: boolean
  error: string | null
  onRefresh: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  if (login === null) return null
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t(mode === "scopes" ? "support.scopesDialogTitle" : "support.loginDialogTitle")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3 py-2">
          <p className="text-center text-xs leading-5 text-muted-foreground">
            {expired
              ? t("support.qrExpired")
              : mode === "scopes"
                ? t("support.scopesDialogHint", { count: scopes.length })
                : t("support.scanQr")}
          </p>
          {scopes.length > 0 && !expired && (
            <p className="w-full break-all rounded bg-muted/60 px-2 py-1.5 font-mono text-[10px] leading-4 text-muted-foreground">
              {t("support.requestedScopes", { scopes: scopes.join(" ") })}
            </p>
          )}
          {expired ? (
            <div className="flex h-[208px] w-[208px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 text-center">
              <RefreshCwIcon className="size-6 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">{t("support.qrExpiredBadge")}</span>
            </div>
          ) : (
            <div className="rounded-lg bg-white p-3">
              <QRCodeSVG value={login.verificationUrl} size={184} level="M" bgColor="#ffffff" fgColor="#000000" />
            </div>
          )}
          {login.userCode && !expired && (
            <div className="text-center text-xs text-muted-foreground">
              {t("support.userCode")}：<span className="font-mono">{login.userCode}</span>
            </div>
          )}
          {remaining !== null && !expired && (
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {t("support.qrCountdown", { time: formatCountdown(remaining) })}
            </span>
          )}
          {waiting && !expired && (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Spinner data-icon="inline-start" />
              {t("support.waitingForScan")}
            </div>
          )}
          {error !== null && !expired && (
            <p className="w-full break-all rounded bg-amber-500/10 px-2 py-1.5 text-[11px] leading-4 text-amber-600">
              {t("support.qrFailed", { message: error })}
            </p>
          )}
          {!expired && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => void openExternal(login.verificationUrl)}
            >
              <ExternalLinkIcon className="size-3.5" />
              {t("support.openLink")}
            </Button>
          )}
          <div className="flex w-full gap-2">
            <Button variant="outline" size="sm" className="flex-1" onClick={onCancel}>
              {t("support.refresh")}
            </Button>
            {(expired || error !== null) && (
              <Button size="sm" className="flex-1 gap-1.5" onClick={onRefresh}>
                <RefreshCwIcon className="size-3.5" />
                {t("support.qrRefresh")}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
        ok ? "border-emerald-500/30 text-emerald-600" : "border-amber-500/30 text-amber-600"
      }`}
    >
      {ok ? <CheckCircle2Icon className="size-3.5" /> : <XCircleIcon className="size-3.5" />}
      {label}
    </span>
  )
}
