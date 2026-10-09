/**
 * 自定义应用图标：主进程与渲染进程共享的纯逻辑。
 *
 * 三块东西放在这里，理由各不相同：
 *  - **常量**（尺寸、上限、文件名、桌面条目标记）：主进程与界面都要用，且必须一致。
 *  - **裁剪几何**：真正做像素工作的是渲染进程的 canvas（原因见 ADR-0022），但"裁哪一块、
 *    缩到多大"只是算术 —— 抽成纯函数就能在没有 Electron 的环境里单测。
 *  - **桌面条目文本**：它决定启动器图标指向哪里，并带着 INV-4 要求的非官方声明。
 *    拼字符串是纯函数，于是 `scripts/check-capture.ts` 能在离线时断言声明没被漏掉。
 *
 * 本文件不得导入 electron、不得访问文件系统（`ai/CONVENTIONS.md` 第 2 节）。
 */

import type { AppIconFailure } from './types'

/**
 * 产出图标的边长。
 *
 * 512 是 Linux 桌面常用的最高档位（hicolor 主题最高一档就是 512×512），再大只是白占磁盘：
 * 桌面环境会按需要缩到 16～256。只出一个尺寸而不是生成多档，是因为我们写的是**绝对路径**
 * 而不是主题目录 —— 理由见 ADR-0022。
 */
export const APP_ICON_SIZE = 512

/**
 * 源文件大小上限。
 *
 * 选中的图片要整个读进内存、穿过 IPC、再交给解码器，因此必须有上限。8 MiB 足够覆盖
 * 一张 4096×4096 的 PNG，又远低于"把内存吃光"的量级。
 */
export const MAX_SOURCE_ICON_BYTES = 8 * 1024 * 1024

/**
 * 回传 PNG 的大小上限。
 *
 * 512×512 的 PNG 正常在几十到几百 KB。超过这个数说明传进来的不是我们裁剪出的东西，
 * 主进程应当拒绝，而不是照单写盘。
 */
export const MAX_SUBMITTED_ICON_BYTES = 4 * 1024 * 1024

/**
 * 自定义图标在 `userData` 下的文件名。
 *
 * **文件存在与否就是"是否启用自定义图标"的事实源**，不额外写进 `settings.json`：
 * 那样会出现"设置说启用了、文件却不在"的分裂状态，而图标没有第二个消费者。
 */
export const CUSTOM_ICON_FILENAME = 'custom-icon.png'

/**
 * 我们写进 `~/.local/share/applications/` 的那份 `.desktop` 覆盖的标记行。
 *
 * 有它才说明那份文件是本应用生成的。没有它，说明那是用户自己放的同名片条 ——
 * 那种情况下我们**拒绝覆盖**，而不是把人的东西冲掉（`X-` 前缀的键是桌面条目规范允许的）。
 */
export const DESKTOP_ENTRY_MARKER = 'X-WaaChat-Managed=true'

/**
 * 桌面条目的 `Comment=`。
 *
 * 与 `electron-builder.yml` 的 `linux.desktop.entry.Comment` 是同一句话，且**必须继续含
 * 非官方声明**：这份覆盖会取代安装时那份条目，INV-4 的义务跟着一起走。
 */
export const DESKTOP_ENTRY_COMMENT = 'Unofficial personal-use chat shell with a local media vault'

/** 桌面条目的 `Categories=` / `Keywords=`，与 `electron-builder.yml` 保持一致。 */
export const DESKTOP_ENTRY_CATEGORIES = 'Network;InstantMessaging;'
export const DESKTOP_ENTRY_KEYWORDS = 'chat;messenger;media;archive;'

/**
 * 文件对话框里给出的扩展名（Electron 的 `filters[].extensions`，不带点）。
 *
 * 这一列决定"用户看得见哪些文件"，不决定"我们能处理哪些" —— 后者由解码器说了算。
 */
export const ICON_DIALOG_EXTENSIONS = ['png', 'jpg', 'jpeg', 'ico', 'webp', 'bmp'] as const

/**
 * 我们**预期**能解码的扩展名。
 *
 * 解码在渲染进程里由 Chromium 完成，所以这是一份"已知可行"的集合，而不是安全白名单：
 * 对不上只会被提前拒绝，以免把一个明显不是图片的文件穿过 IPC 去解码。
 */
export const ACCEPTED_ICON_EXTENSIONS = [...ICON_DIALOG_EXTENSIONS, 'gif'] as const

/**
 * 小写扩展名；没有扩展名时返回空串。
 *
 * `dot > 0` 这一条是刻意的：`.bashrc` 那类只以点开头的文件名没有扩展名，
 * 而不是"扩展名是 bashrc"。
 */
export function iconExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0 || dot === fileName.length - 1) return ''
  return fileName.slice(dot + 1).toLowerCase()
}

/**
 * 名字的扩展名是否落在预期范围内。
 *
 * 真正的判据仍然是"解码器认不认"，这一步只为了在跨进程搬运之前给出更准确的报错。
 */
