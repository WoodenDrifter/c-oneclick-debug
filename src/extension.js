'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const { getOutput, log, reveal } = require('./output');
const { detectToolchain, getCompilerVersion } = require('./toolchain');
const { createPlan, writeConfigFiles, CONFIG_NAME } = require('./configFiles');
const { findEntryPoint, findFilesWithMain } = require('./csource');
const {
  CConfigProvider,
  setBreakpointAt,
  breakAtMain,
  registerAutoBreakpointTracker,
  runBuildTask,
  startDebugSession
} = require('./debug');

/** 复用同一个运行终端，避免每次运行都新开一个 */
/** @type {vscode.Terminal | undefined} */
let runTerminal;

/**
 * 取当前 C 文档（活动编辑器优先，其次任意可见的 C 编辑器）。
 * @returns {vscode.TextDocument | undefined}
 */
function getActiveCDocument() {
  const active = vscode.window.activeTextEditor;
  if (active && active.document.languageId === 'c') {
    return active.document;
  }
  const visible = vscode.window.visibleTextEditors.find((e) => e.document.languageId === 'c');
  return visible ? visible.document : undefined;
}

/**
 * 支持从资源管理器右键传入的 Uri。
 * @param {any} arg
 * @returns {Promise<vscode.TextDocument | undefined>}
 */
async function resolveDocument(arg) {
  if (arg && typeof arg.fsPath === 'string' && /\.c$/i.test(arg.fsPath)) {
    try {
      return await vscode.workspace.openTextDocument(arg);
    } catch {
      // 失败则退回活动编辑器
    }
  }
  return getActiveCDocument();
}

/**
 * @param {any} [arg]
 * @returns {Promise<vscode.TextDocument | undefined>}
 */
async function requireCDocument(arg) {
  const doc = await resolveDocument(arg);
  if (!doc) {
    vscode.window.showWarningMessage('请先打开一个 C 源文件（.c）再使用该命令。');
    return undefined;
  }
  if (doc.isUntitled) {
    vscode.window.showWarningMessage('请先保存该文件（Ctrl+S），未保存的文件无法编译和调试。');
    return undefined;
  }
  return doc;
}

/**
 * 判断本次是否需要写入 .vscode 配置。
 * @param {vscode.WorkspaceFolder | undefined} folder
 * @returns {boolean}
 */
function shouldSyncConfigs(folder) {
  if (!folder) return false;
  const cfg = vscode.workspace.getConfiguration('cDebug');
  if (cfg.get('syncConfigOnDebug', true)) return true;
  if (!cfg.get('autoGenerateConfig', true)) return false;
  const vscodeDir = path.join(folder.uri.fsPath, '.vscode');
  return (
    !fs.existsSync(path.join(vscodeDir, 'tasks.json')) || !fs.existsSync(path.join(vscodeDir, 'launch.json'))
  );
}

/**
 * 没有找到编译器时的引导。
 */
function showNoToolchainHelp() {
  vscode.window
    .showErrorMessage(
      '未找到 C 编译器（gcc / clang）。请安装 MinGW-w64 并加入 PATH，或在设置中指定编译器路径。',
      '打开设置',
      '查看输出'
    )
    .then((choice) => {
      if (choice === '打开设置') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'cDebug.compilerPath');
      } else if (choice === '查看输出') {
        reveal();
      }
    });
}

/**
 * 确保 C/C++ 扩展可用（调试依赖 cppdbg）。
 * @returns {Promise<boolean>}
 */
async function ensureCppTools() {
  const ext = vscode.extensions.getExtension('ms-vscode.cpptools');
  if (ext) return true;
  const choice = await vscode.window.showErrorMessage(
    '调试功能依赖 Microsoft C/C++ 扩展（cpptools）。是否立即安装？',
    '安装',
    '取消'
  );
  if (choice === '安装') {
    await vscode.commands.executeCommand('workbench.extensions.installExtension', 'ms-vscode.cpptools');
    vscode.window.showInformationMessage('安装完成后请重新加载窗口再试。');
  }
  return false;
}

/**
 * 保存脏文件（断点与编译都依赖磁盘上的内容）。
 * @param {vscode.TextDocument} doc
 */
async function saveAllDirty(doc) {
  if (doc.isDirty) await doc.save();
  if (vscode.workspace.textDocuments.some((d) => d.isDirty)) {
    await vscode.workspace.saveAll(false);
  }
}

