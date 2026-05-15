# CommandCabin Desktop

Electron downloads its runtime binary during package installation. The workspace allows the
`electron` and `esbuild` install scripts in `pnpm-workspace.yaml`, so a normal install should
prepare the desktop app.

If Electron downloads time out on GitHub, configure a mirror or proxy before installing or
repairing the binary:

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
corepack pnpm install
```

To repair an existing checkout without hiding downloads inside every dev launch:

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
corepack pnpm --filter @command-cabin/desktop electron:repair
```

Check the local Electron binary with:

```powershell
corepack pnpm --filter @command-cabin/desktop doctor
```
