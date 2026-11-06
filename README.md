# C 一键调试

给 VS Code 加上"C 语言开箱即用"的体验：**一键生成 `tasks.json` / `launch.json`，点一下就能要么停在 `main` 单步调试，要么直接跑完看结果。**

不用再手写 `${fileDirname}`、不用记 `miDebuggerPath`、也不用每次手动点行号打第一个断点。

## 功能

| 能力 | 说明 |
| --- | --- |
| 自动断点调试 | 解析源码定位 `main`，下好断点再启动 gdb，程序一启动就停在该看的地方 |
| 直接运行 | 编译后在集成终端里跑完，不停断点，适合刷题、看输出 |
| 一键生成配置 | 自动探测 `gcc` / `gdb`，生成 `.vscode/tasks.json` 与 `launch.json` |
| 分别生成 | 也可以只生成 `tasks.json` 或只生成 `launch.json` |
| 覆盖前询问 | 目标文件已存在时先弹窗确认，可选「覆盖」「更新（保留其他配置）」「取消」 |
| 单文件 / 多文件 | `currentFile` 只编译当前文件；`folder` 编译工作区全部 `.c` 再链接 |
| 智能探测 | 依次查设置项、`PATH`、常见 MinGW / MSYS2 / TDM-GCC 目录；gdb 优先取与 gcc 同目录 |

## 安装

### 方式一：VSIX（推荐）

```bash
code --install-extension c-oneclick-debug-0.2.0.vsix
```

或在 VS Code 里 `Ctrl+Shift+P` → `Extensions: Install from VSIX...`。

### 方式二：直接拷贝目录

把整个 `c-oneclick-debug` 文件夹复制到扩展目录，然后重启 VS Code（或 `Developer: Reload Window`）：

- Windows: `%USERPROFILE%\.vscode\extensions\`
- macOS / Linux: `~/.vscode/extensions/`

### 方式三：从源码打包

```bash
git clone <你的仓库地址>
cd c-oneclick-debug
npx --yes @vscode/vsce package --no-dependencies
code --install-extension c-oneclick-debug-0.2.0.vsix
```

> 依赖 [Microsoft C/C++ 扩展](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools)（调试基于 `cppdbg`），已声明为 `extensionDependencies`，正常会自动安装。

## 使用

打开任意 `.c` 文件，**编辑器右上角会出现三个按钮**（不占用任何快捷键，避免和其他插件抢键位）：

| 按钮 | 图标 | 作用 |
| --- | --- | --- |
| 运行 | ▶ | 编译后直接在终端跑到结束 |
| 调试 | ▷ | 编译并**自动在 `main` 处断点**，停住后单步 |
| 配置 | ⚙ | 一键生成 `tasks.json` + `launch.json` |

点右上角运行按钮旁的下拉箭头（或右键 `.c` 文件）还能看到更细的命令：

- `只生成 tasks.json`
- `只生成 launch.json`
- `只编译，不运行`
- `在 main 函数处设置断点`

命令面板（`Ctrl+Shift+P`）搜 `C:` 同样可以调用全部命令。

### 覆盖确认

生成配置时，如果目标文件已存在，会弹窗问你：

```
tasks.json、launch.json 已存在，是否覆盖？
  [ 更新（推荐） ]  [ 覆盖 ]  [ 取消 ]