/**
 * 生成计划前的公共准备：文档 + 工具链 + 编译计划。
 * @param {any} arg
 * @returns {Promise<{ doc: vscode.TextDocument, plan: any } | null>}
 */
async function preparePlan(arg) {
  const doc = await requireCDocument(arg);
  if (!doc) return null;

  const toolchain = detectToolchain();
  if (!toolchain) {
    showNoToolchainHelp();
    return null;
  }

  const plan = await createPlan(doc, toolchain);
  if (!plan) {
    vscode.window.showErrorMessage('没有找到可编译的 .c 源文件。');
    return null;
  }
  return { doc, plan };
}

/**
 * 询问如何写入已存在的配置文件。
 * @param {string[]} existingNames 例如 ['tasks.json', 'launch.json']
 * @returns {Promise<'overwrite'|'merge'|undefined>}
 */
async function askOverwrite(existingNames) {
  const choice = await vscode.window.showWarningMessage(
    `${existingNames.join('、')} 已存在，是否覆盖？`,
    {
      modal: true,
      detail:
        '覆盖：丢弃文件原有内容，只保留本扩展生成的配置。\n更新：只更新/追加本扩展生成的那一条，保留你其他的任务或调试配置。\n取消：不做任何修改。'
    },
    '更新（推荐）',
    '覆盖',
    '取消'
  );
  if (choice === '覆盖') return 'overwrite';
  if (choice === '更新（推荐）') return 'merge';
  return undefined;
}

/**
 * 命令：生成配置。which 为 'tasks' | 'launch' | 'all'
 * @param {'tasks'|'launch'|'all'} which
 * @param {any} [arg]
 */
async function commandGenerate(which, arg) {
  const prepared = await preparePlan(arg);
  if (!prepared) return undefined;
  const { plan } = prepared;

  if (!plan.workspaceFolder) {
    vscode.window.showWarningMessage('当前文件不在任何工作区文件夹中，无法写入 .vscode 配置。请用文件夹方式打开项目。');
    return undefined;
  }

  // folder 模式下多入口会导致链接失败，提前提醒
  if (plan.mode === 'folder') {
    const mains = await findFilesWithMain();
    if (mains.length > 1) {
      const names = mains.map((u) => path.basename(u.fsPath)).join('、');
      const choice = await vscode.window.showWarningMessage(
        `检测到 ${mains.length} 个文件包含 main（${names}），一起编译会因重复定义而失败。`,
        '改为只编译当前文件',
        '仍然继续'
      );
      if (choice === '改为只编译当前文件') {
        await vscode.workspace
          .getConfiguration('cDebug')
          .update('buildMode', 'currentFile', vscode.ConfigurationTarget.Workspace);
        return commandGenerate(which, arg);
      }
      if (!choice) return undefined;
    }
  }

  const targets = which === 'all' ? ['tasks', 'launch'] : [which];
  const vscodeDir = path.join(plan.workspaceFolder.uri.fsPath, '.vscode');

  const existing = targets.filter((t) => fs.existsSync(path.join(vscodeDir, `${t}.json`)));
  let mode = 'merge';
  if (existing.length) {
    const answer = await askOverwrite(existing.map((t) => `${t}.json`));
    if (!answer) {
      log('用户取消了配置生成');
      return undefined;
    }
    mode = answer;
  }

  const result = writeConfigFiles(plan, { tasksMode: mode, launchMode: mode, only: targets });
  const version = getCompilerVersion(plan.toolchain.compiler) || '未知';
  log(`工具链: ${version}`);

  const written = targets.map((t) => `${t}.json`).join(' 与 ');
  const detail = [
    `编译器：${plan.toolchain.compiler}`,
    plan.toolchain.debuggerPath
      ? `调试器：${plan.toolchain.debuggerPath}`
      : '调试器：未找到 gdb（调试不可用，运行不受影响）',
    `产物：${plan.programAbs}`,
    `模式：${plan.mode === 'folder' ? '编译工作区全部 .c' : '只编译当前文件'}`
  ].join('\n');

  vscode.window
    .showInformationMessage(`已生成 ${written}\n${detail}`, '运行', '调试')
    .then((choice) => {
      if (choice === '运行') vscode.commands.executeCommand('cDebug.run');
      else if (choice === '调试') vscode.commands.executeCommand('cDebug.debug');
    });

  return { mode, ...result };
}

