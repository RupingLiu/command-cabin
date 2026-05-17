# CommandCabin

CommandCabin is a lightweight quick command console for your computer. It brings apps, files, folders, URLs, clipboard actions, text utilities, and plugin commands into one fast desktop entry point so you can search, choose, and run actions from the keyboard.

[中文 README](README.md)

## Positioning

CommandCabin is built for everyday desktop productivity with a light, fast, local-first approach:

- Lightweight: focused on quick launching and command execution without bloating the workflow.
- Quick command console: open it with a global hotkey and use one input box to search, select, and run commands.
- Local-first: app indexes, favorites, history, and settings are stored locally first.
- Plugin-first: the core stays small while built-in and local plugins extend more workflows.
- Windows-first: the current version prioritizes a polished Windows desktop experience.

## Core Features

- Global hotkey launcher.
- Search apps, favorite files, folders, and URLs.
- Unified command registration, ranking, and execution.
- Local settings, command history, and clipboard history storage.
- Built-in calculator, clipboard history, text tools, and quick converter.
- Local plugin runtime and hosted plugin pages.

## Tech Stack

- Electron
- TypeScript
- React
- Vite
- SQLite
- Fuse.js
- Vitest
- electron-builder

## Development

Install dependencies:

```powershell
corepack pnpm install
```

Run the desktop app:

```powershell
corepack pnpm dev
```

Common checks:

```powershell
corepack pnpm test
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format
```

Build:

```powershell
corepack pnpm build
```

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).

## Status

CommandCabin is under active development, with the Windows MVP being refined. More detailed design and verification notes live in:

- `docs/superpowers/specs/`
- `docs/product/beta-release-checklist.md`
