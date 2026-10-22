/**
 * 页面通知的点击 → 把窗口带到用户面前（[ADR-0096]）。
 *
 * 页面自己发的消息通知，点击在 Linux 上**只被派发给页面**（`DispatchNonPersistentClickEvent`），
 * 主进程没有任何事件可挂（[ADR-0092] 证据 1）。唯一还剩下的信号在**会话总线**上：
 *
 *     :1.20 -> :1.1038  member=ActionInvoked  [123, "default"]
 *
 * 也就是"通知守护进程把'你那条被点了'发回给发起 `Notify` 的那个连接"。监听这条信号需要
 * `BecomeMonitor`（单播信号不是广播，普通 `AddMatch` 收不到），而认领"这条是不是我发的"靠
 * `ProcessID == 本进程 pid`（实测：页面通知的 `Notify` 由 Electron **浏览器进程**发出）。
 *
 * 判据全在 `shared/notify-activation.ts`（可单测）。这里只做三件事：连总线、把消息摘成帧、
 * 认领成功时调注入的回调。**不读页面、不注入、不碰通知内容**（[INV-1]）。
 *
 * ### 两个 dbus-next 的坑（都实测过，都是静默失效）
 *
 * 1. **监视连接会被自己的自动错误回复打死。** `MessageBus` 收到一条 method call 时，若没有
 *    handler 认领，它会回一个 `UnknownMethod` 错误（`lib/bus.js` 的 `handleMessage`）。监视连接
 *    是**只读**的 —— 发一条消息就断。实测：观察到第一条 `Notify` 之后连接彻底静默，没有任何
 *    错误事件。因此必须在使用前 `addMethodHandler(() => true)`。
 * 2. **`GetConnectionCredentials` 的 `a{sv}` 返回值走 proxy 那条路会崩**（`marshall-compat` 里
 *    `expected value for signature`），必须用裸 `Message` 调。监视连接是只读的，本来也不能发，
 *    所以另开一条普通连接专门问 PID。
 *
 * 另外 `interface=` 过滤抓不到 `method return`（它没有 interface 字段），而方法返回是认领链的
 * 一环 —— 这也是这里不用 `addMatch` 而是拿**全量**消息、自己做分派的原因之一。
 */

import { Message, MessageType, Variant, sessionBus, type MessageBus } from 'dbus-next'

import {
  EMPTY_CLAIM,
  claimNotificationId,
  claimOwnNotify,
  decideClick,
  releaseClosed,
  type ClaimState,
} from '../shared/notify-activation'
import { logger } from './logger'

const DBUS_NAME = 'org.freedesktop.DBus'
const DBUS_PATH = '/org/freedesktop/DBus'
const NOTIFICATIONS_NAME = 'org.freedesktop.Notifications'

/** 正跑着的那一对连接。`null` = 没跑（还没开始、或已经停掉）。 */
let current: { monitor: MessageBus; admin: MessageBus } | null = null

export interface ActivationOptions {
  /** 认领到"我们发的那条通知被点了"。目的地由装配处决定（永远是那扇聊天窗口）。 */
  readonly onActivate: () => void
}

/**
 * 开始旁听。**永不抛**：拿不到监视权限（沙箱、被策略挡住的总线）时记一条 warn 就退化成现状
 * —— 点通知什么都不发生，与 [ADR-0095] 的行为一致。静默降级等同于缺陷（`ai/CONVENTIONS.md`
 * 第 4 节），所以那条 warn 是必需的。
 */
