'use strict';

/**
 * 不依赖 VS Code 运行时的核心逻辑测试。
 * 用法: node test/run-tests.js
 *
 * 通过伪造 `vscode` 模块，直接调用扩展源码里的纯逻辑函数，
 * 并真实调用 gcc 编译 fixture，校验生成的 tasks/launch 配置可用。
 */

const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixture');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(
        () => {
          passed += 1;
          console.log(`  ✓ ${name}`);
        },
        (err) => {
          failed += 1;
          console.log(`  ✗ ${name}\n    ${err && err.message}`);
        }
      );
    }
    passed += 1;
    console.log(`  ✓ ${name}`);
    return Promise.resolve();
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}\n    ${err && err.message}`);
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------- vscode 桩

const CONFIG_DEFAULTS = {
  buildMode: 'currentFile',
  compilerPath: '',
  debuggerPath: '',
  compilerArgs: ['-g', '-O0', '-Wall', '-Wextra'],
  programArgs: [],
  externalConsole: false,
  buildBeforeDebug: true,
  autoBreakpoint: true,
  breakpointMode: 'keep',
  autoBreakpointScope: 'managed',
  autoGenerateConfig: true,
  syncConfigOnDebug: true
};

const cfgState = Object.assign({}, CONFIG_DEFAULTS);

const stub = {
  workspace: {
    getConfiguration: () => ({
      get: (key, def) => (key in cfgState ? cfgState[key] : def),
      update: async () => {}
    }),
    workspaceFolders: [],
    getWorkspaceFolder: (uri) => stub.workspace.workspaceFolders.find((f) => uri.fsPath.startsWith(f.uri.fsPath)),
    findFiles: async () => stub.__findFilesResult || [],
    openTextDocument: async () => ({ getText: () => '' }),
    saveAll: async () => true,
    textDocuments: []
  },
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
    showWarningMessage: async (message) => {
      stub.__warningPrompted.push(message);
      return stub.__warningAnswer;
    },
    showErrorMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    setStatusBarMessage: () => {},
    withProgress: async (options, task) => task(),
    createTerminal: (options) => {
      const terminal = {
        name: options && options.name,
        cwd: options && options.cwd,
        exitStatus: undefined,
        sent: '',
        show: () => {},
        sendText: (text) => {
          terminal.sent = text;
        },
        dispose: () => {}
      };
      stub.__terminals.push(terminal);
      return terminal;
    },
    onDidCloseTerminal: () => ({ dispose() {} }),
    visibleTextEditors: [],
    activeTextEditor: undefined
  },
  env: { shell: 'C:\\Windows\\System32\\cmd.exe' },
  extensions: {
    getExtension: (id) => (id === 'ms-vscode.cpptools' ? { id, isActive: true } : undefined)
  },
  Uri: {
    file: (p) => {
      const uri = {
        fsPath: p,
        path: p.split(path.sep).join('/'),
        scheme: 'file',
        toString: () => `file:///${p.split(path.sep).join('/')}`
      };
      return uri;
    }
  },
  RelativePattern: class {
    constructor(base, pattern) {
      this.base = base;
      this.pattern = pattern;
    }
  },
  Position: class {
    constructor(line, character) {
      this.line = line;
      this.character = character;
    }
  },
  Location: class {
    constructor(uri, position) {
      this.uri = uri;
      this.range = { start: position };
    }
  },
  SourceBreakpoint: class {
    constructor(location, enabled) {
      this.location = location;
      this.enabled = enabled;
    }
  },
  debug: {
    breakpoints: [],
    addBreakpoints: (bps) => {
      stub.debug.breakpoints.push(...bps);
    },
    removeBreakpoints: (bps) => {
      stub.debug.breakpoints = stub.debug.breakpoints.filter((b) => !bps.includes(b));
    },
    registerDebugConfigurationProvider: () => ({ dispose() {} }),
    registerDebugAdapterTrackerFactory: () => ({ dispose() {} }),
    onDidStartDebugSession: () => ({ dispose() {} }),
    onDidTerminateDebugSession: () => ({ dispose() {} }),
    startDebugging: async (folder, config) => {
      stub.__startedConfigs.push(config);
      return true;
    }
  },
  tasks: {
    fetchTasks: async () => stub.__tasks || [],
    executeTask: (task) => {
      setImmediate(() => {
        stub.__endTaskListeners.slice().forEach((fn) => fn({ exitCode: stub.__exitCode === undefined ? 0 : stub.__exitCode, execution: { task } }));
      });
      return {};
    },
    onDidEndTaskProcess: (fn) => {
      stub.__endTaskListeners.push(fn);
      return {
        dispose: () => {
          stub.__endTaskListeners = stub.__endTaskListeners.filter((f) => f !== fn);
        }
      };
    }
  },
  commands: {
    __handlers: {},
    registerCommand: (id, fn) => {
      stub.commands.__handlers[id] = fn;
      return { dispose() {} };
    },
    executeCommand: async () => {}
  },
  ConfigurationTarget: { Workspace: 2 },
  ProgressLocation: { Notification: 15 },
  DebugConfigurationProviderTriggerKind: { Initial: 1, Dynamic: 2 }
};

