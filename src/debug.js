'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const { log } = require('./output');
const { findEntryPoint, findMainPosition } = require('./csource');
const { createPlan, writeConfigFiles, CONFIG_NAME } = require('./configFiles');

/** 本次会话中由扩展自动添加的断点 */
const state = {
  /** @type {vscode.SourceBreakpoint[]} */
  autoBreakpoints: [],
  /** @type {string | undefined} */
  sessionId: undefined
};

/**
 * 把编译器输出按 UTF-8 / GBK 解码（Windows 中文环境下 gcc 报错多为 GBK）。
 * @param {Buffer | string | undefined} buffer
 */
function decodeOutput(buffer) {
  if (!buffer) return '';
  if (typeof buffer === 'string') return buffer;
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk').decode(buffer);
  } catch {
    return utf8;
  }
}

/**
 * 在 main 函数处添加断点（已存在则跳过）。
 * @param {vscode.Uri} uri
 * @param {{ line: number, character: number }} position
 * @returns {{ ok: boolean, added: boolean }}
 */
function setBreakpointAt(uri, position) {
  const uriStr = uri.toString();
  const exists = vscode.debug.breakpoints.some(
    (bp) =>
      bp instanceof vscode.SourceBreakpoint &&
      bp.enabled &&
      bp.location.uri.toString() === uriStr &&
      bp.location.range.start.line === position.line
  );
  if (exists) {
    return { ok: true, added: false };
  }

  const breakpoint = new vscode.SourceBreakpoint(
    new vscode.Location(uri, new vscode.Position(position.line, position.character)),
    true
  );
  vscode.debug.addBreakpoints([breakpoint]);
  state.autoBreakpoints.push(breakpoint);
  log(`已在 ${path.basename(uri.fsPath)}:${position.line + 1} 设置自动断点`);
  return { ok: true, added: true };
}

/**
 * 为指定文档在 main 处设置断点。
 * @param {vscode.TextDocument} doc
 * @returns {Promise<boolean>}
 */
async function breakAtMain(doc) {
  const position = findMainPosition(doc.getText());
  if (!position) {
    return false;
  }
  setBreakpointAt(doc.uri, position);
  return true;
}

/**
 * 一次性断点模式：程序首次停住后移除自动断点。
 * @param {vscode.ExtensionContext} context
 */
function registerAutoBreakpointTracker(context) {
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory('cppdbg', {
      createDebugAdapterTracker() {
        return {
          onDidSendMessage(message) {
            if (!message || message.type !== 'event' || message.event !== 'stopped') return;
            if (message.body && message.body.reason === 'exception') return;
            const mode = vscode.workspace.getConfiguration('cDebug').get('breakpointMode');
            if (mode !== 'once') return;
            if (!state.autoBreakpoints.length) return;
            vscode.debug.removeBreakpoints(state.autoBreakpoints.slice());
            log('一次性断点：程序已在 main 处停住，自动移除该断点');
            state.autoBreakpoints = [];
          }
        };
      }
    })
  );

  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession((session) => {
      state.sessionId = session.id;
    }),
    vscode.debug.onDidTerminateDebugSession(() => {
      state.sessionId = undefined;
      state.autoBreakpoints = [];
    })
  );
}

/**
 * 运行 compile task（带终端输出与问题面板），失败时返回失败信息。
 * @param {any} plan
 * @returns {Promise<{ ok: boolean, code?: number, output?: string, via?: string }>}
 */
async function runBuildTask(plan) {
  const folder = plan.workspaceFolder;
  if (folder) {
    try {
      const tasks = await vscode.tasks.fetchTasks();
      const task = tasks.find((t) => t.name === plan.label);
      if (task) {
        return await new Promise((resolve) => {
          /** @type {vscode.Disposable | undefined} */
          let listener;
          listener = vscode.tasks.onDidEndTaskProcess((event) => {
            if (event.execution.task.name !== plan.label) return;
            if (listener) listener.dispose();
            const code = typeof event.exitCode === 'number' ? event.exitCode : -1;
            resolve({ ok: code === 0, code, via: 'task' });
          });
          vscode.tasks.executeTask(task);
        });
      }
    } catch (err) {
      log(`通过任务编译失败，回退到直接调用编译器：${err && err.message}`);
    }
  }
  return compileSync(plan);
}

/**
 * 直接调用编译器（无工作区 / 任务不可用时的兜底）。
 * @param {any} plan
 */
