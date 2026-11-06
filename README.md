# C/C++ 一键调试

给 VS Code 里的 C 与 C++ 开发补上「开箱即用」的那一层：不用手写 `tasks.json` 和 `launch.json`，点一下就能编译运行，再点一下就能停在 `main` 里单步调试。

## 功能

- **C 与 C++ 都支持**：`.c` 用 gcc 编译，`.cpp` / `.cc` / `.cxx` 自动换成 g++；两者生成的配置互不覆盖
- **一键生成配置**：`tasks.json` 与 `launch.json` 自动写好，编译器 / 调试器路径自动探测（gcc、g++、clang、MinGW-w64、MSYS2）
- **自动断点调试**：启动时自动解析当前文件的 `main`，在函数体内第一条可执行语句下断点，程序直接停在那里
- **直接跑到结束**：不想调试时，在终端里编译并执行，输出、`scanf` / `cin` 输入都正常
- **两种编译范围**：只编译当前文件（单文件练习），或编译目录下全部同类源码并链接（多文件项目）
- **可分别生成**：`tasks.json` 与 `launch.json` 可以单独生成，也可以一次生成两份
- **不破坏已有配置**：文件已存在时先弹窗询问，选「更新」只改自己那一条，你手写的任务和调试配置原样保留

## 环境要求

| 依赖 | 说明 |
| --- | --- |
| VS Code | 1.80 或更高 |
| C/C++ 扩展 | `ms-vscode.cpptools`，调试（cppdbg）依赖它 |
| 编译器 | C 需要 `gcc`，C++ 需要 `g++`（MinGW-w64 两者都带），或对应的 clang / clang++ |
| 调试器 | `gdb`，MinGW-w64 自带；只运行不调试的话可以不装 |

编译器不在 PATH 里也没关系，扩展会去常见安装位置找；还找不到就在设置里填绝对路径。

## 安装

三种方式任选其一，装完执行 `Ctrl+Shift+P` → `Developer: Reload Window` 生效。

### 方式一：装打包好的 vsix（最省事）

在仓库的 Release 页面下载 `c-oneclick-debug-x.y.z.vsix`，然后：

```bash
code --install-extension c-oneclick-debug-0.4.0.vsix
```

也可以打开 VS Code，在扩展面板右上角点 `...` → `从 VSIX 安装`，选中下载的文件。

### 方式二：克隆源码自己打包

需要 Node.js 18 以上。

```bash
git clone https://github.com/WoodenDrifter/c-oneclick-debug.git
cd c-oneclick-debug
npx --yes @vscode/vsce package --no-dependencies
code --install-extension c-oneclick-debug-0.4.0.vsix
```

### 方式三：直接放源码目录（免打包）

扩展是纯 JavaScript，没有编译步骤，把文件夹拷进去就能用：

```bash
# Windows
xcopy /E /I c-oneclick-debug "%USERPROFILE%\.vscode\extensions\woodendrifter.c-oneclick-debug-0.4.0"
```

```bash
# macOS / Linux
cp -r c-oneclick-debug ~/.vscode/extensions/woodendrifter.c-oneclick-debug-0.4.0
```

重启 VS Code 即可。这种方式不会出现在扩展列表里，但功能完全可用；改完代码 Reload Window 就生效。

### 卸载

```bash
code --uninstall-extension woodendrifter.c-oneclick-debug
```

方式三装的直接删目录。

## 使用

打开任意 `.c` / `.cpp` 文件后，有四个入口，做的事完全一样：

| 入口 | 位置 |
| --- | --- |
| **命令面板**（最稳） | `Ctrl+Shift+P`，输入 `C/C++` 或 `C:`，所有命令都在，任何编辑器和任何文件类型下都能搜到 |
| **状态栏按钮** | 右下角 `⚙ C/C++ 配置`，只在 C / C++ 文件激活时出现，点开是完整菜单 |
| **编辑器标题栏** | ▶ 运行 · ▷ 调试 · ⚙ 配置（齿轮是下拉菜单，窗口窄时可能收进 `...`） |
| **右键菜单** | 编辑器内右键，或资源管理器里右键源文件 |

命令面板里搜 `C/C++` 会列出全部 8 个命令；如果图标按钮被别的扩展挤掉，从这里一样能用。

### 常用流程

**写作业 / 刷题**：打开 `main.c` 或 `main.cpp` → 状态栏 `⚙ C/C++ 配置` → `一键生成 tasks.json + launch.json` → 以后直接点 ▶ 运行。

