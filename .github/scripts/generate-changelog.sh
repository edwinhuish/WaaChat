#!/bin/bash
# generate-changelog.sh —— 从提交历史生成 Release 的发布说明。
#
# 由 `.github/workflows/release.yml` 调用，产物（默认 release-notes.md）由工作流用
# `gh release edit --notes-file` 写入 Release body —— **不**经过 electron-builder 的
# `releaseInfo.releaseNotesFile`：那个键刻意不设（显式点名一个缺失的资源会**抛错**，
# 而且每次构建都会读它）。见 electron-builder.yml 的注释与 ADR-0014。
#
# 用法:
#   ./generate-changelog.sh <当前标签> [前一个标签] [输出文件]
#
#   <当前标签>    必填，如 v0.2.0
#   [前一个标签]  可省略。省略、或在本地不存在时，对比范围是当前标签的**全部**历史
#   [输出文件]    默认 release-notes.md
#
# 环境变量:
#   GH_TOKEN / GITHUB_TOKEN   有则用它查提交对应的 GitHub 用户名（失败时退回 git 作者名）
#   GITHUB_REPOSITORY         有则用它拼对比链接，否则从 git remote 推断
#   GITHUB_STEP_SUMMARY       设置了就一并写进 Actions 的步骤摘要
#   GITHUB_OUTPUT             设置了就输出 notes_file（GitHub Actions 的步骤输出）

set -eu

if [ $# -lt 1 ] || [ $# -gt 3 ]; then
  echo "Usage: $0 <current_tag> [previous_tag] [output_file]" >&2
  exit 1
fi

current_tag="$1"
previous_tag="${2:-}"
output_file="${3:-release-notes.md}"

# 拼对比链接用的仓库地址
repo_slug="${GITHUB_REPOSITORY:-}"
if [ -z "$repo_slug" ]; then
  repo_slug=$(git config --get remote.origin.url | sed -E 's#^.*github\.com[:/]([^/]+/[^/]+?)(\.git)?$#\1#')
fi
if [ -z "$repo_slug" ]; then
  echo "⚠️ 无法推断仓库地址（GITHUB_REPOSITORY 为空，git remote 也不是 GitHub 地址）：对比链接会不完整" >&2
fi

# 前一个标签必须真实存在于本地。浅克隆或标签被重命名时 `git log` 会直接失败，把整个发布
# 卡住 —— 而这只需退回"全量历史"就能继续。
if [ -n "$previous_tag" ] && ! git rev-parse -q --verify "refs/tags/$previous_tag" >/dev/null; then
  echo "⚠️ 标签 $previous_tag 在本地不存在，退回全量历史" >&2
  previous_tag=""
fi

if [ -z "$previous_tag" ]; then
  commit_range="$current_tag"
  echo "ℹ️ 没有可用的前一个版本标签：$current_tag 的全部历史都会进发布说明"
else
  commit_range="$previous_tag..$current_tag"
fi

gh_token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"

# 用 commit SHA 反查对应的 GitHub 登录用户名，失败时回退到 git 作者名
resolve_login() {
  sha="$1"
  fallback="$2"
  login=""
  if [ -n "$repo_slug" ] && [ -n "$gh_token" ]; then
    login=$(curl -sf \
      -H "Authorization: Bearer $gh_token" \
      -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/$repo_slug/commits/$sha" \
      | grep -o '"login"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | sed -E 's/.*"login"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/' || true)
  fi
  if [ -n "$login" ]; then
    echo "$login"
  else
    echo "$fallback"
  fi
}

# 只认约定式提交（ai/CONVENTIONS.md 第 9 节）里用户可见的那几种类型，并且类型必须在行首。
# 否则用 `*feat*` 这类通配去匹配整行时，"fix the feature list" 会同时出现在 Feats 与
# Fixes 两节里；`chore(release): v0.2.0` 这类机械提交也不该出现在自己版本的说明里。
commit_type_re='^(feat|fix|perf|refactor|docs)(\([^)]*\))?!?:'

sections_dir=$(mktemp -d)
trap 'rm -rf "$sections_dir"' EXIT

while IFS=$'\t' read -r full_sha subject author_name short_sha; do
  [ -n "$full_sha" ] || continue

  if [[ "$subject" =~ $commit_type_re ]]; then
    type="${BASH_REMATCH[1]}"
  else
    continue
  fi

  user=$(resolve_login "$full_sha" "$author_name")
  # 反引号转义：标题里落单的反引号会把其后整段 Markdown 一起吃掉
  printf '%s\n' "- ${subject//\`/\\\`} - by @$user ($short_sha)" >> "$sections_dir/$type"
done <<< "$(git log --pretty=format:"%H%x09%s%x09%an%x09%h" "$commit_range")"

notes=""
has_sections=false

append_section() {
  section_file="$1"
  section_title="$2"
  if [ -s "$section_file" ]; then
    notes="${notes}### ${section_title}"$'\n\n'
    notes="${notes}$(cat "$section_file")"$'\n\n'
    has_sections=true
  fi
}

append_section "$sections_dir/feat" '🚀 Features 新功能'
append_section "$sections_dir/fix" '🩹 Fixes 缺陷修复'
append_section "$sections_dir/perf" '🔥 Performance 性能优化'
append_section "$sections_dir/refactor" '🔨 Refactor 代码重构'
append_section "$sections_dir/docs" '📖 Documentation 文档'

# 全是 chore / ci / test 一类提交时也要给出说明，而不是一个空的 Release body
if [ "$has_sections" = false ]; then
  notes="本版本没有可归类的用户可见改动（提交历史里没有 \`feat\` / \`fix\` / \`perf\` / \`refactor\` / \`docs\` 前缀的提交）。"$'\n'
fi

notes="${notes}"$'\n'"---"$'\n\n'

if [ -n "$previous_tag" ]; then
  notes="${notes}**完整变更**：[\`${previous_tag}...${current_tag}\`](https://github.com/${repo_slug}/compare/${previous_tag}...${current_tag})"$'\n\n'
else
  notes="${notes}**完整变更**：[\`${current_tag}\` 的全部提交](https://github.com/${repo_slug}/commits/${current_tag})"$'\n\n'
fi

# 每份发布说明都自带非官方声明：Release 页面是用户第一次接触这个项目的地方之一
notes="${notes}> WaaChat 是一个**非官方**的第三方客户端外壳，与 Meta / WhatsApp 没有隶属、授权或背书关系。详见 [DISCLAIMER.md](https://github.com/${repo_slug}/blob/main/DISCLAIMER.md)。"$'\n'

printf '%s\n' "$notes" > "$output_file"
echo "📝 发布说明已写入 $output_file："
cat "$output_file"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf '%s\n' "$notes" >> "$GITHUB_STEP_SUMMARY"
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "notes_file=$output_file" >> "$GITHUB_OUTPUT"
fi