function compileSync(plan) {
  return new Promise((resolve) => {
    const cmd = `"${plan.toolchain.compiler}" ${plan.compileArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;
    log(`> ${cmd}`);
    log(`  工作目录: ${plan.cwdAbs}`);

    const child = cp.execFile(
      plan.toolchain.compiler,
      plan.compileArgs,
      { cwd: plan.cwdAbs, windowsHide: true, encoding: 'buffer', maxBuffer: 20 * 1024 * 1024, timeout: 180000 },
      (error, stdout, stderr) => {
        const output = `${decodeOutput(stdout)}${decodeOutput(stderr)}`.trim();
        if (output) log(output);
        if (error) {
          const code = typeof error.code === 'number' ? error.code : -1;
          log(`编译失败，退出码 ${code}`);
          resolve({ ok: false, code, output, via: 'exec' });
          return;
        }
        log('编译成功');
        resolve({ ok: true, code: 0, output, via: 'exec' });
      }
    );
    child.on('error', (err) => {
      log(`无法启动编译器：${err.message}`);
      resolve({ ok: false, code: -1, output: err.message, via: 'exec' });
    });
  });
}

/**
 * 启动调试（使用绝对路径，避免变量替换歧义）。
 * @param {any} plan
 * @returns {Promise<boolean>}
 */
async function startDebugSession(plan) {
  if (!plan.task) {
    return false;
  }

  /** @type {vscode.DebugConfiguration} */
  const config = {
    name: CONFIG_NAME,
    type: 'cppdbg',
    request: 'launch',
    program: plan.programAbs,
    args: plan.programArgs || [],
    stopAtEntry: false,
    cwd: plan.cwdAbs,
    environment: [],
    externalConsole: !!plan.externalConsole,
    MIMode: 'gdb',
    setupCommands: [
      { description: '为 gdb 启用整齐打印', text: '-enable-pretty-printing', ignoreFailures: true }
    ]
  };
  if (plan.toolchain.debuggerPath) {
    config.miDebuggerPath = plan.toolchain.debuggerPath;
  }

  log(`启动调试: ${config.program}`);
  const started = await vscode.debug.startDebugging(plan.workspaceFolder, config);
  if (!started) {
    log('调试启动失败（startDebugging 返回 false）');
  }
  return started;
}

/**
 * 调试配置提供者：
 * - 提供一份“开箱可用”的动态配置（F5 直接可选中）
 * - 启动前补齐配置、自动在 main 下断点
 */
class CConfigProvider {
  /**
   * @param {vscode.WorkspaceFolder | undefined} folder
   */
  provideDebugConfigurations(folder, token) {
    return [
      {
        name: CONFIG_NAME,
        type: 'cppdbg',
        request: 'launch',
        program: '${fileDirname}/${fileBasenameNoExtension}.exe',
        args: [],
        stopAtEntry: false,
        cwd: '${fileDirname}',
        environment: [],
        externalConsole: false,
        MIMode: 'gdb'
      }
    ];
  }

  /**
   * @param {vscode.WorkspaceFolder | undefined} folder
   * @param {vscode.DebugConfiguration} config
   */
  async resolveDebugConfiguration(folder, config, token) {
    if (!config || (config.type && config.type !== 'cppdbg')) {
      return config;
    }

    const cfg = vscode.workspace.getConfiguration('cDebug');
    const editor = vscode.window.activeTextEditor;
    const doc = editor && editor.document.languageId === 'c' ? editor.document : undefined;

    // 空配置（无 launch.json 时按 F5）走默认值
    if (!config.type) {
      config.type = 'cppdbg';
      config.request = 'launch';
      config.name = config.name || CONFIG_NAME;
    }

    const isManaged = config.name === CONFIG_NAME || !config.program;
    const scope = cfg.get('autoBreakpointScope') || 'managed';
    const shouldManage = isManaged || scope === 'all';

    if (doc && shouldManage) {
      if (!config.program) {
        await this.fillFromPlan(config, doc);
      } else if (cfg.get('autoGenerateConfig', true)) {
        await this.ensureConfigs(doc);
      }

      if (cfg.get('autoBreakpoint', true)) {
        await this.applyAutoBreakpoint(doc);
      }
    }

    return config;
  }

  /**
   * 根据当前文件补齐 program / cwd / preLaunchTask。
   * @param {vscode.DebugConfiguration} config
   * @param {vscode.TextDocument} doc
   */
  async fillFromPlan(config, doc) {
    try {
      const { detectToolchain } = require('./toolchain');
      const toolchain = detectToolchain();
      if (!toolchain) return;
      const plan = await createPlan(doc, toolchain);
      if (!plan) return;
      config.program = plan.programVar;
      config.cwd = plan.cwdVar;
      config.miDebuggerPath = plan.launch.miDebuggerPath;
      config.preLaunchTask = plan.label;
      writeConfigFiles(plan);
      log('缺少启动配置，已按当前文件自动补齐并写入 .vscode/');
    } catch (err) {
      log(`补齐启动配置失败：${err && err.message}`);
    }
  }

  /**
   * 若 .vscode 配置缺失则自动生成（不覆盖已有内容）。
   * @param {vscode.TextDocument} doc
   */
  async ensureConfigs(doc) {
    try {
      const folder = vscode.workspace.getWorkspaceFolder(doc.uri) || (vscode.workspace.workspaceFolders || [])[0];
      if (!folder) return;
      const tasksPath = path.join(folder.uri.fsPath, '.vscode', 'tasks.json');
      const launchPath = path.join(folder.uri.fsPath, '.vscode', 'launch.json');
      if (fs.existsSync(tasksPath) && fs.existsSync(launchPath)) return;

      const { detectToolchain } = require('./toolchain');
      const toolchain = detectToolchain();
      if (!toolchain) return;
      const plan = await createPlan(doc, toolchain);
      if (!plan) return;
      writeConfigFiles(plan);
    } catch (err) {
      log(`自动生成配置失败：${err && err.message}`);
    }
  }

  /**
   * @param {vscode.TextDocument} doc
   */
  async applyAutoBreakpoint(doc) {
    try {
      const mode = vscode.workspace.getConfiguration('cDebug').get('buildMode');
      const entry = await findEntryPoint(doc, mode === 'folder' ? 'folder' : 'currentFile');
      if (!entry) {
        log('未在源码中找到 main 函数，跳过自动断点');
        return;
      }
      setBreakpointAt(entry.uri, entry.position);
    } catch (err) {
      log(`设置自动断点失败：${err && err.message}`);
    }
  }
}

module.exports = {
  CConfigProvider,
  setBreakpointAt,
  breakAtMain,
  registerAutoBreakpointTracker,
  runBuildTask,
  compileSync,
  startDebugSession,
  decodeOutput,
  state
};
