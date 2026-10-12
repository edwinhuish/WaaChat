#!/usr/bin/env bash
#
# 产物校验。
#
# 存在的理由：桌面集成的问题**不会在构建时报错**。`StartupWMClass` 写错、
# 图标没进包、`chrome-sandbox` 丢了 setuid 位、AppImage 缺 FUSE —— 这些都要等
# 用户装完、双击、发现"没反应"或"图标是个齿轮"才会暴露。而这恰好是最贵的一类
# 反馈：它来自用户而不是 CI。
#
# 因此这里把"装完之后才看得出的事"变成构建期断言。`pnpm run verify` 与 CI 都会跑。
#
# 用法：
#   bash scripts/verify-package.sh [dist 目录]
#
# 依赖：dpkg-deb（deb 部分）、coreutils。缺工具时对应部分**跳过并明确说明**，
# 而不是安静地认为通过。
#
# ⚠️ 临时目录需要有空间：脚本会把 deb 整个解开（上百 MB），临时目录建在 $TMPDIR 下。
# 容器/精简环境里 /tmp 常是很小的 tmpfs（实测见过 10M），此时解包中途失败，脚本只以
# exit 2 退出 —— 看起来像"有两项断言失败"，其实根本没跑完，极难指到根因。
# 绕法：
#   TMPDIR=$PWD/.tmp bash scripts/verify-package.sh dist
# 判断磁盘够不够要用 `df -h .`（项目所在分区）而不是 `df -h /`。

set -euo pipefail

DIST="${1:-dist}"
APP_ID="io.github.edwinhuish.waachat"
EXECUTABLE="waachat"
# 随包附带的手动安装版 profile 的文件名。必须与 profile 内声明的名字、以及 deb
# postinst 的目标路径（electron-builder 固定用 executableName）三者同源。
# 详见 build/apparmor/waachat 的注释。
APPARMOR_NAME="waachat"

failures=0

ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() {
  printf '  \033[31m✗\033[0m %s\n' "$1"
  failures=$((failures + 1))
}
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ---------------------------------------------------------------------------
# 定位产物
# ---------------------------------------------------------------------------

section "产物"

if [ ! -d "$DIST" ]; then
  echo "找不到目录 $DIST —— 先跑 pnpm run pack" >&2
  exit 1
fi

# 用 find 而不是 glob：版本号变化、以及 electron-builder 对不同架构的命名差异，
# 都不该让这个脚本失效。
DEB="$(find "$DIST" -maxdepth 1 -name '*.deb' -print -quit || true)"
APPIMAGE="$(find "$DIST" -maxdepth 1 -name '*.AppImage' -print -quit || true)"

if [ -z "$DEB" ] && [ -z "$APPIMAGE" ]; then
  echo "$DIST 里既没有 .deb 也没有 .AppImage —— 先跑 pnpm run pack" >&2
  exit 1
fi

# 转成绝对路径：AppImage 的自解包检查要在临时目录里执行，
# 相对路径到了那边就指不到了。
if [ -n "$APPIMAGE" ]; then
  APPIMAGE="$(cd "$(dirname "$APPIMAGE")" && pwd)/$(basename "$APPIMAGE")"
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# ---------------------------------------------------------------------------
# deb
# ---------------------------------------------------------------------------

# 桌面条目的三处一致性（package.json / electron-builder.yml / index.ts）是
# 本项目最容易踩的坑，这里断言"产物里真的是那个值"。
check_desktop_entry() {
  local desktop="$1" label="$2"

  [ -f "$desktop" ] || {
    bad "$label：找不到 .desktop 条目"
    return
  }

  local wmclass
  wmclass="$(grep -E '^StartupWMClass=' "$desktop" | head -1 | cut -d= -f2- || true)"

  # 文件名本身也是身份的一部分，而且这一条最容易漏。
  #
  # GNOME 在 Wayland 下**直接用窗口的 app_id 去找同名 .desktop**
  # （app_id 来自 app.setDesktopName(DESKTOP_FILE_NAME)，即去掉 .desktop 后缀的名字）。
  # 文件名对不上 ⇒ 找不到条目 ⇒ Dock 显示占位图标、启动器不合并；而偏偏此时
  # StartupWMClass 是"对"的，所以只断言 WMClass 抓不到这个错。
  # 文件名由 electron-builder.yml 的 linux.syncDesktopName 控制（见那里的注释）。
  local base
  base="$(basename "$desktop")"
  if [ "$base" = "$APP_ID.desktop" ]; then
    ok "$label：条目文件名与 app_id 同源（$base）"
  else
    bad "$label：条目文件名是 '$base'，应为 '$APP_ID.desktop' —— GNOME 按 app_id 找同名文件，找不到就显示占位图标（检查 electron-builder.yml 的 linux.syncDesktopName）"
  fi

  if [ "$wmclass" = "$APP_ID" ]; then
    ok "$label：StartupWMClass=$APP_ID"
  else
    bad "$label：StartupWMClass 是 '${wmclass:-（缺失）}'，应为 $APP_ID（不一致会导致 Dock 显示占位图标、启动器不合并）"
  fi

  grep -qE '^Exec=' "$desktop" && ok "$label：Exec 存在" || bad "$label：缺 Exec"

  # 深链接（ADR-0083）需要**两条**都在，而且都只在产物里看得见：
  #
  #   MimeType  声明“whatsapp: 这个 scheme 归我们”
  #   Exec %U   让桌面环境把那个 URL 当**参数**传给我们
  #
  # 只断言 MimeType 会漏掉“关联建立了、但 URL 没传进来”这一半 —— 用户点链接之后
  # 应用会被拉起来、然后停在首页，看起来像“没反应”。反过来只断言 Exec 也一样。
  if grep -qE '^MimeType=.*x-scheme-handler/whatsapp' "$desktop"; then
    ok "$label：声明了 x-scheme-handler/whatsapp"
  else
    bad "$label：.desktop 里没有 x-scheme-handler/whatsapp —— 系统点 whatsapp: 链接不会找到我们（检查 electron-builder.yml 的 linux.desktop.entry.MimeType）"
  fi

  local exec_line
  exec_line="$(grep -E '^Exec=' "$desktop" | head -1 || true)"
  case "$exec_line" in
    *'%U'*) ok "$label：Exec 带 %U（链接会作为参数传进来）" ;;
    *) bad "$label：Exec 是 '${exec_line:-（缺失）}'，缺 %U —— 链接就算找到了我们，URL 也不会传进来（症状是“点了链接、应用开在首页”）" ;;
  esac

  grep -qE '^Icon=' "$desktop" && ok "$label：Icon 存在" || bad "$label：缺 Icon"
}

