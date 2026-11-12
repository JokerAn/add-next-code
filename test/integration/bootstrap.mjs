import * as vscode from 'vscode';
import { activate as productionActivate, deactivate as productionDeactivate } from '../../src/extension.ts';

export async function activate(context) {
  const values = new Map([['addNextCode.apiKey', 'integration-loopback-key']]);
  const changed = new vscode.EventEmitter();
  // Only replace the credential store. All subscriptions, editor/workspace APIs,
  // registrations, configuration, requests and cancellation are production code.
  const secrets = {
    get: async (key) => values.get(key),
    store: async (key, value) => { values.set(key, value); changed.fire({ key }); },
    delete: async (key) => { values.delete(key); changed.fire({ key }); },
    onDidChange: changed.event,
  };
  context.subscriptions.push(changed);
  await productionActivate(new Proxy({}, {
    get(_target, property) {
      if (property === 'secrets') {
        return secrets;
      }
      const value = Reflect.get(context, property);
      return typeof value === 'function' ? value.bind(context) : value;
    },
  }));
  const bridge = vscode.default.__integrationBridge;
  bridge.shutdown = async () => {
    await productionDeactivate();
    for (const subscription of context.subscriptions.splice(0)) {
      await subscription.dispose();
    }
  };
  return bridge;
}
export const deactivate = productionDeactivate;