export function isAcceptedIconName(fileName: string): boolean {
  return (ACCEPTED_ICON_EXTENSIONS as readonly string[]).includes(iconExtension(fileName))
}

/** 居中裁剪的结果，单位是**源图像素**。 */
export interface IconCropRect {
  readonly x: number
  readonly y: number
  readonly size: number
}

/**
 * 居中裁剪的几何：取短边为边长，居中裁掉多出来的部分（cover）。
 *
 * 剪掉而不是留白（contain）是刻意的：留白会让自定义图标看起来比系统里别的图标小一圈，
 * 而用户想要的多半是"填满"。裁剪而不是拉伸，则避免把非等比的图压扁。
 *
 * 返回 `null` 表示尺寸不可用（0、负数、NaN）—— 调用方据此给出失败提示，
 * 而不是画出一张空白图当成功。
 */
export function coverCropRect(width: number, height: number): IconCropRect | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null

  const w = Math.floor(width)
  const h = Math.floor(height)
  if (w <= 0 || h <= 0) return null

  const size = Math.min(w, h)
  return {
    x: Math.floor((w - size) / 2),
    y: Math.floor((h - size) / 2),
    size,
  }
}

/** Exec 值里需要加引号的字符：空白、引号、`$`。 */
const EXEC_NEEDS_QUOTING = /[\s"'\\$`]/
const EXEC_ESCAPE = /(["'\\$`])/g

/**
 * 把可执行文件路径写成合法的 `Exec=` 值。
 *
 * 需要这一步的现实理由：AppImage 常落在带空格的路径下（`~/My Apps/WaaChat.AppImage`），
 * 而桌面条目的 `Exec` **不做 shell 展开** —— 没引号化的路径会被拆成"命令 + 参数"，
 * 结果是从启动器点开没反应。
 */
export function desktopEntryExec(executablePath: string): string {
  if (!EXEC_NEEDS_QUOTING.test(executablePath)) return executablePath
  return `"${executablePath.replace(EXEC_ESCAPE, '\\$1')}"`
}

/** {@link buildDesktopEntry} 的输入。 */
export interface DesktopEntryInput {
  /** `Name=`，应用显示名。 */
  readonly name: string
  /** 可执行文件绝对路径。AppImage 下是 `process.env.APPIMAGE`。 */
  readonly exec: string
  /** `Icon=`，指向落盘的自定义图标（绝对路径）。 */
  readonly iconPath: string
  /** `StartupWMClass=`，必须等于 appId，否则 GNOME 不会把窗口与条目合并。 */
  readonly startupWMClass: string
}

/**
 * 生成用户级 `.desktop` 覆盖的内容。
 *
 * 为什么不直接拷贝安装时那份（`/usr/share/applications/<appId>.desktop`）：AppImage 根本
 * 没有那一份，开发模式下也没有。从零拼一份的代价很小 —— 决定"窗口能否与条目合并"的键只有
 * `StartupWMClass`，再加上 INV-4 要求的 `Comment`。
 */
export function buildDesktopEntry(input: DesktopEntryInput): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${input.name}`,
    `Comment=${DESKTOP_ENTRY_COMMENT}`,
    `Exec=${desktopEntryExec(input.exec)} %U`,
    `Icon=${input.iconPath}`,
    'Terminal=false',
    `Categories=${DESKTOP_ENTRY_CATEGORIES}`,
    `Keywords=${DESKTOP_ENTRY_KEYWORDS}`,
    `StartupWMClass=${input.startupWMClass}`,
    DESKTOP_ENTRY_MARKER,
    '',
  ].join('\n')
}

/**
 * 把设置图标的失败原因翻译成用户能理解的一句话。
 *
 * 文案只有这一份：主进程要用它填错误信息，界面要用它填状态行（同 `shared/migration.ts`）。
 * 末尾的 `never` 断言不是装饰：新增一种失败原因时**编译会失败**，从而强制补上翻译。
 */
export function describeIconFailure(failure: AppIconFailure, detail: string): string {
  switch (failure) {
    case 'unreadable':
      return `读不到这个文件：${detail}`
    case 'too-large':
      return `图片太大（${detail}）。图标最终只有 ${APP_ICON_SIZE}×${APP_ICON_SIZE}，请换一张小一些的。`
    case 'unsupported-format':
      return `不支持的格式：${detail}。请用 PNG、JPG 或 ICO。`
    case 'decode-failed':
      return '这个文件不是能解码的图片，或者已经损坏。'
    case 'encode-failed':
      return '无法把裁剪结果编码成 PNG，请换一张图片再试。'
    case 'invalid-image':
      return `图片数据不合法：${detail}`
    case 'write-failed':
      return `写入失败（${detail}）。磁盘可能已满，或者相关目录不可写。`
    case 'desktop-entry-conflict':
      return `启动器里已有一个同名条目，但它不是本应用生成的。为避免覆盖你自己写的文件，这次修改已放弃：${detail}`
    default: {
      const unhandled: never = failure
      return `设置图标时出现未知错误（${String(unhandled)}）。`
    }
  }
}
