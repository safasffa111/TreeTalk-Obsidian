const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const originalLoad = Module._load;

class AnyBase {
  constructor() {}
}
class Plugin extends AnyBase {}
class PluginSettingTab extends AnyBase {}
class ItemView extends AnyBase {}
class MarkdownView extends ItemView {}
class Modal extends AnyBase {}
class Component extends AnyBase {}
class TFile extends AnyBase {}

Module._load = function(request, parent, isMain) {
  if (request === 'obsidian') {
    return {
      Plugin,
      PluginSettingTab,
      ItemView,
      MarkdownView,
      Modal,
      Component,
      TFile,
      Notice: class extends AnyBase {},
      Setting: class extends AnyBase {},
      MarkdownRenderer: { render: async () => undefined },
      normalizePath: (value) => value,
      requestUrl: async () => { throw new Error('not available in smoke test'); },
      setIcon: () => undefined
    };
  }
  if (request === '@codemirror/view') {
    return {
      Decoration: { replace: () => ({}) },
      MatchDecorator: class {
        createDeco() { return {}; }
        updateDeco(_update, decorations) { return decorations; }
      },
      ViewPlugin: { fromClass: () => ({}) },
      EditorView: { domEventHandlers: () => ({}) }
    };
  }
  if (request === '@codemirror/state') return {};
  return originalLoad.call(this, request, parent, isMain);
};

const smokeBundle = path.join(os.tmpdir(), `treetalk-main-${process.pid}.cjs`);
fs.copyFileSync(path.join(__dirname, '..', 'main.js'), smokeBundle);

try {
  const plugin = require(smokeBundle);
  assert.equal(plugin.PLUGIN_ID, 'treetalk');
  assert.equal(typeof plugin.default, 'function');
  assert.equal(plugin.default.prototype instanceof Plugin, true);
  console.log('plugin entry smoke: ok');
} finally {
  Module._load = originalLoad;
  fs.rmSync(smokeBundle, { force: true });
}