**想看变量**：点 ▷ 调试，程序停在 `main` 里，左边变量面板就有值了。想让它别每次都停，把 `cDebug.autoBreakpoint` 关掉，改用 F9 自己下断点。

**C 和 C++ 混在一个目录里**：不用手动切换编译器。当前打开的是 `.c` 就用 gcc，`.cpp` 就用 g++，各自生成 `C:` / `C++:` 前缀的任务和启动配置，互不影响。

### 生成配置时的三种选择

`tasks.json` 或 `launch.json` 已经存在时会弹窗：

| 选项 | 效果 |
| --- | --- |
| **更新（推荐）** | 只更新或追加本扩展生成的那一条，你其他的任务、调试配置全部保留 |
| **覆盖** | 丢弃文件原有内容，只保留本扩展生成的配置 |
| **取消** | 一个字节都不改 |

文件不存在时不弹窗，直接写入。

### 多文件项目

默认只编译当前文件。要编译整个目录：设置里把 `cDebug.buildMode` 改成 `folder`，产物输出到工作区根目录。目录里有多个 `main` 时扩展会提醒你，因为一起链接会因重复定义失败。

## 设置

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `cDebug.buildMode` | `currentFile` | `currentFile` 编译当前文件；`folder` 编译工作区全部同类源码（C 收 `.c`，C++ 收 `.cpp/.cc/.cxx`） |
| `cDebug.compilerPath` | 空 | 编译器绝对路径，留空自动探测 |
| `cDebug.debuggerPath` | 空 | gdb 绝对路径，留空自动探测（优先同目录的 gdb） |
| `cDebug.compilerArgs` | `-g -O0 -Wall -Wextra` | 编译参数 |
| `cDebug.programArgs` | `[]` | 程序运行参数，运行和调试都会带上 |
| `cDebug.externalConsole` | `false` | 调试时用外部控制台窗口，调试中要输入时打开 |
| `cDebug.buildBeforeDebug` | `true` | 调试前自动编译 |
| `cDebug.autoBreakpoint` | `true` | 启动调试时自动在 `main` 处下断点 |
| `cDebug.breakpointMode` | `keep` | `once` 表示停在 main 后自动移除该断点 |
| `cDebug.autoBreakpointScope` | `managed` | `all` 表示对你自己的 cppdbg 配置也自动下断点 |
| `cDebug.autoGenerateConfig` | `true` | 缺配置文件时自动生成 |
| `cDebug.syncConfigOnDebug` | `true` | 每次运行 / 调试按当前设置刷新配置；习惯手改这两个文件的可以关掉 |

## 常见问题

**看不到任何按钮 / 图标被挤进 `...`**
窗口窄的时候编辑器标题栏放不下，图标会收进标题栏右侧的 `...` 里。最稳的入口是命令面板：`Ctrl+Shift+P` 输入 `C/C++`，八个命令全在。右下角的 `⚙ C/C++ 配置` 也只在 C / C++ 文件获得焦点时出现，点到终端或输出面板就会隐藏。

**装了没反应**
装完必须重载窗口：`Ctrl+Shift+P` → `Developer: Reload Window`。

**调试提示找不到 gdb**
MinGW-w64 的部分精简发行版不带 gdb。在终端执行 `gdb --version` 确认，没有就装完整版，或在 `cDebug.debuggerPath` 里填绝对路径。

**C++ 提示找不到 g++**
`gcc` 和 `g++` 是分开装的。终端执行 `g++ --version` 确认，或在 `cDebug.compilerPath` 里直接填 g++ 的绝对路径。

**`scanf` / `cin` 收不到输入**
调试模式下把 `cDebug.externalConsole` 打开；直接用 ▶ 运行则没有这个问题。

**编译报 `undefined reference`**
多文件项目里出现了多个 `main`，或者 `cDebug.buildMode` 还是 `currentFile`。改设置或只保留一个入口文件。

**改了配置不生效**
本扩展生成的配置名带语言前缀：`C: 自动断点调试` / `C++: 自动断点调试`，任务名是 `C: 编译当前文件` / `C++: 编译当前文件`，在 `.vscode/*.json` 里按名字找。

## 开发

```bash
npm test          # 50 项测试：配置合并、main 定位、C/C++ 真实编译、真实 gdb 断点命中、编排流程
npm run icon      # 重新生成图标
npm run package   # 打包 vsix
```

调试扩展本身：用 VS Code 打开本目录，F5 启动扩展开发宿主。

## 许可证

MIT