if [ -n "$DEB" ]; then
  section "deb：$(basename "$DEB")"

  if ! command -v dpkg-deb >/dev/null 2>&1; then
    warn "本机没有 dpkg-deb，跳过 deb 内容校验（在 Debian 系发行版上会执行）"
  else
    root="$work/deb"
    dpkg-deb -x "$DEB" "$root"

    # --- 可执行文件 ---------------------------------------------------------
    binary="$(find "$root/opt" -maxdepth 2 -type f -name "$EXECUTABLE" -print -quit 2>/dev/null || true)"
    if [ -n "$binary" ] && [ -x "$binary" ]; then
      ok "可执行文件存在且可执行：${binary#"$root"}"
    else
      bad "在 /opt 下找不到可执行的 $EXECUTABLE"
    fi

    # --- 桌面条目与图标 -----------------------------------------------------
    desktop="$(find "$root/usr/share/applications" -maxdepth 1 -name '*.desktop' -print -quit 2>/dev/null || true)"
    check_desktop_entry "$desktop" "deb"

    if [ -n "$(find "$root/usr/share/icons" -name "${EXECUTABLE}.png" -print -quit 2>/dev/null)" ]; then
      ok "hicolor 图标已安装"
    else
      warn "hicolor 目录下没有 ${EXECUTABLE}.png（多数桌面环境会回退到 Electron 默认图标）"
    fi

    # --- 运行期资源 ---------------------------------------------------------
    # 托盘图标必须能在运行时按路径读到。它走的是 extraResources，
    # 而不是 build/（build/ 是构建期资源，不进安装包）。
    if [ -f "$root/opt/WaaChat/resources/icon.png" ]; then
      ok "托盘图标已随包分发（resources/icon.png）"
    else
      bad "缺少 resources/icon.png —— 托盘会静默消失（见 integration/tray.ts 的降级分支）"
    fi

    # --- AppArmor -----------------------------------------------------------
    # 这里有两份 profile，职责不同，缺一份都要报：
    #
    #   1) resources/apparmor-profile    electron-builder **内建生成**，deb 的 postinst
    #      自动安装它。只覆盖 /opt/WaaChat/waachat。
    #   2) resources/apparmor/<name>     随包另附的完整版，覆盖 /opt/WaaChat/waachat 与
    #      AppImage 的 /tmp/.mount_*/waachat，供 AppImage 用户手动安装。
    #
    # 只断言"文件在包里"是不够的 —— 真正致命的失败模式是**路径对不上**：
    # postinst 引用的文件不存在时，apparmor_parser 的预检失败，脚本只打印一行
    # "Skipping the installation..." 就继续了，安装"成功"、profile 从未生效。
    # 所以下面还要把 postinst 里的路径读出来，回头验证它在包里真的存在。
    if [ -f "$root/opt/WaaChat/resources/apparmor-profile" ]; then
      ok "deb 自动安装的 profile 已随包分发（resources/apparmor-profile）"
    else
      bad "缺少 resources/apparmor-profile —— deb 的 postinst 会静默跳过 AppArmor 安装"
    fi

    if [ -f "$root/opt/WaaChat/resources/apparmor/$APPARMOR_NAME" ]; then
      ok "手动安装用的完整 profile 已随包分发（resources/apparmor/$APPARMOR_NAME）"
    else
      bad "缺少 resources/apparmor/$APPARMOR_NAME —— AppImage 用户将无从补救 user namespace 限制"
    fi

    ctl="$work/ctl"
    if dpkg-deb -e "$DEB" "$ctl" 2>/dev/null && [ -f "$ctl/postinst" ]; then
      # shellcheck disable=SC2016  # 单引号是 postinst 源码里的字面量，不是要展开的变量
      profile_src="$(grep -oE "APPARMOR_PROFILE_SOURCE='[^']*'" "$ctl/postinst" 2>/dev/null |
        head -1 | cut -d"'" -f2 || true)"
      if [ -z "$profile_src" ]; then
        warn "postinst 里没有 APPARMOR_PROFILE_SOURCE，跳过路径一致性检查"
      elif [ -e "$root$profile_src" ]; then
        ok "postinst 引用的 profile 路径确实存在：$profile_src"
      else
        bad "postinst 引用 $profile_src，但包里没有这个文件 —— 安装时会打印 Skipping 后跳过，profile 从不生效"
      fi
    fi

    # --- 沙箱 ---------------------------------------------------------------
    sandbox="$root/opt/WaaChat/chrome-sandbox"
    if [ ! -f "$sandbox" ]; then
      bad "缺少 chrome-sandbox —— Chromium 的进程沙箱无法建立"
    elif [ "$(stat -c '%a' "$sandbox")" = "4755" ]; then
      ok "chrome-sandbox 权限为 4755"
    else
      warn "chrome-sandbox 权限是 $(stat -c '%a' "$sandbox")（期望 4755）；本机依赖 AppArmor profile 那条路径"
    fi

    # --- 依赖 ---------------------------------------------------------------
    # 只打印不断言：默认列表由 electron-builder 按固定的 Electron 版本生成，
    # 我们刻意不手写（见 ADR-0004）。打印出来是为了在依赖腐坏时能一眼看到。
    printf '  · Depends: %s\n' "$(dpkg-deb -f "$DEB" Depends 2>/dev/null || echo '（读不到）')"
    printf '  · Recommends: %s\n' "$(dpkg-deb -f "$DEB" Recommends 2>/dev/null || echo '（无）')"
  fi