/**
 * 命令：编译并运行（一直跑到结束，不会停在断点）
 * @param {any} [arg]
 */
async function commandRun(arg) {
  const prepared = await preparePlan(arg);
  if (!prepared) return;
  const { doc, plan } = prepared;

  await saveAllDirty(doc);

  if (shouldSyncConfigs(plan.workspaceFolder)) {
    writeConfigFiles(plan);
    if (plan.workspaceFolder) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  const build = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `正在编译 ${path.basename(plan.programAbs)}`,
      cancellable: false
    },
    () => runBuildTask(plan)
  );

  if (!build.ok) {
    const choice = await vscode.window.showErrorMessage(
      `编译失败${typeof build.code === 'number' && build.code >= 0 ? `（退出码 ${build.code}）` : ''}，已取消运行。`,
      '查看输出'
    );
    if (choice === '查看输出') reveal();
    return;
  }

  if (!runTerminal || runTerminal.exitStatus !== undefined) {
    runTerminal = vscode.window.createTerminal({ name: 'C 运行', cwd: plan.cwdAbs });
  }
  runTerminal.show(true);

  const shell = String(vscode.env.shell || '').toLowerCase();
  const isPowerShell = shell.includes('powershell') || shell.includes('pwsh');
  const quote = (s) => (/\s/.test(s) ? `"${s}"` : s);
  const args = (plan.programArgs || []).map(quote).join(' ');
  const exe = quote(plan.programAbs);
  const command = isPowerShell ? `& ${exe}${args ? ` ${args}` : ''}` : `${exe}${args ? ` ${args}` : ''}`;

  log(`运行: ${command}`);
  runTerminal.sendText(command, true);
}

/**
 * 命令：编译并自动断点调试
 * @param {any} [arg]
 */
async function commandDebug(arg) {
  const doc = await requireCDocument(arg);
  if (!doc) return;

  if (!(await ensureCppTools())) return;

  const toolchain = detectToolchain();
  if (!toolchain) {
    showNoToolchainHelp();
    return;
  }
  if (!toolchain.debuggerPath) {
    const choice = await vscode.window.showWarningMessage(
      '未找到 gdb，调试器可能无法启动。请安装 MinGW-w64 自带的 gdb，或在设置中指定路径。',
      '仍然继续',
      '打开设置'
    );
    if (choice === '打开设置') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'cDebug.debuggerPath');
      return;
    }
    if (!choice) return;
  }

  const plan = await createPlan(doc, toolchain);
  if (!plan) {
    vscode.window.showErrorMessage('没有找到可编译的 .c 源文件。');
    return;
  }

  const cfg = vscode.workspace.getConfiguration('cDebug');
  await saveAllDirty(doc);

  if (shouldSyncConfigs(plan.workspaceFolder)) {
    writeConfigFiles(plan);
    if (plan.workspaceFolder) {
      // 让 VS Code 重新索引刚写入的任务
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  if (cfg.get('autoBreakpoint', true)) {
    const entry = await findEntryPoint(doc, plan.mode);
    if (entry) {
      setBreakpointAt(entry.uri, entry.position);
    } else {
      vscode.window.showWarningMessage('未找到 main 函数，本次不会自动添加断点。');
    }
  }

  if (cfg.get('buildBeforeDebug', true)) {
    const build = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `正在编译 ${path.basename(plan.programAbs)}`,
        cancellable: false
      },
      () => runBuildTask(plan)
    );
    if (!build.ok) {
      const choice = await vscode.window.showErrorMessage(
        `编译失败${typeof build.code === 'number' && build.code >= 0 ? `（退出码 ${build.code}）` : ''}，已取消调试。`,
        '查看输出'
      );
      if (choice === '查看输出') reveal();
      return;
    }
  }

  const started = await startDebugSession(plan);
  if (!started) {
    vscode.window.showErrorMessage('无法启动调试会话，请检查 launch.json 与 gdb 配置。', '查看输出').then((c) => {
      if (c === '查看输出') reveal();
    });
  }
}

/**
 * 命令：只编译，不运行
 * @param {any} [arg]
 */
