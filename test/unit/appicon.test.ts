/**
 * 自定义图标的纯逻辑单测。
 *
 * 这些用例对应的都是具体的坏结果，而不是"补覆盖率"：
 *   - 扩展名判错 → 用户选中一个必然失败的文件，却收到一句看不出问题的报错；
 *   - 裁剪几何算错 → 图标被拉伸变形，或者偏到只剩一角；
 *   - `Exec=` 不引号化 → AppImage 放在带空格的路径下时，从启动器点开没反应；
 *   - 桌面条目漏掉非官方声明 → INV-4 的义务随"用户换了一次图标"一起消失；
 *   - 桌面条目漏掉 `MimeType` / `%U` → 深链接随"用户换了一次图标"一起消失（同样是安静的）。
 */

import { describe, expect, it } from 'vitest'

import { CHAT_PROTOCOL } from '../../src/shared/deep-link'
import {
  ACCEPTED_ICON_EXTENSIONS,
  APP_ICON_SIZE,
  DESKTOP_ENTRY_MARKER,
  buildDesktopEntry,
  coverCropRect,
  describeIconFailure,
  desktopEntryExec,
  iconExtension,
  isAcceptedIconName,
} from '../../src/shared/appicon'
import type { AppIconFailure } from '../../src/shared/types'

describe('iconExtension', () => {
  it('取小写扩展名', () => {
    expect(iconExtension('logo.PNG')).toBe('png')
    expect(iconExtension('photo.JPEG')).toBe('jpeg')
    expect(iconExtension('app.ico')).toBe('ico')
  })

  it('只看最后一个点', () => {
    expect(iconExtension('my.photos.2026.png')).toBe('png')
  })

  it('只有点开头的名字没有扩展名', () => {
    // `.bashrc` 的扩展名不是 "bashrc"。判错的话用户会看到"不支持的格式：bashrc"。
    expect(iconExtension('.bashrc')).toBe('')
    expect(iconExtension('.png')).toBe('')
  })

  it('没有点、或点结尾时返回空串', () => {
    expect(iconExtension('README')).toBe('')
    expect(iconExtension('broken.')).toBe('')
    expect(iconExtension('')).toBe('')
  })
})

describe('isAcceptedIconName', () => {
  it('接受需求里点名的三种格式', () => {
    // 这三条是需求原文："支持常见图片格式（如 PNG、JPG、ICO）"。
    expect(isAcceptedIconName('a.png')).toBe(true)
    expect(isAcceptedIconName('a.jpg')).toBe(true)
    expect(isAcceptedIconName('a.ico')).toBe(true)
  })

  it('接受 Chromium 能解码的其它格式', () => {
    expect(isAcceptedIconName('a.jpeg')).toBe(true)
    expect(isAcceptedIconName('a.webp')).toBe(true)
    expect(isAcceptedIconName('a.bmp')).toBe(true)
    expect(isAcceptedIconName('a.gif')).toBe(true)
  })

  it('拒绝明显不是位图的东西', () => {
    // SVG 刻意不在列表里：它是脚本可承载的格式，而这里要的是"一张位图"。
    expect(isAcceptedIconName('icon.svg')).toBe(false)
    expect(isAcceptedIconName('notes.txt')).toBe(false)
    expect(isAcceptedIconName('payload.sh')).toBe(false)
    expect(isAcceptedIconName('noext')).toBe(false)
  })

  it('接受集合与对话框列表一致（对话框不会漏掉能用的格式）', () => {
    expect([...ACCEPTED_ICON_EXTENSIONS]).toEqual(
      expect.arrayContaining(['png', 'jpg', 'jpeg', 'ico']),
    )
  })
})

describe('coverCropRect', () => {
  it('正方形原样不裁', () => {
    expect(coverCropRect(512, 512)).toEqual({ x: 0, y: 0, size: 512 })
  })

  it('横向图取高度为边长、左右各裁一半', () => {
    expect(coverCropRect(1000, 400)).toEqual({ x: 300, y: 0, size: 400 })
  })

  it('纵向图取宽度为边长、上下各裁一半', () => {
    expect(coverCropRect(400, 1000)).toEqual({ x: 0, y: 300, size: 400 })
  })

  it('奇数差取整不越界', () => {
    // 1001-400=601，一半是 300.5 —— 必须落在 300，否则会取到图像外面一格。
    // 用 ?? 兜底而不是 `!`：真返回 null 时这里应该是一条可读的断言失败，而不是崩掉。
    const { x, y, size } = coverCropRect(1001, 400) ?? { x: -1, y: -1, size: 0 }

    expect({ x, y, size }).toEqual({ x: 300, y: 0, size: 400 })
    expect(x + size).toBeLessThanOrEqual(1001)
  })

  it('1×1 也能用', () => {
    expect(coverCropRect(1, 1)).toEqual({ x: 0, y: 0, size: 1 })
  })

  it('尺寸不可用时返回 null，而不是画一张空图', () => {
    expect(coverCropRect(0, 100)).toBeNull()
    expect(coverCropRect(100, 0)).toBeNull()
    expect(coverCropRect(-5, 10)).toBeNull()
    expect(coverCropRect(Number.NaN, 10)).toBeNull()
    expect(coverCropRect(Number.POSITIVE_INFINITY, 10)).toBeNull()
  })
})