export async function startPageNotificationActivation(options: ActivationOptions): Promise<void> {
  if (current !== null) return

  let monitor: MessageBus
  let admin: MessageBus
  try {
    monitor = sessionBus()
    admin = sessionBus()
  } catch (error) {
    logger.warn('page-notification: no session bus to listen on', {
      reason: (error as Error).name,
    })
    return
  }

  current = { monitor, admin }

  // 见文件头坑 1：必须早于任何消息被观察到。
  monitor.addMethodHandler(() => true)
  // 没有 'error' 监听的 EventEmitter 会把错误抛成未捕获异常，直接带走主进程。
  monitor.on('error', (error: Error) => {
    logger.warn('page-notification: monitor connection failed', { reason: error.name })
    stopPageNotificationActivation()
  })
  admin.on('error', (error: Error) => {
    logger.warn('page-notification: helper connection failed', { reason: error.name })
    stopPageNotificationActivation()
  })

  let state: ClaimState = EMPTY_CLAIM
  /** sender 的 unique name → 是不是我们自己的进程。见文件头坑 2 与"名字会被回收"那句。 */
  const ownConnections = new Map<string, boolean>()
  const selfPid = process.pid

  try {
    await monitor.call(
      new Message({
        destination: DBUS_NAME,
        path: DBUS_PATH,
        interface: 'org.freedesktop.DBus.Monitoring',
        member: 'BecomeMonitor',
        // 空规则 = 全量。写规则只会漏（见文件头最后一段）。
        signature: 'asu',
        body: [[], 0],
      }),
    )
  } catch (error) {
    logger.warn('page-notification: this bus does not let us monitor', {
      reason: (error as Error).name,
    })
    stopPageNotificationActivation()
    return
  }

  monitor.on('message', (message: Message) => {
    try {
      dispatch(message)
    } catch (error) {
      // 一条认不出来的消息不该让旁听停下来，但也不能悄悄吞掉。
      logger.warn('page-notification: could not handle a bus message', {
        reason: (error as Error).name,
      })
    }
  })

  function dispatch(message: Message): void {
    if (message.type === MessageType.METHOD_CALL) {
      /**
       * 页面发通知：`Notify`，sender 是 Chromium 那条 libnotify 连接。
       * 只取 sender 与 serial，**绝不碰 body** —— 正文是用户的聊天内容。
       */
      if (
        message.member === 'Notify' &&
        message.sender !== undefined &&
        typeof message.serial === 'number'
      ) {
        void confirmSender(message.sender, message.serial)
      }
      return
    }

    if (message.type === MessageType.METHOD_RETURN) {
      const notificationId = firstNumber(message.body)
      const replySerial = Number(message.replySerial)
      if (notificationId === null || !Number.isInteger(replySerial)) return
      state = claimNotificationId(state, { replySerial, notificationId })
      return
    }

    if (message.type !== MessageType.SIGNAL) return

    if (message.interface === NOTIFICATIONS_NAME && message.member === 'ActionInvoked') {
      const notificationId = firstNumber(message.body)
      if (notificationId === null) return
      const decision = decideClick(state, {
        notificationId,
        destination: message.destination ?? null,
      })
      state = decision.state
      if (decision.activate) {
        logger.info('page-notification: clicked, bringing the window back')
        options.onActivate()
      }
      return
    }

    if (message.interface === NOTIFICATIONS_NAME && message.member === 'NotificationClosed') {
      const notificationId = firstNumber(message.body)
      if (notificationId !== null) state = releaseClosed(state, notificationId)
      return
    }

    // unique name 会被总线回收：同名换人之后，缓存里那句"是我们的"就不成立了。
    if (message.interface === DBUS_NAME && message.member === 'NameOwnerChanged') {
      const [name, , newOwner] = message.body
      if (typeof name === 'string' && newOwner === '') ownConnections.delete(name)
    }
  }

  async function confirmSender(sender: string, serial: number): Promise<void> {
    if (!(await isOwnConnection(sender))) return
    state = claimOwnNotify(state, { sender, serial })
  }

  async function isOwnConnection(sender: string): Promise<boolean> {
    const cached = ownConnections.get(sender)
    if (cached !== undefined) return cached

    try {
      const reply = await admin.call(
        new Message({
          destination: DBUS_NAME,
          path: DBUS_PATH,
          interface: DBUS_NAME,
          member: 'GetConnectionCredentials',
          signature: 's',
          body: [sender],
        }),
      )
      if (reply === null) return false

      const mine = processIdOf(reply.body) === selfPid
      ownConnections.set(sender, mine)
      return mine
    } catch (error) {
      /**
       * 问不出来就按"不是我们的"处理：宁可少激活一次（用户还有托盘那条路），
       * 也不要把**别人**的通知点击认成自己的 —— 那会让聊天窗口无缘无故弹出来。
       */
      logger.warn('page-notification: could not ask who owns a bus connection', {
        reason: (error as Error).name,
      })
      return false
    }
  }
}

/** 停掉旁听。重复调用、没启动过都安全。 */
export function stopPageNotificationActivation(): void {
  const running = current
  current = null
  if (running === null) return

  for (const bus of [running.monitor, running.admin]) {
    try {
      bus.disconnect()
    } catch (error) {
      // 退出路径上断开失败不值得打扰任何人，但也不能装作没发生。
      logger.warn('page-notification: could not close a bus connection', {
        reason: (error as Error).name,
      })
    }
  }
}

function firstNumber(body: readonly unknown[]): number | null {
  const [first] = body
  return typeof first === 'number' ? first : null
}

/** `GetConnectionCredentials` 的返回值是 `a{sv}`：`Map<string, Variant>`。 */
function processIdOf(body: readonly unknown[]): number | null {
  const [credentials] = body
  if (!(credentials instanceof Map)) return null

  const processId: unknown = credentials.get('ProcessID')
  const value = processId instanceof Variant ? processId.value : processId
  return typeof value === 'number' ? value : null
}