stub.__startedConfigs = [];
stub.__endTaskListeners = [];
stub.__tasks = [];
stub.__exitCode = 0;
stub.__terminals = [];
stub.__warningAnswer = undefined;
stub.__warningPrompted = [];

// 让 require('vscode') 返回桩对象
const STUB_ID = path.join(ROOT, '__vscode_stub__.js');
require.cache[STUB_ID] = { id: STUB_ID, filename: STUB_ID, loaded: true, exports: stub };
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return STUB_ID;
  return originalResolve.call(this, request, ...rest);
};

// ---------------------------------------------------------------- 被测模块

const csource = require('../src/csource');
const configFiles = require('../src/configFiles');

// ---------------------------------------------------------------- 测试

async function main() {
  console.log('\n[1] JSONC 解析');

  await test('支持 // 与 /* */ 注释', () => {
    const data = configFiles.parseJsonc(`{
      // 行注释
      "version": "2.0.0", /* 块注释 */
      "tasks": []
    }`);
    assert.strictEqual(data.version, '2.0.0');
    assert.deepStrictEqual(data.tasks, []);
  });

  await test('支持尾随逗号', () => {
    const data = configFiles.parseJsonc('{"a": [1, 2, 3,], "b": {"c": 1,},}');
    assert.deepStrictEqual(data.a, [1, 2, 3]);
    assert.strictEqual(data.b.c, 1);
  });

  await test('字符串里的 // 与逗号不会被误删', () => {
    const data = configFiles.parseJsonc('{"path": "C:/a//b", "s": ",}"}');
    assert.strictEqual(data.path, 'C:/a//b');
    assert.strictEqual(data.s, ',}');
  });

  console.log('\n[2] main 函数定位');

  await test('识别 K&R 风格 main', () => {
    const text = '#include <stdio.h>\nint main(void)\n{\n    return 0;\n}\n';
    const pos = csource.findMainPosition(text);
    assert.ok(pos, '应找到 main');
    assert.strictEqual(pos.line, 1);
  });

  await test('识别 Allman 风格 main（大括号在下一行，跳过注释行）', () => {
    const text = fs.readFileSync(path.join(FIXTURE, 'single', 'hello.c'), 'utf8');
    const pos = csource.findMainPosition(text);
    assert.ok(pos, '应找到 main');
    assert.strictEqual(pos.line, 5, `期望第 6 行（index 5），实际 ${pos && pos.line}`);
    assert.strictEqual(pos.character, 4, '列号应指向 main 标识符');
  });

  await test('带参数的 main', () => {
    const text = fs.readFileSync(path.join(FIXTURE, 'multi', 'main.c'), 'utf8');
    const pos = csource.findMainPosition(text);
    assert.ok(pos);
    assert.strictEqual(pos.line, 3);
  });

  await test('注释掉的 main 不会被误判', () => {
    const text = '// int main(void) { return 0; }\nvoid other() {}\n';
    assert.strictEqual(csource.findMainPosition(text), null);
  });

  await test('块注释里的 main 不会被误判', () => {
    const text = '/*\nint main(void)\n{\n}\n*/\nvoid f() {}\n';
    assert.strictEqual(csource.findMainPosition(text), null);
  });

  await test('函数原型 main(); 不会被误判为定义', () => {
    const text = 'int main(void);\nvoid f() {}\n';
    assert.strictEqual(csource.findMainPosition(text), null);
  });

  await test('obj.main() 成员调用不会被误判', () => {
    const text = 'void f() {\n    obj.main();\n}\n';
    assert.strictEqual(csource.findMainPosition(text), null);
  });

  console.log('\n[3] 配置生成（currentFile 模式）');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c-debug-test-'));
  const projSingle = path.join(tmp, 'single');
  fs.mkdirSync(projSingle, { recursive: true });
  const helloPath = path.join(projSingle, 'hello.c');
  fs.copyFileSync(path.join(FIXTURE, 'single', 'hello.c'), helloPath);

  const workspaceFolder = { uri: stub.Uri.file(projSingle), name: 'single', index: 0 };
  stub.workspace.workspaceFolders = [workspaceFolder];

  // 用本机真实探测到的工具链（Windows / Linux / macOS 都能跑）
  const toolchain = require('../src/toolchain').detectToolchain();
  if (!toolchain) {
    console.error('\n未找到 gcc，无法运行依赖编译的测试。请先安装 MinGW-w64 或 gcc。');
    process.exit(1);
  }
  const SUF = toolchain.exeSuffix;
  const OUT = `hello${SUF}`;

  const fakeDoc = {
    uri: stub.Uri.file(helloPath),
    languageId: 'c',
    isUntitled: false,
    isDirty: false,
    getText: () => fs.readFileSync(helloPath, 'utf8'),
    lineAt: () => ({ text: '' })
  };

  let plan;
  await test('createPlan 生成正确产物路径与参数', async () => {
    plan = await configFiles.createPlan(fakeDoc, toolchain);
    assert.ok(plan, 'plan 不应为空');
    assert.strictEqual(plan.mode, 'currentFile');
    assert.strictEqual(plan.programAbs, path.join(projSingle, OUT));
    assert.deepStrictEqual(plan.compileArgs, [
      '-g',
      '-O0',
      '-Wall',
      '-Wextra',
      helloPath,
      '-o',
      path.join(projSingle, OUT)
    ]);
  });

  await test('task 参数使用 ${file} 变量且带 $gcc problemMatcher', () => {
    assert.strictEqual(plan.task.type, 'process');
    assert.strictEqual(plan.task.label, configFiles.TASK_LABEL_CURRENT);
    assert.deepStrictEqual(plan.task.args, ['-g', '-O0', '-Wall', '-Wextra', '${file}', '-o', `\${fileDirname}/${OUT}`]);
    assert.deepStrictEqual(plan.task.problemMatcher, ['$gcc']);
    assert.strictEqual(plan.task.group.isDefault, true);
  });

  await test('launch 配置指向 cppdbg + gdb，并绑定 preLaunchTask', () => {
    assert.strictEqual(plan.launch.type, 'cppdbg');
    assert.strictEqual(plan.launch.program, `\${fileDirname}/${OUT}`);
    assert.strictEqual(plan.launch.MIMode, 'gdb');
    if (toolchain.debuggerPath) {
      assert.strictEqual(plan.launch.miDebuggerPath, toolchain.debuggerPath);
    }
    assert.strictEqual(plan.launch.preLaunchTask, configFiles.TASK_LABEL_CURRENT);
  });

  await test('写入 .vscode/tasks.json 与 launch.json', () => {
    const result = configFiles.writeConfigFiles(plan);
    assert.ok(fs.existsSync(result.tasksPath));
    assert.ok(fs.existsSync(result.launchPath));
    const tasks = JSON.parse(fs.readFileSync(result.tasksPath, 'utf8').replace(/^\uFEFF/, ''));
    const launch = JSON.parse(fs.readFileSync(result.launchPath, 'utf8').replace(/^\uFEFF/, ''));
    assert.strictEqual(tasks.version, '2.0.0');
    assert.strictEqual(tasks.tasks.length, 1);
    assert.strictEqual(launch.version, '0.2.0');
    assert.strictEqual(launch.configurations[0].name, configFiles.CONFIG_NAME);
  });

  await test('重复写入不产生重复条目，且保留用户已有配置', () => {
    const launchPath = path.join(projSingle, '.vscode', 'launch.json');
    const data = JSON.parse(fs.readFileSync(launchPath, 'utf8'));
    data.configurations.push({ name: '用户的配置', type: 'cppdbg', request: 'launch', program: 'x.exe' });
    fs.writeFileSync(launchPath, JSON.stringify(data, null, 4), 'utf8');

    configFiles.writeConfigFiles(plan);
    configFiles.writeConfigFiles(plan);
    const after = JSON.parse(fs.readFileSync(launchPath, 'utf8'));
    assert.strictEqual(after.configurations.length, 2, '不应重复追加');
    assert.ok(after.configurations.some((c) => c.name === '用户的配置'), '用户配置应保留');
  });

  await test('已有带注释的 launch.json 也能正确合并', () => {
    const launchPath = path.join(projSingle, '.vscode', 'launch.json');
    fs.writeFileSync(
      launchPath,
      `{
    // 我的调试配置
    "version": "0.2.0",
    "configurations": [
        { "name": "mine", "type": "cppdbg", "request": "launch", "program": "a.exe", },
    ],
}`,
      'utf8'
    );
    configFiles.writeConfigFiles(plan);
    const after = configFiles.parseJsonc(fs.readFileSync(launchPath, 'utf8'));
    assert.strictEqual(after.configurations.length, 2);
    assert.strictEqual(after.configurations[1].name, 'mine');
  });

  console.log('\n[4] 用真实 gcc 编译生成的参数');

  await test('plan.compileArgs 直接被 gcc 接受并产出 exe', () => {
    const result = cp.spawnSync(toolchain.compiler, plan.compileArgs, { cwd: plan.cwdAbs, encoding: 'utf8' });
    assert.strictEqual(result.status, 0, `gcc 失败: ${result.stderr}`);
    assert.ok(fs.existsSync(plan.programAbs), '应生成可执行文件');
    const run = cp.spawnSync(plan.programAbs, [], { encoding: 'utf8' });
    assert.strictEqual(run.stdout.trim(), 'sum = 7');
  });

  console.log('\n[5] 配置生成（folder 模式）');

  const projMulti = path.join(tmp, 'multi');
  fs.mkdirSync(projMulti, { recursive: true });
  for (const f of ['main.c', 'util.c', 'util.h']) {
    fs.copyFileSync(path.join(FIXTURE, 'multi', f), path.join(projMulti, f));
  }
  stub.workspace.workspaceFolders = [{ uri: stub.Uri.file(projMulti), name: 'multi', index: 0 }];
  stub.__findFilesResult = ['main.c', 'util.c'].map((f) => stub.Uri.file(path.join(projMulti, f)));

  const multiDoc = {
    uri: stub.Uri.file(path.join(projMulti, 'main.c')),
    languageId: 'c',
    isUntitled: false,
    isDirty: false,
    getText: () => fs.readFileSync(path.join(projMulti, 'main.c'), 'utf8')
  };

  let multiPlan;
  const MULTI_OUT = `multi${SUF}`;
  await test('folder 模式收集全部 .c 并输出到工作区根目录', async () => {
    cfgState.buildMode = 'folder';
    multiPlan = await configFiles.createPlan(multiDoc, toolchain);
    assert.strictEqual(multiPlan.mode, 'folder');
    assert.strictEqual(multiPlan.sources.length, 2);
    assert.strictEqual(multiPlan.programAbs, path.join(projMulti, MULTI_OUT));
    assert.deepStrictEqual(multiPlan.compileArgs, [
      '-g',
      '-O0',
      '-Wall',
      '-Wextra',
      path.join(projMulti, 'main.c'),
      path.join(projMulti, 'util.c'),
      '-o',
      path.join(projMulti, MULTI_OUT)
    ]);
  });

  await test('folder 模式多文件真实链接成功', () => {
    const result = cp.spawnSync(toolchain.compiler, multiPlan.compileArgs, { cwd: multiPlan.cwdAbs, encoding: 'utf8' });
    assert.strictEqual(result.status, 0, `gcc 失败: ${result.stderr}`);
    const run = cp.spawnSync(multiPlan.programAbs, [], { encoding: 'utf8' });
    assert.strictEqual(run.stdout.trim(), 'multi-file demo: 42');
  });

  await test('folder 模式 task 使用 ${workspaceFolder} 变量', () => {
    assert.strictEqual(multiPlan.label, configFiles.TASK_LABEL_FOLDER);
    assert.deepStrictEqual(multiPlan.task.args, [
      '-g',
      '-O0',
      '-Wall',
      '-Wextra',
      '${workspaceFolder}/main.c',
      '${workspaceFolder}/util.c',
      '-o',
      '${workspaceFolder}/' + MULTI_OUT
    ]);
    assert.strictEqual(multiPlan.task.options.cwd, '${workspaceFolder}');
  });

  console.log('\n[6] gdb 断点位置校验');

  if (!toolchain.debuggerPath) {
    console.log('  - 跳过（未找到 gdb）');
  } else
  await test('gdb 在扩展计算出的行上能命中 main 并停住', () => {
    const gdb = toolchain.debuggerPath;
    const pos = csource.findMainPosition(fs.readFileSync(helloPath, 'utf8'));
    // 用 -x 命令文件，避开部分 MinGW gdb 对 -ex "含空格命令" 的拆词问题
    const cmdsFile = path.join(tmp, 'cmds.gdb');
    fs.writeFileSync(cmdsFile, `break hello.c:${pos.line + 1}\nrun\n`, 'utf8');

    const result = cp.spawnSync(gdb, ['-batch', '-x', cmdsFile, plan.programAbs], {
      cwd: projSingle,
      encoding: 'utf8'
    });
    const out = `${result.stdout}${result.stderr}`;
    assert.ok(/Breakpoint 1/.test(out), `断点未创建: ${out.slice(0, 400)}`);
    assert.ok(/Breakpoint 1, main/.test(out), `未停在 main: ${out.slice(0, 400)}`);
    const lineMatch = /at\s+.*hello\.c:(\d+)/.exec(out);
    assert.ok(lineMatch, `无法解析停止行号: ${out.slice(0, 400)}`);
    const stoppedLine = Number(lineMatch[1]);
    // gdb 会把断点落在 main 函数体第一条可执行语句上（跳过 { 与序言），允许几行偏移
    assert.ok(
      stoppedLine >= pos.line + 1 && stoppedLine <= pos.line + 4,
      `停止行 ${stoppedLine} 与解析行 ${pos.line + 1} 相差过大`
    );
  });

  console.log('\n[7] 配置生成：分别生成 / 一键生成 / 覆盖确认');

  cfgState.buildMode = 'currentFile';
  cfgState.autoGenerateConfig = true;
  stub.workspace.workspaceFolders = [workspaceFolder];
  stub.debug.breakpoints = [];
  stub.__startedConfigs = [];
  stub.__terminals = [];
  stub.__endTaskListeners = [];
  stub.__exitCode = 0;
  stub.__warningAnswer = undefined;
  stub.__warningPrompted = [];

  const helloDoc = Object.assign({}, fakeDoc, { isDirty: false, save: async () => true });
  stub.window.activeTextEditor = { document: helloDoc };
  stub.__tasks = [{ name: configFiles.TASK_LABEL_CURRENT }];

  const ext = require('../src/extension');
  const fakeContext = { subscriptions: [] };
  ext.activate(fakeContext);
  const handlers = stub.commands.__handlers;
  const vsDir = path.join(projSingle, '.vscode');
  const tasksPath = path.join(vsDir, 'tasks.json');
  const launchPath = path.join(vsDir, 'launch.json');

  await test('activate 注册了全部 7 个命令', () => {
    assert.deepStrictEqual(Object.keys(handlers).sort(), [
      'cDebug.breakAtMain',
      'cDebug.buildOnly',
      'cDebug.debug',
      'cDebug.generateAll',
      'cDebug.generateLaunch',
      'cDebug.generateTasks',
      'cDebug.run'
    ]);
  });

  await test('只生成 tasks.json，不碰 launch.json', async () => {
    fs.rmSync(vsDir, { recursive: true, force: true });
    const result = await handlers['cDebug.generateTasks']();
    assert.ok(fs.existsSync(tasksPath), 'tasks.json 应被创建');
    assert.ok(!fs.existsSync(launchPath), '不应创建 launch.json');
    assert.ok(result && result.tasksPath);
  });

  await test('只生成 launch.json，不碰 tasks.json', async () => {
    fs.rmSync(vsDir, { recursive: true, force: true });
    const result = await handlers['cDebug.generateLaunch']();
    assert.ok(fs.existsSync(launchPath), 'launch.json 应被创建');
    assert.ok(!fs.existsSync(tasksPath), '不应创建 tasks.json');
    assert.ok(result && result.launchPath);
  });

  await test('一键生成两份配置', async () => {
    fs.rmSync(vsDir, { recursive: true, force: true });
    const result = await handlers['cDebug.generateAll']();
    assert.ok(fs.existsSync(tasksPath) && fs.existsSync(launchPath));
    assert.ok(result.tasksPath && result.launchPath);
  });

  await test('文件已存在时会先弹提示', async () => {
    stub.__warningPrompted = [];
    stub.__warningAnswer = undefined;
    await handlers['cDebug.generateAll']();
    assert.strictEqual(stub.__warningPrompted.length, 1, '应弹一次提示');
    assert.ok(stub.__warningPrompted[0].includes('tasks.json'), '提示应说明哪些文件已存在');
    assert.ok(stub.__warningPrompted[0].includes('launch.json'));
  });

  await test('提示中选「取消」则完全不修改文件', async () => {
    const before = { version: '2.0.0', tasks: [{ label: '我的任务', type: 'shell', command: 'echo hi' }] };
    fs.writeFileSync(tasksPath, JSON.stringify(before, null, 4), 'utf8');
    const stamp = fs.statSync(tasksPath).mtimeMs;

    stub.__warningAnswer = undefined;
    await handlers['cDebug.generateTasks']();

    const after = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
    assert.strictEqual(after.tasks.length, 1);
    assert.strictEqual(after.tasks[0].label, '我的任务');
    assert.strictEqual(fs.statSync(tasksPath).mtimeMs, stamp, '文件不应被写入');
  });

  await test('选「覆盖」会丢弃原有内容', async () => {
    fs.writeFileSync(
      tasksPath,
      JSON.stringify({ version: '2.0.0', tasks: [{ label: '我的任务' }] }, null, 4),
      'utf8'
    );
    stub.__warningAnswer = '覆盖';
    await handlers['cDebug.generateTasks']();

    const after = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
    assert.strictEqual(after.tasks.length, 1, '覆盖后只应剩扩展生成的任务');
    assert.strictEqual(after.tasks[0].label, configFiles.TASK_LABEL_CURRENT);
  });

  await test('选「更新」只更新自己那一条，保留用户其他任务', async () => {
    fs.writeFileSync(
      tasksPath,
      JSON.stringify({ version: '2.0.0', tasks: [{ label: '我的任务', type: 'shell', command: 'echo hi' }] }, null, 4),
      'utf8'
    );
    stub.__warningAnswer = '更新（推荐）';
    await handlers['cDebug.generateTasks']();

    const after = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
    assert.strictEqual(after.tasks.length, 2, '应保留用户任务并追加自己的');
    assert.strictEqual(after.tasks[0].label, '我的任务');
    assert.strictEqual(after.tasks[1].label, configFiles.TASK_LABEL_CURRENT);
  });

  await test('重复生成不产生重复条目', async () => {
    stub.__warningAnswer = '更新（推荐）';
    await handlers['cDebug.generateTasks']();
    await handlers['cDebug.generateTasks']();
    const after = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
    assert.strictEqual(after.tasks.filter((t) => t.label === configFiles.TASK_LABEL_CURRENT).length, 1);
  });

  await test('文件不存在时不会弹提示', async () => {
    fs.rmSync(vsDir, { recursive: true, force: true });
    stub.__warningPrompted = [];
    await handlers['cDebug.generateAll']();
    assert.deepStrictEqual(stub.__warningPrompted, []);
  });

  console.log('\n[8] 运行（跑到结束）与调试（自动断点）双模式');

  await test('run：在终端执行 exe，不进调试、不加断点', async () => {
    stub.debug.breakpoints = [];
    stub.__startedConfigs = [];
    stub.__terminals = [];
    await handlers['cDebug.run']();

    assert.strictEqual(stub.__startedConfigs.length, 0, '运行模式不应启动调试会话');
    assert.strictEqual(stub.debug.breakpoints.length, 0, '运行模式不应添加断点');
    assert.strictEqual(stub.__terminals.length, 1, '应创建 1 个终端');
    assert.ok(stub.__terminals[0].sent.includes(OUT), `应执行生成的 exe，实际: ${stub.__terminals[0].sent}`);
  });

  await test('run：重复运行复用同一个终端', async () => {
    await handlers['cDebug.run']();
    assert.strictEqual(stub.__terminals.length, 1, '不应重复创建终端');
  });

  await test('run：编译失败时不执行程序', async () => {
    stub.__exitCode = 1;
    stub.__terminals = [];
    await handlers['cDebug.run']();
    assert.strictEqual(stub.__terminals.length, 0, '编译失败不应运行');
    stub.__exitCode = 0;
  });

  await test('debug：在 main 处下断点 + 用正确参数启动调试', async () => {
    stub.debug.breakpoints = [];
    stub.__startedConfigs = [];
    await handlers['cDebug.debug']();

    assert.strictEqual(stub.debug.breakpoints.length, 1, '应添加 1 个断点');
    assert.strictEqual(stub.debug.breakpoints[0].location.range.start.line, 5, '断点应落在 main 所在行');
    assert.strictEqual(stub.debug.breakpoints[0].enabled, true);

    assert.strictEqual(stub.__startedConfigs.length, 1, '应启动 1 次调试');
    const launched = stub.__startedConfigs[0];
    assert.strictEqual(launched.type, 'cppdbg');
    assert.strictEqual(launched.program, path.join(projSingle, OUT));
    assert.strictEqual(launched.cwd, projSingle);
    assert.strictEqual(launched.MIMode, 'gdb');
    // 这里走真实探测（不是桩里的假 toolchain），顺便验证自动探测可用
    const dbgName = path.basename(launched.miDebuggerPath || '').toLowerCase();
    assert.ok(dbgName.startsWith('gdb'), `应探测到 gdb，实际: ${launched.miDebuggerPath}`);
    assert.ok(fs.existsSync(launched.miDebuggerPath), 'gdb 路径应真实存在');
  });

  await test('debug：编译失败时不进入调试', async () => {
    stub.debug.breakpoints = [];
    stub.__startedConfigs = [];
    stub.__exitCode = 1;
    await handlers['cDebug.debug']();
    assert.strictEqual(stub.__startedConfigs.length, 0, '编译失败不应进入调试');
    stub.__exitCode = 0;
  });

  await test('breakAtMain 命令单独下断点', async () => {
    stub.debug.breakpoints = [];
    await handlers['cDebug.breakAtMain']();
    assert.strictEqual(stub.debug.breakpoints.length, 1);
  });

  await test('关闭 syncConfigOnDebug 后不再覆盖手改的配置', async () => {
    const data = JSON.parse(fs.readFileSync(launchPath, 'utf8'));
    data.configurations[0].args = ['--custom-arg'];
    fs.writeFileSync(launchPath, JSON.stringify(data, null, 4), 'utf8');

    cfgState.syncConfigOnDebug = false;
    stub.__startedConfigs = [];
    await handlers['cDebug.debug']();

    const after = JSON.parse(fs.readFileSync(launchPath, 'utf8'));
    assert.deepStrictEqual(after.configurations[0].args, ['--custom-arg'], '手改内容应被保留');
    cfgState.syncConfigOnDebug = true;
  });

  console.log('\n[9] 调试配置提供者（原生 F5 流程）');

  await test('resolveDebugConfiguration 对 cppdbg 配置自动下断点', async () => {
    const { CConfigProvider } = require('../src/debug');
    const provider = new CConfigProvider();
    stub.debug.breakpoints = [];
    const config = { name: 'C: 自动断点调试', type: 'cppdbg', request: 'launch', program: '${fileDirname}/hello.exe' };
    const resolved = await provider.resolveDebugConfiguration(workspaceFolder, config, undefined);
    assert.strictEqual(resolved, config);
    assert.strictEqual(stub.debug.breakpoints.length, 1, 'F5 流程也应自动下断点');
    assert.strictEqual(stub.debug.breakpoints[0].location.range.start.line, 5);
  });

  await test('provider 不处理非 cppdbg 配置', async () => {
    const { CConfigProvider } = require('../src/debug');
    const provider = new CConfigProvider();
    const config = { name: 'py', type: 'python', request: 'launch' };
    const resolved = await provider.resolveDebugConfiguration(workspaceFolder, config, undefined);
    assert.strictEqual(resolved.type, 'python');
  });

  await test('关闭 autoBreakpoint 后不再下断点', async () => {
    const { CConfigProvider } = require('../src/debug');
    const provider = new CConfigProvider();
    stub.debug.breakpoints = [];
    cfgState.autoBreakpoint = false;
    await provider.resolveDebugConfiguration(
      workspaceFolder,
      { name: 'C: 自动断点调试', type: 'cppdbg', program: 'x.exe' },
      undefined
    );
    assert.strictEqual(stub.debug.breakpoints.length, 0);
    cfgState.autoBreakpoint = true;
  });

  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();
