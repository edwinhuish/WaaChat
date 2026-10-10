/**
 * 设置行里**动作按钮**的视觉属性（"选择图片…" / "恢复默认" / "更改…"）。
 *
 * 为什么这点东西值得一个模块：这些按钮必须**长得一模一样**，而"看起来一样"如果靠每一处
 * 各写一遍，就会随着日子慢慢分叉 —— 某一处漏了 `type`、class 拼错一个字母（样式跟着 class
 * 走，CSS 选择器不命中就**静默**失效）、或者忘了 `disabled` 的语义。因此属性在这里拼一次，
 * 样式只有 `button.action` 一份（`renderer/styles.css`）。
 *
 * 三处保证：
 *
 *   - `test/unit/action-button.test.ts` 断言"除文字外属性完全一致"；
 *   - `scripts/check-capture.ts` 断言那个 class 在 CSS 里真的有定义（改了 class 名却忘了
 *     改样式表时，按钮会失去全部外观而没有任何报错）；
 *   - 这里**不涉及 DOM 类型**（`onClick` 由调用方补），因此能被 `tsconfig.json` 那份
 *     不含 DOM 的配置编译、也就能被单测直接引用。
 */

/** 动作按钮的样式类。必须与 `renderer/styles.css` 里的 `button.action` 一致。 */
export const ACTION_BUTTON_CLASS = 'action'

/** `h('button', ...)` 需要的属性（**不含** `onClick`：事件与外观是两件事）。 */
export interface ActionButtonAttrs {
  readonly class: string
  readonly type: string
  readonly text: string
  readonly disabled: boolean
}

/**
 * 拼出一个动作按钮的视觉属性。
 *
 * @param text 按钮上的文字（唯一允许各处不同的东西 —— 长短由文案决定）
 * @param disabled 是否禁用。禁用态由 `button.action[disabled]` 统一接管（不再单独调样式）
 */
export function actionButtonAttrs(text: string, disabled = false): ActionButtonAttrs {
  return { class: ACTION_BUTTON_CLASS, type: 'button', text, disabled }
}
