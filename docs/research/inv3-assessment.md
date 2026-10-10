# INV-3 影响评估：接入 `whatsapp-web.js` 会不会让项目"经手密钥与加密"

> 本文是 [`../decisions.md`](../decisions.md) ADR-0043「未决事项 1」的输入材料。
>
> **它是评估，不是决定。** 结论一旦被采纳，会写进 `decisions.md` 的 ADR；本文按
> `docs/research/` 的约定**只增不改**（历史记录反映当时的判断）。
>
> **不是法律意见。** 本文只回答一个工程问题：我们的代码要不要、会不会自己实现解密。

---

## 0. 结论摘要

| 问题 | 结论 | 依据 |
|---|---|---|
| 库自己实现解密吗？（接收媒体方向） | **不。** 解密由**上游页面代码**完成，库只是薄封装 | E1 E2 |
| 那 INV-3 必须撤销吗？ | **不必。** "解密只由官方网页代码完成"这一条**仍然成立** | E2 |
| 还有别的问题吗？ | **有，但可控**：库会**读取并公开** message 的 `mediaKey` 字段（发送媒体等路径上还会构造它） | E5 |
| 我们的代码（`src/`）会经手密钥吗？ | **可以不。** 我们只消费库返回的 `MessageMedia`（base64 明文） | §3 |

**建议**：**保持 INV-3 不变**，改为在**我们这一侧**加固（见 §5）。若将来引入在 **Node 侧**做媒体解密的库
（Baileys / `@whiskeysockets` 系），本结论作废（见 §6）。

---

## 1. 评估范围与证据来源

- 版本：`whatsapp-web.js@1.34.7`（分支 `main`）。
- 方法：静态阅读关键路径的源码（GitHub raw），**未执行任何代码**。
- ⚠️ **这是抽样审计，不是全量审计。** 只读了三条与"接收媒体"直接相关的路径加依赖清单；
  库的其余部分（`Client.js`、`structures/` 其余文件、`InterfaceController.js`）未逐行读。
  这一点写进结论里，而不是假装它是一份完整审计。

| # | 证据 | 位置 |
|---|---|---|
| **E1** | `Message.downloadMedia()` 把 `this.id._serialized` 交给 `page.evaluate`，由页面内 `window.WWebJS.resolveMediaBlob(msgId)` 取回 base64；**Node 侧无 `require('crypto')`、无任何解密** | `src/structures/Message.js` |
| **E2** | `resolveMediaBlob` 是**薄封装**：调用上游 `msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1, isUserInitiated: true })`，再从上游的 `WAWebMediaInMemoryBlobCache` / `msg.mediaObject.mediaBlob` 取出**已解密**的 blob。函数体内无 AES-CBC、无 HKDF、无 `crypto.subtle` | `src/util/Injected/Utils.js` |
| **E3** | `src/util/Util.js` 里 `crypto` 只用于生成随机临时文件名（`Crypto.randomBytes(6)`）；`generateHash()` 是 `Math.random()`，**不是**密码学哈希 | `src/util/Util.js` |
| **E4** | 运行时依赖里**没有任何密码学库**：`fluent-ffmpeg` / `mime` / `node-fetch` / `node-webpmux`（WebP 容器，与加密无关）/ `puppeteer` | `package.json` |
| **E5** | 库把 `this.mediaKey = data.mediaKey` 作为 `Message` 的**公开属性**暴露 | `src/structures/Message.js` |

---

## 2. INV-3 原文逐条核对

INV-3 是四个"不"加一条"只"：

| INV-3 条款 | 现状 | 依据 |
|---|---|---|
| 不解析 `mediaKey` | ⚠️ **部分不成立**：库把 `mediaKey` 读出来挂在 `Message` 上（发送媒体路径还会构造它）。**但这是库的内部行为，不在我们的代码里** | E5 |
| 不实现密钥派生 | ✅ 成立：接收路径无 HKDF 或任何派生 | E1 E2 |
| 不做 AES / HMAC 运算 | ✅ 成立：库内无对称运算；Node 侧只有随机数 | E1 E2 E3 |
| 不修改加密流量 | ✅ 成立：库走页面自己的下载流程 | E2 |
| 解密只由官方页面代码完成 | ✅ **成立**：`msg.downloadMedia()` 是上游实现 | E2 |

**所以这题的形态不是"要不要撤销 INV-3"，而是"要不要收窄 + 加固"**：真正被触碰的只有"不解析 mediaKey"
这一条，且触碰发生在**库的内部**，不在我们交付的代码里。

---

## 3. 我们这一侧的代码边界

设计原则：**和解密有关的一切都留在库里，我们的代码只消费明文结果。**

- 我们调用的只有 `Message.downloadMedia()` / `downloadMediaStream()`，拿到的是
  `MessageMedia { mimetype, data(base64), filename, filesize }`。
- 我们**不读** `message.mediaKey`，不碰 `mediaObject` / `filehash`，不构造任何解密输入。
- 归档层（内容哈希 + SQLite + 目录分区）**完全复用**：它见到的仍然只有明文，与今天内核层拿到的一样。

这条边界是**可执行的**（§5 给出守卫），而不是靠自觉。

---

## 4. 定性与合规（非法律意见）

- 与今天（内核层拿到页面解密后的明文）相比，**加密边界没有变**：明文仍由服务方代码解密产生，
  我们仍然只是消费它。变的只是"谁去发起这次请求"。
- **真正变化的是风险量级，而不是加密边界**：`whatsapp-web.js` 属于自动化驱动客户端
  （ADR-0043）。这与 INV-3 无关，是 [`../../DISCLAIMER.md`](../../DISCLAIMER.md) 第 2 节要讲的事。
- 本文**不评估**服务方条款的具体解释，也不构成法律意见。

---

## 5. 建议的加固（不撤销 INV-3 也能守住）

1. **lint 守卫（只针对我们自己的代码）**：`eslint.config.mjs` 对 `src/**` 禁止出现
   `createDecipheriv` / `createCipheriv` / `hkdf` / `subtle.decrypt` / `mediaKey` / `filehash`。
   ⚠️ 这与 ADR-0043 撤销 INV-1/INV-2 的守卫**不冲突**：那两条撤的是"对我们承载方式"的限制，
   这条守的是"我们自己的密码学"。`node:crypto` 继续只允许用于 sha256（内容寻址）。
2. **自检（`pnpm run selfcheck`）**：断言 `src/` 下不出现上述标识符；并在文档里写明"禁止读取
   `Message.mediaKey`"。
3. **依赖纪律**：在 ADR 与文档里记下"引入在 Node 侧解密的库（Baileys / `@whiskeysockets` 系）
   会直接破坏 INV-3"。注意 ADR-0043 已撤销 INV-2 的 lint 守卫，因此这条**只能靠 ADR + 复查**
   兜住，而不是 lint —— 这是撤销 INV-2 换来的具体代价。
4. **DISCLAIMER 第 3 节**保留"解密发生在官方网页代码内部"，并补上指向本文的交叉引用（已做）。

---

## 6. 何时本结论作废

- 引入任何在 **Node 侧**做媒体解密的库（Baileys / `@whiskeysockets` 系）。
- 该库某天把解密从页面迁到 Node（例如自带 `decryptMedia`）。

因此：**锁版本**，并在每次升级该库时复查 E1 / E2 / E5 三个证据点。
