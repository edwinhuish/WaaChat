/**
 * 失败原因的表述。
 *
 * 这个模块存在，是因为"一个失败该怎么说"是一个会被反复用到、又很容易各自写错的判断。
 *
 * 取 `code`（`ENOSPC` / `EACCES` / `ENOENT` / `EXDEV`…）而不是 `name`：fs 错误的
 * `name` 永远是 `Error` —— 于是界面上的"写入新位置时失败（Error）"、日志里的
 * `{"reason":"Error"}` 等于什么都没说。失败原因必须落到用户能行动的那一层
 * （磁盘满 / 位置不可写 / 位置被删），否则那条错误信息唯一的用处是让人知道"出错了"。
 *
 * 只含 errno 与错误类名，**不含路径**（INVARIANTS G-3），因此同一个字符串可以同时
 * 出现在日志与界面上，不需要两套措辞。
 */

/** 一次没有结构化原因的失败，原因是什么。 */
export function failureReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code
  if (typeof code === 'string' && code !== '') return code

  return error instanceof Error ? error.name : 'unknown'
}
