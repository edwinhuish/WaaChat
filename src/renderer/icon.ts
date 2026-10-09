/**
 * 把用户挑的图片裁剪、缩放成应用图标。
 *
 * **为什么像素工作发生在渲染进程**（而不是主进程的 `nativeImage`）：Electron 的
 * `nativeImage` 文档只保证 PNG / JPEG，而需求是"PNG、JPG、ICO 都行"。ICO（以及 WebP、BMP）
 * 只有 Chromium 的图片解码器认得，而那个解码器在渲染进程里。主进程仍然掌握全部权力 ——
 * 它校验字节、决定落盘位置、决定要不要写启动器条目（见 ADR-0022）。
 *
 * 顺带的好处：预览用的就是同一张 canvas，因此"实时预览"不需要第二套代码。
 */

import { APP_ICON_SIZE, coverCropRect } from '../shared/appicon'

export type IconCropResult =
  | { readonly ok: true; readonly png: Uint8Array; readonly preview: string }
  | { readonly ok: false; readonly failure: 'decode-failed' | 'encode-failed' }

/**
 * 解码 → 居中裁剪 → 缩放 → 编码成 PNG。
 *
 * 每一步的失败都返回结构化原因，由调用方交给 `describeIconFailure()` 翻成人话 ——
 * 这里不做文案。
 */
export async function cropToAppIcon(bytes: Uint8Array): Promise<IconCropResult> {
  let bitmap: ImageBitmap
  try {
    /**
     * `createImageBitmap` 不受 CSP 的 `img-src` 限制：它读的是内存里的 Blob，
     * 不是一次资源加载。因此不需要为了这一步去放宽 CSP。
     *
     * `slice()` 不是多余的：`Uint8Array` 的泛型参数默认是 `ArrayBufferLike`，而
     * `BlobPart` 要求背后确实是 `ArrayBuffer`（`SharedArrayBuffer` 不算）。复制一次的
     * 代价是 ≤8 MiB 的内存拷贝，换来的是这里不必出现一个把类型按下去的断言。
     */
    bitmap = await createImageBitmap(new Blob([bytes.slice()]))
  } catch {
    return { ok: false, failure: 'decode-failed' }
  }

  try {
    const rect = coverCropRect(bitmap.width, bitmap.height)
    if (rect === null) return { ok: false, failure: 'decode-failed' }

    const canvas = document.createElement('canvas')
    canvas.width = APP_ICON_SIZE
    canvas.height = APP_ICON_SIZE

    const context = canvas.getContext('2d')
    if (context === null) return { ok: false, failure: 'encode-failed' }

    // 图标会被缩到 16～256 使用，关掉平滑的话缩小时会出现明显锯齿。
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(
      bitmap,
      rect.x,
      rect.y,
      rect.size,
      rect.size,
      0,
      0,
      APP_ICON_SIZE,
      APP_ICON_SIZE,
    )

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/png')
    })
    if (blob === null) return { ok: false, failure: 'encode-failed' }

    return {
      ok: true,
      png: new Uint8Array(await blob.arrayBuffer()),
      preview: canvas.toDataURL('image/png'),
    }
  } finally {
    // ImageBitmap 占的是解码后的位图内存（512 及以上的图轻易就是几 MB），用完要还。
    bitmap.close()
  }
}
