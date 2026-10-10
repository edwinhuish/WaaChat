/**
 * Linux 上的启动期 GPU 开关（[ADR-0036]，机制由 [ADR-0038] 修正）。
 *
 * 目标只有一个：Wayland 会话里启动时不要出现那一行
 *
 * ```
 * ERROR:ui/ozone/platform/wayland/gpu/wayland_surface_factory.cc:249]
 *   '--ozone-platform=wayland' is not compatible with Vulkan.
 *   Consider switching to '--ozone-platform=x11' or disabling Vulkan
 * ```
 *
 * ── 那行到底是谁在说话（实测 + 源码核对，见 [ADR-0038]）──
 *
 * `WaylandSurfaceFactory::CreateVulkanImplementation()` 对**任何非 SwiftShader 的**原生 Vulkan
 * 实现都无条件打这一行（`LOG_IF(ERROR, !use_swiftshader)`），而 Wayland 的实现
 * （`VulkanImplementationWayland`）缺的只是 **Vulkan surface**（`CreateViewSurface()` →
 * `NOTIMPLEMENTED()`）—— device 那一侧（dma-buf 外部内存互操作）是实现了的。
 *
 * 把 Vulkan 实现要起来的，是 Chromium 的 **「WebGPU 跑在原生 Vulkan、经 GL 互操作上屏」** 那条路
 * （`GPU_FEATURE_TYPE_WEBGPU_ON_VK_VIA_GL_INTEROP`）。它在带 `USE_WEBGPU_ON_VULKAN_VIA_GL_INTEROP`
 * 的构建里**默认开启**，并且**不是一个 `base::Feature`** —— 所以只关 feature 对它无效：装 1.0.3 的
 * GPU 进程命令行里确实有 `Vulkan,DefaultANGLEVulkan,VulkanFromANGLE`，那行照旧出现（实测）。
 * 能从命令行关掉它的只有 `--use-webgpu-adapter=opengles`。
 *
 * ── 因此这里动两个开关，各管一层 ──
 *
 *   1. `--disable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE` —— **GL / 合成的这一层**。
 *      那条路是真的需要 Vulkan surface（Wayland 上没实现），所以不让它去试是对的；它今天本来也
 *      不默认开启，这个开关是防将来、防特殊配置。名字已用 `strings` 在二进制里核对过。
 *   2. `--use-webgpu-adapter=opengles` —— **WebGPU 的那一层**，也就是那行报错的真正来源。
 *      代价写在明处，不藏着：WebGPU 在 Wayland 上改用 ANGLE（GL）后端，而不是"原生 Vulkan +
 *      dma-buf 互操作"。对"承载官方网页的壳"来说这个能力今天用不到（页面里没有 WebGPU），
 *      但它是**真实的功能取舍**，不是零成本 —— 见 [ADR-0038] 的"已知限制"与逃生通道。
 *
 * ── 四条边界（前三条见 [ADR-0036]，第四条见 [ADR-0038]）──
 *
 *   1. **只在走 Wayland 的臭氧路径时动。** X11 上 Vulkan 可能真的可用，因此判据是**生效的**
 *      平台，而不是"发行版"或"会话类型"。
 *   2. **不覆盖用户的 `--disable-features`。** 同名开关以最后一次为准，直接写会把用户自己的
 *      列表静默抹掉。
 *   3. **用户显式要求 Vulkan 时一律不动。** 显式选择优先于我们的默认。
 *   4. **用户自己指定了 WebGPU 后端时不动它**（`--use-webgpu-adapter=…`）。这是逃生通道：
 *      想要"原生 Vulkan + GL 互操作"的 WebGPU，就自己把这个开关写上，那行 ERROR 会回来。
 *
 * 纯函数 + 可注入的命令行接口（与 `app.commandLine` 同形），因此能单测，不必真的启动一个
 * GPU 进程。
 */

/**
 * 与 Vulkan 有关的 feature 名（GL / 合成那一层）。
 *
 * 三个都指向 Vulkan（原生 Vulkan、ANGLE 的 Vulkan 后端、"ANGLE 默认用 Vulkan"），在 Wayland 上
 * 它们会落到**同一个**不支持的 surface factory。哪一个当前是默认开启的取决于 Chromium 版本，
 * 我们没有逐个验证 —— 而"禁用一个本来就没开的 feature"是无害的，这比挑一个来猜更稳。
 */
const VULKAN_FEATURES = ['Vulkan', 'DefaultANGLEVulkan', 'VulkanFromANGLE'] as const

/**
 * WebGPU 后端的开关，以及"不要用原生 Vulkan"那个取值（[ADR-0038]）。
 *
 * 这是命令行上唯一能关掉「WebGPU 在原生 Vulkan 上 + GL 互操作」的手段（另一条路是 GPU 黑名单，
 * 我们够不着）。取值必须是 `opengles`：Chromium 只有在它**恰好**等于这个值时才会把那条路判为
 * 不可用。
 */
const WEBGPU_ADAPTER_SWITCH = 'use-webgpu-adapter'
const WEBGPU_ADAPTER_GLES = 'opengles'

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
 * 动的是两个开关，各管一层（见文件头）：
 *
 *   - `disable-features`：**合并**，用户自己传的那份原样留在前面；
 *   - `use-webgpu-adapter`：只在用户没自己指定时写。
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

  // 用户自己定过后端（例如 `--use-webgpu-adapter=vulkan`）就不动他 —— 那是逃生通道，
  // 也是"显式选择优先"这条边界的同一件事。
  if (cli.getSwitchValue(WEBGPU_ADAPTER_SWITCH).trim() === '') {
    cli.appendSwitch(WEBGPU_ADAPTER_SWITCH, WEBGPU_ADAPTER_GLES)
  }

  return true
}