async function commandBuildOnly(arg) {
  const prepared = await preparePlan(arg);
  if (!prepared) return;
  const { doc, plan } = prepared;

  if (doc.isDirty) await doc.save();

  if (shouldSyncConfigs(plan.workspaceFolder)) {
    writeConfigFiles(plan);
    if (plan.workspaceFolder) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  const build = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: '正在编译', cancellable: false },
    () => runBuildTask(plan)
  );

  if (build.ok) {
    vscode.window.showInformationMessage(`编译成功：${plan.programAbs}`);
  } else {
    vscode.window.showErrorMessage('编译失败。', '查看输出').then((c) => {
      if (c === '查看输出') reveal();
    });
  }
}

/**
 * 命令：在 main 处下断点
 * @param {any} [arg]
 */
async function commandBreakAtMain(arg) {
  const doc = await requireCDocument(arg);
  if (!doc) return;
  const ok = await breakAtMain(doc);
  if (!ok) {
    vscode.window.showWarningMessage('当前文件中没有找到 main 函数。');
    return;
  }
  vscode.window.setStatusBarMessage('已在 main 函数处设置断点', 3000);
}

/**
 * 快捷面板条目。状态栏按钮和命令面板都走这里，避免两处维护。
 */
const PANEL_ITEMS = [
  {
    label: '$(gear) 一键生成 tasks.json + launch.json',
    description: '建立调试环境（已存在会先询问覆盖策略）',
    command: 'cDebug.generateAll'
  },
  {
    label: '$(checklist) 只生成 tasks.json',
    description: '仅写入编译任务',
    command: 'cDebug.generateTasks'
  },
  {
    label: '$(bug) 只生成 launch.json',
    description: '仅写入调试配置',
    command: 'cDebug.generateLaunch'
  },
  {
    label: '$(play) 编译并运行（跑到结束）',
    description: '不进调试器，终端直接执行',
    command: 'cDebug.run'
  },
  {
    label: '$(debug-alt) 编译并自动断点调试',
    description: '启动后停在 main 第一条语句',
    command: 'cDebug.debug'
  },
  {
    label: '$(tools) 只编译，不运行',
    description: '检查语法与链接错误',
    command: 'cDebug.buildOnly'
  },
  {
    label: '$(circle-filled) 在 main 处设置断点',
    description: '只下断点，不启动',
    command: 'cDebug.breakAtMain'
  }
];

/**
 * 状态栏常驻按钮：只有当前编辑器是 .c 文件时才出现。
 * @param {vscode.ExtensionContext} context
 */
function registerStatusBar(context) {
  if (typeof vscode.window.createStatusBarItem !== 'function') return;
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.text = '$(gear) C 配置';
  item.tooltip = 'C 一键调试：生成 tasks.json / launch.json、运行、调试';
  item.command = 'cDebug.panel';

  const refresh = () => {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'c') item.show();
    else item.hide();
  };
  refresh();

  context.subscriptions.push(item, vscode.window.onDidChangeActiveTextEditor(refresh));
}

/**
 * 命令：快捷面板（状态栏按钮入口）。
 * @param {any} [arg]
 */
async function commandPanel(arg) {
  const picked = await vscode.window.showQuickPick(PANEL_ITEMS, {
    title: 'C 一键调试',
    placeHolder: '选择要执行的操作'
  });
  if (picked && picked.command) {
    await vscode.commands.executeCommand(picked.command, arg);
  }
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  context.subscriptions.push(getOutput());
  log('C 一键调试 已激活');

  registerAutoBreakpointTracker(context);

  const provider = new CConfigProvider();
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('cppdbg', provider));
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(
      'cppdbg',
      provider,
      vscode.DebugConfigurationProviderTriggerKind.Dynamic
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cDebug.run', commandRun),
    vscode.commands.registerCommand('cDebug.debug', commandDebug),
    vscode.commands.registerCommand('cDebug.generateAll', (arg) => commandGenerate('all', arg)),
    vscode.commands.registerCommand('cDebug.generateTasks', (arg) => commandGenerate('tasks', arg)),
    vscode.commands.registerCommand('cDebug.generateLaunch', (arg) => commandGenerate('launch', arg)),
    vscode.commands.registerCommand('cDebug.buildOnly', commandBuildOnly),
    vscode.commands.registerCommand('cDebug.breakAtMain', commandBreakAtMain),
    vscode.commands.registerCommand('cDebug.panel', commandPanel)
  );

  registerStatusBar(context);

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      if (terminal === runTerminal) runTerminal = undefined;
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate, CONFIG_NAME };
