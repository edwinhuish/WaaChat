/**
 * 动作按钮的视觉属性（`shared/action-button.ts`）。
 *
 * 用户要求"文件保存位置的『更改…』与应用图标的『选择图片…』完全一致"，而这句话要能被
 * 机器检查，只能落到**属性**上：两个按钮共用同一个 class（于是共用同一条 CSS 规则）、
 * 同一个 `type`、同一套禁用语义，只有文字不同。
 *
 * 样式表那一半在离线自检里断言（`scripts/check-capture.ts`）：class 名改了却忘了改 CSS 时，
 * 按钮会**静默**失去全部外观，那是光靠这条单测看不出来的。
 */

import { describe, expect, it } from 'vitest'

import { ACTION_BUTTON_CLASS, actionButtonAttrs } from '../../src/shared/action-button'

describe('actionButtonAttrs', () => {
  it('class / type 固定（样式只有 button.action 一份）', () => {
    const attrs = actionButtonAttrs('更改…')

    expect(attrs.class).toBe(ACTION_BUTTON_CLASS)
    expect(attrs.type).toBe('button')
  })

  it('除文字外，各处按钮的属性**完全一致**', () => {
    const change = actionButtonAttrs('更改…', false)
    const pick = actionButtonAttrs('选择图片…', false)

    // 把 text 抹平之后两者必须逐字段相等 —— 这正是"视觉属性一致"的可断言版本。
    expect({ ...change, text: '' }).toEqual({ ...pick, text: '' })
  })

  it('禁用只是换一个布尔值，不让调用方各自去调样式', () => {
    expect(actionButtonAttrs('迁移中…', true).disabled).toBe(true)
    // 不传就是可用：省掉"忘了传"导致的意外禁用。
    expect(actionButtonAttrs('更改…').disabled).toBe(false)
  })
})