```

- **更新**：只更新/追加本扩展生成的那一条，你自己写的任务和调试配置原样保留
- **覆盖**：丢弃文件原有内容，只保留扩展生成的配置
- **取消**（或按 Esc）：不动文件

文件本来就不存在时不会弹窗，直接写。

### 两种模式的区别

| | 运行 ▶ | 调试 ▷ |
| --- | --- | --- |
| 是否进调试器 | 否，直接在终端跑 | 是，gdb 接管 |
| 断点 | 不生效（也不会添加） | 自动在 `main` 打断点 |
| 输入 `scanf` | 天然可用 | 建议开 `cDebug.externalConsole` |
| 适合 | 快速看结果 | 单步、看变量、找 bug |

## 生成的文件

`.vscode/tasks.json`：

```json
{
    "version": "2.0.0",
    "tasks": [
        {
            "type": "process",
            "label": "C: 编译当前文件",
            "command": "D:/Program Files/mingw64/bin/gcc.exe",
            "args": ["-g", "-O0", "-Wall", "-Wextra", "${file}", "-o", "${fileDirname}/hello.exe"],
            "options": { "cwd": "${fileDirname}" },
            "problemMatcher": ["$gcc"],
            "group": { "kind": "build", "isDefault": true }
        }
    ]
}
```

`.vscode/launch.json`：

```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "name": "C: 自动断点调试",
            "type": "cppdbg",
            "request": "launch",
            "program": "${fileDirname}/hello.exe",
            "args": [],
            "stopAtEntry": false,
            "cwd": "${fileDirname}",
            "environment": [],
            "externalConsole": false,
            "MIMode": "gdb",
            "miDebuggerPath": "D:/Program Files/mingw64/bin/gdb.exe",
            "setupCommands": [
                { "description": "为 gdb 启用整齐打印", "text": "-enable-pretty-printing", "ignoreFailures": true }
            ],
            "preLaunchTask": "C: 编译当前文件"
        }
    ]
}
```

## 设置项

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `cDebug.buildMode` | `currentFile` | 编译范围：当前文件 / 工作区全部 `.c` |
| `cDebug.compilerPath` | 空 | 编译器绝对路径，留空自动探测 |
| `cDebug.debuggerPath` | 空 | gdb 绝对路径，留空自动探测 |
| `cDebug.compilerArgs` | `-g -O0 -Wall -Wextra` | 编译参数（`-g -O0` 保证可调试） |
| `cDebug.programArgs` | `[]` | 程序运行参数 |
| `cDebug.externalConsole` | `false` | 调试时用外部控制台（需要 `scanf` 时建议开） |
| `cDebug.buildBeforeDebug` | `true` | 调试前自动编译 |
| `cDebug.autoBreakpoint` | `true` | 调试时自动在 `main` 下断点 |
| `cDebug.breakpointMode` | `keep` | `keep` 保留断点；`once` 停在 main 后自动移除 |
| `cDebug.autoBreakpointScope` | `managed` | `managed` 只管扩展生成的配置；`all` 接管所有 `cppdbg` |
| `cDebug.autoGenerateConfig` | `true` | 缺少配置时自动生成 |
| `cDebug.syncConfigOnDebug` | `true` | 运行/调试时按设置刷新生成的那一条；手改党可关 |

## 常见问题

**找不到编译器** — 装 [MinGW-w64](https://www.mingw-w64.org/downloads/) 并把 `bin` 加进 `PATH`，或在设置里填 `cDebug.compilerPath`。

**能编译、能运行，但调试起不来** — 检查 `cDebug.debuggerPath` 是否指向有效的 `gdb.exe`；MinGW 的 gdb 一般和 gcc 同目录。

**断点是灰色圈 / 不停** — 通常没带 `-g` 编译。默认参数已含 `-g -O0`，改 `cDebug.compilerArgs` 时别把它们删了。

**调试时输入 `scanf` 没反应** — 打开 `cDebug.externalConsole`，程序会在独立控制台窗口运行。

**中文输出乱码** — Windows 控制台编码问题，可在程序里 `system("chcp 65001");`。

**多文件项目报 `multiple definition of main`** — 工作区里有多个 `main`，把 `cDebug.buildMode` 改回 `currentFile`。

---

## 发布到 VS Code 插件市场

### 1. 注册两样东西

1. **Azure DevOps 账号**：<https://dev.azure.com>（用微软账号登录即可，免费）
2. **Marketplace 发布者**：<https://marketplace.visualstudio.com/manage> → `Create publisher`

   记下 **Publisher ID**（不是显示名），并保证它与 `package.json` 里的 `publisher` 完全一致。当前是 `woodendrifter`，改成你自己的。

### 2. 生成 Personal Access Token（PAT）

Azure DevOps → 右上角头像 → `Personal access tokens` → `New Token`：

- **Organization**：选 `All accessible organizations`
- **Expiration**：最长 1 年
- **Scopes**：点 `Show all scopes`，只勾 **Marketplace → Manage**

token 只显示一次，先复制出来。

### 3. 打包并发布

```bash
cd c-oneclick-debug

# 先本地自检：能不能打包成功
npx --yes @vscode/vsce package --no-dependencies

# 登录（把 token 存到本地，二选一）
npx --yes @vscode/vsce login woodendrifter
# 或者每次发布都传 token
npx --yes @vscode/vsce publish --no-dependencies -p <你的PAT>

