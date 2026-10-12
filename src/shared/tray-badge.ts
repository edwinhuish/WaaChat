/**
 * 把未读数画到托盘图标的位图上（[ADR-0080]）。
 *
 * 为什么自己画而不用现成的办法：Linux 下**没有**"应用未读数"这种东西 ——
 * `app.setBadgeCount()` 只在 Unity 的 launcher（需要 libunity）上有效，而 `.desktop` 条目的
 * `Icon=` 更不可能带一个数字。因此唯一的落点就是托盘图标本身：把数字画进那张位图。
 *
 * 为什么不用 canvas / SVG：主进程没有 canvas，而 `nativeImage` 只认 PNG/JPEG（不认 SVG），为了
 * 画一两个数字引一个图片库不划算。这里用一张**手写的 3×5 点阵字模**，直接写进
 * `nativeImage.toBitmap()` 那份原始位图 —— 零依赖，位置与字号都是确定的整数。
 *
 * ⚠️ **通道序**：位图按 BGRA 写（理由与"认错了会怎样"写在 `main/integration/badge.ts`）。
 * 本模块只认"第 0 字节 = B、第 1 = G、第 2 = R、第 3 = A"，与 Electron 无关，因此它是纯函数、
 * 可单测 —— 而单测能直接断言"画完之后哪些像素变了"，那正是这一项最容易悄悄坏掉的地方
 * （画到图标外面、字模错行、颜色写反）。
 */

/** 默认画布尺寸（正方形）。托盘图标在桌面环境里会按自己的尺寸再缩放一次。 */
export const TRAY_BADGE_CANVAS = 64

/**
 * 几何都按画布尺寸的**比例**算，而不是写死 64 下的整数。
 *
 * 理由：`nativeImage.toBitmap()` 的实际像素数由平台与缩放因子决定（见 `badge.ts`），拿回来的
 * 可能不是 64×64。写死坐标的后果是"徽标只画在左上角那一小块里"，而 64 是我们唯一真的会验证的
 * 尺寸 —— 比例写法让别的尺寸也是同一个形状。
 *
 * 圆心**不在画布中心**：徽标是"贴在右下角"的信号，居中会盖住图标最有辨识度的那一块。
 */
const CENTER_RATIO = 43 / 64
const RADIUS_RATIO = 19 / 64

/**
 * 徽标颜色（BGR 顺序，见文件头）与文字颜色。
 *
 * 红底白字：托盘图标底下的面板可能是浅色也可能是深色，而这两者的对比度都够用。
 */
const BADGE_COLOR = { b: 0x4d, g: 0x48, r: 0xe5 } as const
const TEXT_COLOR = 0xff

/**
 * 3×5 的点阵字模。
 *
 * 每一行 3 bit（高位在左），每个字符 5 行 —— 最省事又能看清的一套：`1` 与 `7` 能分开，
 * `0` 与 `8` 也能（`99+` 里那个 `+` 与数字之间还有间隔）。
 */
const GLYPHS: Readonly<Record<string, readonly number[]>> = {
  '0': [0b111, 0b101, 0b101, 0b101, 0b111],
  '1': [0b010, 0b110, 0b010, 0b010, 0b111],
  '2': [0b111, 0b001, 0b111, 0b100, 0b111],
  '3': [0b111, 0b001, 0b111, 0b001, 0b111],
  '4': [0b101, 0b101, 0b111, 0b001, 0b001],
  '5': [0b111, 0b100, 0b111, 0b001, 0b111],
  '6': [0b111, 0b100, 0b111, 0b101, 0b111],
  '7': [0b111, 0b001, 0b001, 0b001, 0b001],
  '8': [0b111, 0b101, 0b111, 0b101, 0b111],
  '9': [0b111, 0b101, 0b111, 0b001, 0b111],
  '+': [0b000, 0b010, 0b111, 0b010, 0b000],
}

const GLYPH_WIDTH = 3
const GLYPH_HEIGHT = 5

