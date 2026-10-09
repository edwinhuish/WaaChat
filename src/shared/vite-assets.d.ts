/**
 * Vite 资源导入的类型声明。
 *
 * `?raw` 后缀是 Vite 的能力：构建时把文件内容作为字符串内联进产物。
 * 这里用它来内联 SQL schema —— 否则 schema.sql 需要作为额外资源被打进安装包，
 * 而 electron-builder 的 `files` 只包含 `out/**`（见 electron-builder.yml）。
 *
 * 内联的额外好处：schema 与使用它的代码在同一个产物里，不会出现"文件没被打包进去"
 * 这类只在安装后才暴露的问题。
 */

declare module '*.sql?raw' {
  const content: string
  export default content
}