fi

# ---------------------------------------------------------------------------
# AppImage
# ---------------------------------------------------------------------------

if [ -n "$APPIMAGE" ]; then
  section "AppImage：$(basename "$APPIMAGE")"

  if [ ! -x "$APPIMAGE" ]; then
    bad "AppImage 没有可执行权限"
  else
    ok "可执行权限正常"
  fi

  # 运行期的 FUSE 依赖：静态 runtime（toolsets.appimage 1.0.3）应当不带 libfuse.so.2。
  # 老 runtime 在 Ubuntu 24.04+ 上会报 `dlopen(): error loading libfuse.so.2`。
  if command -v ldd >/dev/null 2>&1; then
    # 先取全文再匹配：`ldd | grep -q` 会因 grep 提前退出而触发 SIGPIPE，
    # 在 pipefail 下变成假失败。
    libs="$(ldd "$APPIMAGE" 2>/dev/null || true)"
    if printf '%s' "$libs" | grep -qi 'libfuse'; then
      bad "运行期仍依赖 libfuse —— 检查 electron-builder.yml 的 toolsets.appimage"
    else
      ok "运行期不依赖 libfuse"
    fi
  else
    warn "本机没有 ldd，跳过 FUSE 依赖检查"
  fi

  # `--appimage-extract` 由 runtime 自身实现（不解压到循环设备、不需要 FUSE），
  # 因此可以无显示器地在 CI 里验证"这个文件真的是一个能自解包的类型 2 AppImage"。
  (
    cd "$work"
    "$APPIMAGE" --appimage-extract >/dev/null 2>&1
  ) && extracted=1 || extracted=0

  if [ "$extracted" = "1" ] && [ -d "$work/squashfs-root" ]; then
    ok "AppImage 可自解包（runtime 正常）"

    if [ -x "$work/squashfs-root/AppRun" ]; then
      ok "AppRun 存在"
    else
      bad "解包后没有可执行的 AppRun"
    fi

    check_desktop_entry "$(find "$work/squashfs-root" -maxdepth 1 -name '*.desktop' -print -quit 2>/dev/null || true)" "AppImage"

    # AppImage 没有安装脚本，AppArmor profile 只能靠用户手动装 —— 至少要保证文件在包里，
    # 且文件名与 profile 内声明的名字一致（AppArmor 以文件内声明为准，但名字对不上会让
    # `apparmor_parser -r /etc/apparmor.d/x` 这类操作难以排查）。
    if [ -f "$work/squashfs-root/resources/apparmor/$APPARMOR_NAME" ]; then
      ok "手动安装用的 profile 已随包分发（resources/apparmor/$APPARMOR_NAME）"
    else
      bad "AppImage 里缺少 resources/apparmor/$APPARMOR_NAME —— 受限系统上无法补救 user namespace"
    fi
  else
    bad "AppImage 无法自解包 —— runtime 或打包方式有问题"
  fi
fi

# ---------------------------------------------------------------------------

section "结论"
if [ "$failures" -eq 0 ]; then
  printf '\033[32m全部断言通过。\033[0m\n'
else
  printf '\033[31m%d 项断言失败。\033[0m\n' "$failures"
fi

exit "$failures"
