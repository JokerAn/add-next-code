// Test-only adapter: keep real VS Code registration and editor APIs; capture the
// production provider so SCI contracts can be tested without automating menu UI.
const vscode = require('vscode');
const bridge = { provider: undefined, calls: [], results: [] };
const languages = new Proxy(vscode.languages, {
  get(target, property) {
    if (property === 'registerInlineCompletionItemProvider') {
      return (selector, provider) => {
      bridge.provider = provider;
      return vscode.languages.registerInlineCompletionItemProvider(selector, {
        async provideInlineCompletionItems(...args) {
          bridge.calls.push(args);
          const result = await provider.provideInlineCompletionItems(...args);
          bridge.results.push(result);
          return result;
        },
      });
      };
    }
    return Reflect.get(target, property);
  },
});
module.exports = new Proxy(vscode, {
  get(target, property) {
    if (property === '__integrationBridge') {
      return bridge;
    }
    if (property === 'languages') {
      return languages;
    }
    return Reflect.get(target, property);
  },
});
