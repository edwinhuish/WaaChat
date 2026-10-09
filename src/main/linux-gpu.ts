/**
 * Linux 上的启动期 GPU 开关（[ADR-0036]）。
 *
 * 解决的是用户启动时看到的那一行：
 *
 * ```
 * ERROR:ui/ozone/platform/wayland/gpu/wayland_surface_factory.cc:249]
 *   '--ozone-platform=wayland' is not compatible with Vulkan.
 *   Consider switching to '--ozone-platform=x11' or disabling Vulkan
 * ```
 *
 * 它是 Chromium **自己**在说：Wayland 的 surface factory 不支持 Vulkan。也就是说在 Wayland 上
 * 这是一个**不可能满足的请求** —— 每次启动都会尝试 Vulkan、拿不到 surface、回退到 GL，并在日志
 * 里留一行 ERROR。我们做的只是"不再请求它"。
 *
 * 三条边界（都不是随手定的，见 [ADR-0036] 的"被否决的替代方案"）：
 *
 *   1. **只在走 Wayland 的臭氧路径时动。** X11 上 Vulkan 可能真的可用，因此判据是**生效的**
 *      平台，而不是"发行版"或"会话类型"。
 *   2. **不覆盖用户的 `--disable-features`。** 同名开关以最后一次为准，直接写会把用户自己的
 *      列表静默抹掉。
 *   3. **用户显式要求 Vulkan 时一律不动。** 显式选择优先于我们的默认。
 *
 * 纯函数 + 可注入的命令行接口（与 `app.commandLine` 同形），因此能单测，不必真的启动一个
 * GPU 进程。
 */

/**
 * 与 Vulkan 有关的 feature 名。
 *
 * 三个都指向 Vulkan（原生 Vulkan、ANGLE 的 Vulkan 后端、"ANGLE 默认用 Vulkan"），在 Wayland 上
 * 它们会落到**同一个**不支持的 surface factory。哪一个当前是默认开启的取决于 Chromium 版本，
 * 我们没有逐个验证 —— 而"禁用一个本来就没开的 feature"是无害的，这比挑一个来猜更稳
 * （名字已用 `strings` 在二进制里核对过，见 [ADR-0036]）。
 */
const VULKAN_FEATURES = ['Vulkan', 'DefaultANGLEVulkan', 'VulkanFromANGLE'] as const

/**
 * 我们用到的那部分 `app.commandLine`。
 *
 * 只声明这两条，是为了让判据能被单测覆盖：传一个假的进来就行，不必真去改进程的命令行。
 */
export interface CommandLineLike {
  getSwitchValue(name: string): string
  appendSwitch(name: string, value: string): void
}

export interface SessionEnvironment {
  /** `XDG_SESSION_TYPE`（`wayland` / `x11`）。 */
  readonly sessionType?: string | undefined
  /** `WAYLAND_DISPLAY`。存在即说明有一个 Wayland 合成器在跑。 */
  readonly waylandDisplay?: string | undefined
}

/**
 * 当前是否走 Wayland 的臭氧路径。
 *
 * 判据与 Chromium 选平台时用的是同一批信号：**显式开关优先**，其次看会话（`XDG_SESSION_TYPE`
 * 或 `WAYLAND_DISPLAY`）。
 *
 * ⚠️ 拿不准时返回 `false`：判断错的代价是"在本来能用 Vulkan 的 X11 上把它关掉"，因此宁可不动。
 */
export function usesWaylandOzone(
  input: SessionEnvironment & { readonly ozonePlatform: string },
): boolean {
  const explicit = input.ozonePlatform.trim().toLowerCase()
  if (explicit !== '') return explicit === 'wayland'

  return (
    input.sessionType?.trim().toLowerCase() === 'wayland' || (input.waylandDisplay ?? '') !== ''
  )
}

/** 用户是否显式要求了 Vulkan（`--enable-features` 里含 `Vulkan` 就算，包括 `VulkanFromANGLE`）。 */
export function userRequestedVulkan(enableFeatures: string): boolean {
  return enableFeatures.includes('Vulkan')
}

/**
 * 需要时追加开关，返回**是否真的动了命令行**（调用方据此记一条日志）。
 *
 * 动的时候只动 `disable-features`，且是**合并**：用户自己传的列表原样留在前面。
 */
export function applyLinuxGpuSwitches(cli: CommandLineLike, env: SessionEnvironment): boolean {
  const wayland = usesWaylandOzone({
    ozonePlatform: cli.getSwitchValue('ozone-platform'),
    sessionType: env.sessionType,
    waylandDisplay: env.waylandDisplay,
  })

  if (!wayland) return false
  if (userRequestedVulkan(cli.getSwitchValue('enable-features'))) return false

  const existing = cli.getSwitchValue('disable-features').trim()
  const added = VULKAN_FEATURES.join(',')

  cli.appendSwitch('disable-features', existing === '' ? added : `${existing},${added}`)

  return true
}
