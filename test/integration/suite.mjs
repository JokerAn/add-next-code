import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { startFakeFimServer } from './fake-server.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, message, timeoutMs = 6000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) {
      return;
    }
    await pause(30);
  }
  assert.fail(message);
}
export async function run() {
  const server = await startFakeFimServer();
  const extension = vscode.extensions.getExtension('local.add-next-code-integration');
  assert.ok(extension);
  const config = vscode.workspace.getConfiguration('addNextCode');
  const report = [];
  const record = (name, mode) => { report.push({ name, mode, passed: true }); console.log(`[integration] PASS ${name} (${mode})`); };
  let bridge;
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const skimmerEnabled = process.env.ADD_NEXT_CODE_INTEGRATION_SKIMMER === 'true';
  const set = async (key, value) => {
    await config.update(key, value, vscode.ConfigurationTarget.Global);
    await pause(100);
  };
  async function open(name, text, character = text.length) {
    const uri = vscode.Uri.file(path.join(workspace, name));
    await fs.writeFile(uri.fsPath, text);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(0, character, 0, character);
    await pause(150);
    return editor;
  }
  const direct = async (editor, selectedCompletionInfo, token) => {
    const source = token ?? new vscode.CancellationTokenSource();
    try {
      return await bridge.provider.provideInlineCompletionItems(editor.document, editor.selection.active, {
        triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo,
      }, source.token);
    } finally {
      if (!token) {
        source.dispose();
      }
    }
  };
  try {
    await set('endpoint', server.endpoint);
    await set('trigger.mode', 'manual');
    await set('context.useLanguageService', false);
    await set('skimmer.enabled', false);
    await set('request.timeoutMs', 3000);
    bridge = await extension.activate();
    assert.ok(bridge.provider);

    const editor = await open('accept.js', 'const total = ');
    const before = server.requests.length;
    await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    await until(() => bridge.results.some((items) => items?.some((item) => item.insertText === '42;')), 'real inline command produced no completion');
    await vscode.commands.executeCommand('editor.action.inlineSuggest.commit');
    await until(() => editor.document.getText() === 'const total = 42;', 'real inline commit did not accept the suggestion');
    assert.equal(server.requests.length, before + 1);
    record('trigger and accept completion', 'VS Code commands');
    await vscode.commands.executeCommand('editor.action.inlineSuggest.hide');

    const sciEditor = await open('menu.js', 'console.lo', 10);
    server.setReply({ text: '("ok")' });
    const range = new vscode.Range(0, 8, 0, 10);
    const sci = { range, text: 'log' };
    const menu = await direct(sciEditor, sci);
    assert.equal(menu?.[0]?.insertText, 'log("ok")');
    assert.deepEqual(menu[0].range, range);
    assert.ok(server.requests.at(-1).body.prompt.endsWith('console.log'));
    record('selected menu item extend contract', 'production Provider + real editor');
    await set('suggestWidget', 'skip');
    const count = server.requests.length;
    assert.equal(await direct(sciEditor, sci), undefined);
    assert.equal(server.requests.length, count);
    record('selected menu item skip guard', 'production Provider + real editor');
    await set('suggestWidget', 'extend');

    const cancelled = await open('cancel.js', 'const cancelled = ');
    server.setReply({ text: 'late()', delayMs: 1000 });
    const source = new vscode.CancellationTokenSource();
    const expected = server.requests.length + 1;
    const pending = direct(cancelled, undefined, source);
    await until(() => server.requests.length === expected, 'delayed request never reached fake server');
    await cancelled.edit((edit) => edit.insert(cancelled.selection.active, 'x'));
    source.cancel();
    assert.equal(await pending, undefined);
    await until(() => server.requests.at(-1).aborted, 'cancelled request was not aborted at server');
    source.dispose();
    record('edit and cancellation discard delayed response', 'production Provider + real editor/token');

    const multi = await open('multi.js', 'let first = ; let second = ;', 12);
    multi.selections = [new vscode.Selection(0, 12, 0, 12), new vscode.Selection(0, 26, 0, 26)];
    const multiCount = server.requests.length;
    assert.equal(await direct(multi), undefined);
    assert.equal(server.requests.length, multiCount);
    record('multiple cursor guard', 'production Provider + real editor');

    const ignored = await open('private.js', 'const secret = ');
    const ignoredCount = server.requests.length;
    assert.equal(await direct(ignored), undefined);
    assert.equal(server.requests.length, ignoredCount);
    record('gitignore blocks transmission', 'production Provider + real file');

    const long = await open('budget.js', `const value = ${'a'.repeat(16000)}`, 12000);
    server.setReply({ text: 'done' });
    const output = await direct(long);
    assert.ok(output?.length);
    const body = server.requests.at(-1).body;
    assert.ok(body.prompt.length <= 6000 + 2000);
    assert.ok(body.suffix.length <= 1500);
    record('long-line request stays within budgets', 'production Provider + loopback body');

    if (skimmerEnabled) {
      const nodePath = process.env.ADD_NEXT_CODE_INTEGRATION_NODE;
      assert.ok(nodePath && path.isAbsolute(nodePath), 'Skimmer needs the external Node path from the runner');
      await set('skimmer.nodePath', nodePath);
      await set('context.extraWaitMs', 2000);
      await set('context.headerChars', 6000);
      await set('skimmer.enabled', true);
      const deadline = Date.now() + 30_000;
      let revision = 0;
      async function showFixture(name, marker) {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspace, name)));
        if (name.endsWith('.vue')) {
          assert.equal(document.languageId, 'vue', 'The production manifest must recognize .vue without Vetur/Volar');
        }
        const fixtureEditor = await vscode.window.showTextDocument(document);
        const offset = document.getText().indexOf(marker);
        assert.ok(offset >= 0, `missing cursor marker ${marker}`);
        const cursor = document.positionAt(offset);
        fixtureEditor.selection = new vscode.Selection(cursor, cursor);
        await pause(150);
        return fixtureEditor;
      }
      async function freshRequest(fixtureEditor) {
        const selected = fixtureEditor.selection;
        const end = fixtureEditor.document.positionAt(fixtureEditor.document.getText().length);
        const comment = fixtureEditor.document.languageId === 'vue'
          ? `\n<!-- integration revision ${++revision} -->`
          : `\n// integration revision ${++revision}`;
        assert.equal(await fixtureEditor.edit((edit) => edit.insert(end, comment)), true);
        fixtureEditor.selection = selected;
        const requestCount = server.requests.length;
        await direct(fixtureEditor);
        return server.requests.length > requestCount ? server.requests.at(-1).body.prompt : '';
      }
      for (const scenario of [
        { file: 'vue2/Vue2App.vue', marker: ' />', framework: 'vue2', self: /members:.*(?:rows|visible)/, related: /<Child> vue2\/Child\.vue:.*props rows/ },
        { file: 'vue3/Vue3App.vue', marker: ' />', framework: 'vue3', self: /members:.*count/, related: /<SetupChild> vue3\/SetupChild\.vue:.*props count/ },
        { file: 'react/ReactApp.tsx', marker: ' count={count}', framework: 'react', self: /members:.*(?:count|setCount)/, related: /<ReactChild> react\/ReactChild\.tsx:.*props count/ },
        { file: 'node/main.mts', marker: 'return read', framework: 'node', self: /members:.*main/, related: /module read node\/typed\.mts:.*read\(value:\s*string\)/ },
      ]) {
        const fixtureEditor = await showFixture(scenario.file, scenario.marker);
        let prompt = '';
        await until(async () => {
          prompt = await freshRequest(fixtureEditor);
          const ready = prompt.includes(`(${scenario.framework})`) && scenario.self.test(prompt) && scenario.related.test(prompt);
          if (!ready) {
            await pause(150);
          }
          return ready;
        }, `Skimmer header missing for ${scenario.file}: ${prompt}`, Math.max(1, deadline - Date.now()));
        record(`${scenario.framework} Skimmer self and related header`, 'production Provider + real editor + published Skimmer');
      }
      const dirtyChild = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspace, 'vue2/Child.vue')));
      const edit = new vscode.WorkspaceEdit();
      edit.insert(dirtyChild.uri, dirtyChild.positionAt(dirtyChild.getText().length), '\n<!-- unsaved dependency -->');
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      assert.equal(dirtyChild.isDirty, true);
      const vue2 = await showFixture('vue2/Vue2App.vue', ' />');
      const dirtyPrompt = await freshRequest(vue2);
      assert.ok(dirtyPrompt.includes('(vue2)') && /members:.*(?:rows|visible)/.test(dirtyPrompt));
      assert.equal(dirtyPrompt.includes('<Child> vue2/Child.vue'), false);
      record('dirty Vue dependency removed from enhancement header', 'production Provider + real unsaved document + published Skimmer');
    }

    const result = {
      vscode: vscode.version, platform: process.platform, cases: report,
      requests: server.requests.length,
      skimmer: skimmerEnabled,
      limits: [
        'Menu cases call the registered production Provider with SelectedCompletionInfo; they do not automate suggest-widget UI.',
        'Enhancement cases use the production manifest and Provider in a real editor, published Skimmer and no Vetur/Volar language service.',
        'No screenshot, real model, paid request or user SecretStorage is used.',
      ],
    };
    if (process.env.ADD_NEXT_CODE_INTEGRATION_REPORT) {
      await fs.writeFile(process.env.ADD_NEXT_CODE_INTEGRATION_REPORT, JSON.stringify(result, null, 2));
    }
    console.log(`[integration] ${report.length} cases passed on VS Code ${vscode.version}`);
  } finally {
    try {
      await vscode.commands.executeCommand('editor.action.inlineSuggest.hide');
    } finally {
      try {
        await bridge?.shutdown?.();
      } finally {
        await server.close();
      }
    }
  }
}