/**
 * 把 `label` 画进 `bitmap`（原地修改）。
 *
 * 字号按字符数选：一个字符画得下就画大（15×25），三个字符只能小一号（9×15）—— 三种字号都保证
 * 文字**完全落在圆内**（最宽那一档 29×15 的外接圆半径 16.3 < 19）。认不出的字符直接跳过
 * （只留空白），而不是抛错：一个徽标画不出来不该让托盘整个消失。
 */
export function drawUnreadBadge(bitmap: Uint8Array, size: number, label: string): void {
  if (size <= 0 || bitmap.length < size * size * 4) {
    throw new Error('tray-badge: 位图比 size × size × 4 还小')
  }

  const center = Math.round(size * CENTER_RATIO)
  const radius = Math.max(2, Math.round(size * RADIUS_RATIO))
  /** 与画布的比例系数：64 时是 1（那一档是设计基准）。 */
  const unit = size / 64

  const nominalScale = label.length >= 3 ? 3 : label.length === 2 ? 4 : 5
  const scale = Math.max(1, Math.round(nominalScale * unit))
  const gap = Math.max(1, Math.round((nominalScale >= 4 ? 2 : 1) * unit))

  drawDisc(bitmap, size, center, radius, radius * radius)

  const textWidth = label.length * GLYPH_WIDTH * scale + (label.length - 1) * gap
  const textHeight = GLYPH_HEIGHT * scale
  const startX = center - Math.floor(textWidth / 2)
  const startY = center - Math.floor(textHeight / 2)

  let cursorX = startX
  for (const character of label) {
    const rows = GLYPHS[character]

    if (rows !== undefined) {
      for (const [row, bits] of rows.entries()) {
        for (let column = 0; column < GLYPH_WIDTH; column += 1) {
          // 高位在左（字模就是照这个顺序写的）
          if ((bits & (1 << (GLYPH_WIDTH - 1 - column))) === 0) continue
          fillRect(bitmap, size, cursorX + column * scale, startY + row * scale, scale, scale)
        }
      }
    }

    cursorX += GLYPH_WIDTH * scale + gap
  }
}

/** 红的圆底（先画底、再画字：反过来的话底会把字盖掉）。 */
function drawDisc(
  bitmap: Uint8Array,
  size: number,
  center: number,
  radius: number,
  radiusSquared: number,
): void {
  for (let y = center - radius; y <= center + radius; y += 1) {
    for (let x = center - radius; x <= center + radius; x += 1) {
      const dx = x - center
      const dy = y - center
      if (dx * dx + dy * dy > radiusSquared) continue
      setPixel(bitmap, size, x, y, BADGE_COLOR.b, BADGE_COLOR.g, BADGE_COLOR.r)
    }
  }
}

/** 画一个 `scale × scale` 的方块（点阵字模里"一个点"的落点）。 */
function fillRect(
  bitmap: Uint8Array,
  size: number,
  left: number,
  top: number,
  width: number,
  height: number,
): void {
  for (let y = top; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) {
      setPixel(bitmap, size, x, y, TEXT_COLOR, TEXT_COLOR, TEXT_COLOR)
    }
  }
}

function setPixel(
  bitmap: Uint8Array,
  size: number,
  x: number,
  y: number,
  blue: number,
  green: number,
  red: number,
): void {
  /**
   * 两件事共用这一行守卫：
   *  - 将来改了圆心/半径之后"画到画布外面"——那会越界写到下一行的像素上，症状是图标上出现
   *    一条乱码横线（很难立刻联想到徽标）；
   *  - 字模与圆心算出来的落点本来就可能压到边缘（`99+` 在 32px 画布上）。
   */
  if (x < 0 || y < 0 || x >= size || y >= size) return

  const offset = (y * size + x) * 4
  bitmap[offset] = blue
  bitmap[offset + 1] = green
  bitmap[offset + 2] = red
  bitmap[offset + 3] = 0xff
}
