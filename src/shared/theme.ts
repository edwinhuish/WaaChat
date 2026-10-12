/**
 * 主题（浅色 / 深色 / 跟随系统）。
 *
 * 它是一份设置，但作用点在三个不同的地方，而且**三处各自能到什么程度并不一样** —— 不写清
 * 这一点，用户点完"深色"看到内嵌的网页版纹丝不动，就会把平台边界读成"功能坏了"：
 *
 *   1. **我们自己的两扇窗口**（文件列表 / 设置）：颜色全部走 `styles.css` 的
 *      `prefers-color-scheme`，而那条媒体查询由 `nativeTheme.themeSource` 驱动 ⇒ 跟随这里。
 *   2. **窗口底色**（`BrowserWindow.backgroundColor`）：内容画出来之前的那一层底色，
 *      与 `styles.css` 里 `--bg` 的两个值**逐字符相同**（{@link WINDOW_BACKGROUND}，自检断言）。
 *   3. **内嵌的网页版**：**只在它自己的主题设成"跟随系统"时**才跟着变。网页版的主题存在
 *      **账号**上（入口在页面自己的设置里），与界面语言同源 —— 我们这一层没有可动的杠杆，
 *      也不该有：改它要么注入（INV-1 不许），要么去和页面抢同一份存储
 *      （[ADR-0066] 那次证伪留下的教训）。
 *
 * 与 `shared/instance.ts` 同一条分工：判据（哪些值合法、底色是多少）留在这里，因此单测与
 * 离线自检都能直接断言；落到 Electron 上的那一步在 `main/theme.ts`。
 */

/** 主题取值。与 Electron `nativeTheme.themeSource` 的三个值同形（刻意不自己发明一套）。 */
export type ThemeSource = 'system' | 'light' | 'dark'

/** 默认：跟随系统 —— 一台已经切到深色的桌面上，纯白窗口是刺眼的。 */
export const DEFAULT_THEME: ThemeSource = 'system'

/**
 * 界面上的三个选项（顺序即显示顺序）。
 *
 * 文案只有这一份：视图照着它渲染下拉框，单测与离线自检据此断言"三个都在、值都不重样" ——
 * 少一个选项的后果是**那个取值在界面上无法抵达**，而它照样能被写进配置文件。
 */
export const THEME_OPTIONS: readonly { readonly value: ThemeSource; readonly label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
]

/**
 * 把不可信的值收敛成合法的主题（读设置时用）。
 *
 * 收敛发生在**读设置的那一刻**，而不是在各个消费点各判一次（那样必然漏一处）：存下一个我们
 * 不认识的值，症状是"设置里显示 A、实际按 B 跑"，而用户没有任何办法看出来。
 */
export function normalizeTheme(value: unknown): ThemeSource {
  return THEME_OPTIONS.some((option) => option.value === value)
    ? (value as ThemeSource)
    : DEFAULT_THEME
}

/**
 * 窗口底色 —— 与 `styles.css` 里 `:root` 与深色那一组的 `--bg` **逐字符相同**。
 *
 * 为什么值得一个常量：这一层底色只在"窗口已经出现、内容还没画出来"的那一小段时间可见，
 * 颜色对不上就是一次白闪 —— 在深色桌面上一次刺眼的白闪。两处各写一遍字符串，改动时必然
 * 漏一处，而那种不一致只在启动的一瞬间出现（自检因此断言两者一致）。
 */
export const WINDOW_BACKGROUND = { light: '#f6f7f9', dark: '#16181d' } as const

/** 按"当前是不是深色"取窗口底色。 */
export function windowBackground(dark: boolean): string {
  return dark ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light
}