describe('desktopEntryExec', () => {
  it('不含特殊字符的路径原样输出', () => {
    expect(desktopEntryExec('/opt/WaaChat/waachat')).toBe('/opt/WaaChat/waachat')
  })

  it('带空格的路径加引号', () => {
    // 不加引号会被拆成"命令 + 参数"，症状是从启动器点开没反应。
    expect(desktopEntryExec('/home/edwin/My Apps/WaaChat.AppImage')).toBe(
      '"/home/edwin/My Apps/WaaChat.AppImage"',
    )
  })

  it('引号与反斜杠被转义', () => {
    expect(desktopEntryExec('/tmp/a"b')).toBe('"/tmp/a\\"b"')
    expect(desktopEntryExec('/tmp/a\\b')).toBe('"/tmp/a\\\\b"')
  })
})

describe('buildDesktopEntry', () => {
  const entry = buildDesktopEntry({
    name: 'WaaChat',
    exec: '/opt/WaaChat/waachat',
    iconPath: '/home/edwin/.config/waachat/custom-icon.png',
    startupWMClass: 'io.github.edwinhuish.waachat',
  })

  it('是一个合法的桌面条目开头', () => {
    expect(entry.startsWith('[Desktop Entry]\n')).toBe(true)
    expect(entry).toContain('Type=Application\n')
  })

  it('Icon 指向自定义图标（绝对路径）', () => {
    expect(entry).toContain('Icon=/home/edwin/.config/waachat/custom-icon.png\n')
  })

  it('StartupWMClass 与 appId 同源', () => {
    // 对不上时 GNOME 不会把运行中的窗口与启动器条目合并（见 docs/packaging.md 第 2 节）。
    expect(entry).toContain('StartupWMClass=io.github.edwinhuish.waachat\n')
  })

  it('带着 INV-4 要求的非官方声明', () => {
    // 这份覆盖会取代安装时那份条目，因此声明义务要跟着一起走。
    expect(entry.toLowerCase()).toContain('unofficial')
  })

  it('带着深链接的两条声明（MimeType 与 Exec 的 %U）', () => {
    // ⚠️ 这两条是"这份覆盖会取代安装时那份条目"的直接后果：漏掉 MimeType 时，**换过图标的**
    // 用户点一个 wa.me 链接会什么都不发生；漏掉 %U 时应用会被拉起来、停在首页。
    // 两种都不会报错，也不会在构建期暴露（[ADR-0083]）。
    expect(entry).toContain(`MimeType=x-scheme-handler/${CHAT_PROTOCOL};\n`)
    expect(entry).toContain(' %U\n')
  })

  it('带着标记行（用于区分"我们写的"与"用户自己写的"）', () => {
    expect(entry).toContain(DESKTOP_ENTRY_MARKER)
  })

  it('声明 StartupNotify=false（否则点页面的通知后光标空转约 15 秒）', () => {
    // [ADR-0095] 之后消息通知由页面发，GNOME 会等一个没人消费的 activation token。
    expect(entry).toContain('StartupNotify=false\n')
  })

  it('以换行结尾（桌面条目按行解析，末行没有换行会丢）', () => {
    expect(entry.endsWith('\n')).toBe(true)
  })
})

describe('describeIconFailure', () => {
  const reasons: readonly AppIconFailure[] = [
    'unreadable',
    'too-large',
    'unsupported-format',
    'decode-failed',
    'encode-failed',
    'invalid-image',
    'write-failed',
    'desktop-entry-conflict',
  ]

  it('每一种原因都有自己的一句话，且互不重复', () => {
    const texts = reasons.map((reason) => describeIconFailure(reason, 'detail'))

    expect(texts.every((text) => text.length > 0)).toBe(true)
    expect(new Set(texts).size).toBe(reasons.length)
  })

  it('把具体信息带进文案（否则用户不知道该改什么）', () => {
    expect(describeIconFailure('too-large', '20 MB')).toContain('20 MB')
    expect(describeIconFailure('too-large', '20 MB')).toContain(String(APP_ICON_SIZE))
    expect(describeIconFailure('unsupported-format', 'svg')).toContain('svg')
  })
})
