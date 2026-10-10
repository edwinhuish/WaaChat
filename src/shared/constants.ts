/**
 * 主进程与渲染进程共享的常量。
 *
 * 本文件必须保持**无副作用**、不导入 electron、不访问文件系统 —— 渲染进程侧的
 * typecheck（tsconfig.web.json）也会编译它。
 */

/**
 * 被承载的上游页面。
 *
 * 这是一个**功能端点**，不是品牌资产。[INV-4] 约束的是应用自身身份
 * （包名 / 可执行文件名 / appId / 图标 / 桌面条目），不禁止代码中出现我们
 * 必须访问的服务地址 —— 否则这个项目在逻辑上无法成立。
 */
export const UPSTREAM_URL = 'https://web.whatsapp.com'

/**
 * 用于权限白名单的来源判断。
 *
 * "上游域"的完整判据（站内 / 站外、权限来源）在 [`./upstream.ts`](./upstream.ts) ——
 * 那里解释了两者为什么**不是**同一个答案。
 */
export const UPSTREAM_ORIGIN = 'https://web.whatsapp.com'

/**
 * 面向用户的应用名。
 *
 * 与 `electron-builder.yml` 的 `productName`、用户级 `.desktop` 条目的 `Name=` 是同一个值，
 * 出现在窗口标题与托盘菜单里。命名实例在后面追加一个全角括号后缀
 * （`shared/instance.ts` 的 `instanceLabelOf`），因此这里只放**基名**。
 */
export const APP_DISPLAY_NAME = 'WaaChat'

/**
 * 桌面条目文件名。必须与以下三处保持一致：
 *   - package.json            → desktopName
 *   - electron-builder.yml    → linux.desktop.entry.StartupWMClass
 *   - src/main/index.ts       → app.setDesktopName()
 * 不一致的后果是 Dock 显示占位图标、启动器与运行窗口不合并。
 * `pnpm run verify` 会断言这一项。
 */
export const DESKTOP_FILE_NAME = 'io.github.edwinhuish.waachat.desktop'

/** 与 DESKTOP_FILE_NAME 同源，但不带 `.desktop` 后缀（用于 StartupWMClass 对照）。 */
export const APP_ID = 'io.github.edwinhuish.waachat'

/** 归档目录中临时文件的前缀。启动时会清扫，见 archive/blobs.ts。 */
export const TEMP_FILE_PREFIX = '.part-'

/**
 * 内核层接管的硬约束。容量上限**不在这里**：它是用户可改的设置
 * （`Settings.archiveMaxBytes` / `Settings.cacheMaxBytes`，默认值见 `DEFAULT_SETTINGS`），
 * 超限时的行为见 `docs/media-capture.md` 第 3 节与 [ADR-0048] / [ADR-0049]。
 *
 * 这里曾经有一份同值的 `cacheBytes`，但**一个读者都没有** —— 两个常量说同一件事，
 * 改动时必然漏一个。删除由 ADR-0049 一并记录。
 */
export const LIMITS = {
  /** 单次接管的文件大小上限，超过则退回原生下载（避免误吞超大文件）。 */
  captureFileBytes: 4 * 1024 * 1024 * 1024,
} as const

/** 日志中允许出现的字段长度上限，防止把完整内容写进日志（INVARIANTS G-3）。 */
export const LOG_HASH_PREFIX_LENGTH = 12