# 后续发版：改 package.json 的 version，然后
npx --yes @vscode/vsce publish minor    # 0.2.0 -> 0.3.0
npx --yes @vscode/vsce publish patch    # 0.2.0 -> 0.2.1
```

`vsce publish` 会自动打包、上传、递增版本号。发布后几分钟内就能在 Marketplace 搜到，也可以直接分享链接：

```
https://marketplace.visualstudio.com/items?itemName=woodendrifter.c-oneclick-debug
```

### 发布前检查清单

- [ ] `package.json` 的 `publisher` 与 Marketplace 发布者 ID 一致
- [ ] `name` 全小写，只含字母数字和连字符
- [ ] `version` 比线上版本大
- [ ] `displayName` / `description` / `categories` / `keywords` 填好（影响搜索）
- [ ] `README.md` 会作为详情页，写清楚怎么用
- [ ] `LICENSE` 文件存在，`license` 字段一致
- [ ] `icon` 为 128×128 PNG
- [ ] `repository` 字段填上 GitHub 地址（否则有一条 warning）
- [ ] `.vscodeignore` 排除 `test/`、`tools/` 等（已配好）

常见报错：

| 报错 | 原因 |
| --- | --- |
| `This publisher is not verified` | 发布者没创建，或 ID 拼错 |
| `Personal Access Token verification has failed` | PAT 没勾 `Marketplace → Manage`，或组织没选 All accessible |
| `Version 0.2.0 is already published` | 忘改版本号 |
| `Missing publisher name` | `package.json` 缺 `publisher` |

## 托管到 GitHub

### 1. 推到 GitHub

```bash
cd c-oneclick-debug
git init
git add .
git commit -m "feat: C 一键调试扩展 0.2.0"
git branch -M main

# 先在 GitHub 网页新建一个空仓库，再把地址填进来
git remote add origin https://github.com/<你的用户名>/c-oneclick-debug.git
git push -u origin main
```

### 2. 把 vsix 挂到 Release

```bash
npx --yes @vscode/vsce package --no-dependencies   # 生成 c-oneclick-debug-0.2.0.vsix

# 用 GitHub CLI（需先 gh auth login）
gh release create v0.2.0 c-oneclick-debug-0.2.0.vsix --title "v0.2.0" --notes "首个版本"

# 或者手动：仓库页 Releases -> Draft a new release -> 上传 vsix
```

仓库里已放好 `.github/workflows/release.yml`：以后只要推一个 `v*` 标签，CI 自动打包 vsix 并挂到 Release。

```bash
git tag v0.2.0
git push origin v0.2.0
```

> 想顺便自动发市场？在仓库 Settings → Secrets 加一个 `VSCE_PAT`（就是上面那个 token），再把 workflow 里注释掉的 publish 步骤打开。

### 3. 别人怎么本地安装

**A. 下载 vsix（最简单）**

从仓库 Releases 下载 `c-oneclick-debug-0.2.0.vsix`，然后：

```bash
code --install-extension c-oneclick-debug-0.2.0.vsix
```

或 VS Code 里 `Ctrl+Shift+P` → `Extensions: Install from VSIX...` → 选文件 → 重启窗口。

**B. 直接拷贝源码目录（适合改着玩）**

```bash
git clone https://github.com/<你的用户名>/c-oneclick-debug.git
# 把 c-oneclick-debug 整个文件夹复制到扩展目录
#   Windows: %USERPROFILE%\.vscode\extensions\
#   macOS/Linux: ~/.vscode/extensions/
```

重启 VS Code 即可。改完代码 `Developer: Reload Window` 就生效（纯 JS，无编译步骤）。

**C. 克隆后自己打包**

```bash
git clone https://github.com/<你的用户名>/c-oneclick-debug.git
cd c-oneclick-debug
npx --yes @vscode/vsce package --no-dependencies
code --install-extension c-oneclick-debug-0.2.0.vsix
```

**D. 开发调试这个扩展**

用 VS Code 打开源码目录按 `F5`，会启动一个"扩展开发宿主"窗口，里面加载的是当前源码，可以直接给扩展下断点。仓库已带 `.vscode/launch.json`。

## 开发

```bash
node test/run-tests.js        # 核心逻辑测试（不需要启动 VS Code）
node tools/make-icon.js       # 重新生成图标
npm run package               # 打包 vsix
```

源码结构：

```
src/
  extension.js    命令注册、流程编排（运行 / 调试 / 三种生成）
  toolchain.js    编译器与调试器探测
  csource.js      源码解析（main 定位、源文件收集）
  configFiles.js  tasks / launch 生成与合并（含 JSONC 解析、覆盖策略）
  debug.js        调试启动、断点管理、编译执行
  output.js       输出面板
```
