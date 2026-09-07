# Dependency patches

`package.json` and `bun.lock` apply these patches during frozen installs, including
the Windows hoisted install. No install-time scripts or credentials are required.

- `app-builder-lib@26.4.0.patch` backports upstream
  [7abb30e / #10101](https://github.com/electron-userland/electron-builder/commit/7abb30e393326676237862163a115c96e2f0e80d):
  `security set-key-partition-list -k` needs the generated keychain password,
  while `security import -P` needs the certificate password. Remove the patch
  when the locked electron-builder release includes this fix; the installed-code
  regression in `scripts/build/macos-keychain-password.test.ts` must still pass.
