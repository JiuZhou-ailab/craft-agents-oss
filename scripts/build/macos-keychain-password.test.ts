// input: Installed electron-builder signing implementation and a fake security command boundary
// output: Keychain unlock credentials stay separate from imported certificate passwords
// pos: Regression guard for the app-builder-lib macOS signing dependency patch

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { runInNewContext } from 'node:vm';

test('uses the generated keychain password for every partition-list update', async () => {
  const require = createRequire(import.meta.url);
  const signingPath = require.resolve('app-builder-lib/out/codeSign/macCodeSign.js');
  const signingRequire = createRequire(signingPath);
  const commands: string[][] = [];
  const exports: Record<string, any> = {};
  // Run the installed implementation without invoking security or mutating the
  // process-wide module cache used by other packaging tests.
  runInNewContext(readFileSync(signingPath, 'utf8'), {
    exports,
    __dirname: dirname(signingPath),
    process: { env: { TRAVIS: 'true' } },
    require: (name: string) => {
      if (name === 'builder-util') return {
        exec: async (command: string, args: string[]) => {
          expect(command).toBe('/usr/bin/security');
          commands.push([...args]);
          return '';
        },
      };
      if (name === './codesign') return { importCertificate: async (link: string) => link };
      return signingRequire(name);
    },
  });
  await exports.createKeychain({
    currentDir: '/signing-fixture',
    cscLink: '/fixture/application.p12', cscKeyPassword: 'application-certificate-password',
    cscILink: '/fixture/installer.p12', cscIKeyPassword: 'installer-certificate-password',
    tmpDir: {},
  });
  const create = commands.find(args => args[0] === 'create-keychain')!;
  const unlock = commands.find(args => args[0] === 'unlock-keychain')!;
  const keychainPassword = create[create.indexOf('-p') + 1];
  expect(keychainPassword).toBeTruthy();
  expect(unlock[unlock.indexOf('-p') + 1]).toBe(keychainPassword);
  expect(commands.filter(args => args[0] === 'import').map(args => args[args.indexOf('-P') + 1]))
    .toEqual(['application-certificate-password', 'installer-certificate-password']);
  expect(commands.filter(args => args[0] === 'set-key-partition-list').map(args => args[args.indexOf('-k') + 1]))
    .toEqual([keychainPassword, keychainPassword]);
});
