import { describe, expect, it } from 'vitest';

import {
  createWindowsAppsFolderScanner,
  createWindowsShortcutResolver,
  createWindowsStartMenuScanner,
  type ShortcutResolver,
  type StartMenuFileSystem,
} from './startMenuScanner.js';

function createFileSystem(
  entriesByDirectory: Record<string, Awaited<ReturnType<StartMenuFileSystem['readDirectory']>>>,
): StartMenuFileSystem {
  return {
    readDirectory: async (directoryPath) => entriesByDirectory[directoryPath] ?? [],
  };
}

const emptyAppsFolderScanner = {
  scan: async () => ({
    apps: [],
    failures: [],
  }),
};

describe('Windows start menu scanner', () => {
  it('builds the default AppsFolder scanner and parses AppUserModelID entries', async () => {
    const execFileCalls: Array<{
      file: string;
      args: readonly string[];
      options: { windowsHide: true; timeout: number; encoding: 'utf8' };
    }> = [];
    const scanner = createWindowsAppsFolderScanner({
      platform: 'win32',
      timeoutMs: 12_345,
      execFile: async (file, args, options) => {
        execFileCalls.push({ file, args, options });

        return {
          stdout: JSON.stringify([
            {
              name: '1Password',
              appUserModelId: 'DC5C6510.2032887045529_2v019pwa6amcg!Agilebits.OnePassword',
            },
            {
              name: 'Broken',
              appUserModelId: 'C:\\Program Files\\Broken\\Broken.exe',
            },
          ]),
        };
      },
    });

    await expect(scanner.scan()).resolves.toEqual({
      apps: [
        {
          name: '1Password',
          appUserModelId: 'DC5C6510.2032887045529_2v019pwa6amcg!Agilebits.OnePassword',
        },
      ],
      failures: [],
    });
    expect(execFileCalls).toHaveLength(1);
    expect(execFileCalls[0]?.file).toBe('powershell.exe');
    expect(execFileCalls[0]?.options).toEqual({
      windowsHide: true,
      timeout: 12_345,
      encoding: 'utf8',
    });
    const encodedCommand = execFileCalls[0]?.args[5];
    expect(encodedCommand).toEqual(expect.any(String));

    const commandScript = Buffer.from(encodedCommand ?? '', 'base64').toString('utf16le');
    expect(commandScript).toContain("$shell.Namespace('shell:AppsFolder')");
    expect(commandScript).toContain('$item.Path');
  });

  it('builds the default PowerShell shortcut resolver without splitting paths that contain spaces', async () => {
    const shortcutPath = 'C:\\Start Menu\\Programs\\Sample App.lnk';
    const execFileCalls: Array<{
      file: string;
      args: readonly string[];
      options: { windowsHide: true; timeout: number; encoding: 'utf8' };
    }> = [];
    const resolver = createWindowsShortcutResolver({
      platform: 'win32',
      timeoutMs: 12_345,
      execFile: async (file, args, options) => {
        execFileCalls.push({ file, args, options });

        return {
          stdout: JSON.stringify({
            targetPath: 'C:\\Program Files\\示例\\应用.exe',
            arguments: '--new-window',
            workingDirectory: 'C:\\用户\\Ada\\工作区',
            iconPath: 'C:\\Program Files\\示例\\图标.ico',
            appUserModelId: 'Sample.App_abc123!App',
          }),
        };
      },
    });

    const shortcut = await resolver.resolve(shortcutPath);

    expect(shortcut).toEqual({
      targetPath: 'C:\\Program Files\\示例\\应用.exe',
      arguments: '--new-window',
      workingDirectory: 'C:\\用户\\Ada\\工作区',
      iconPath: 'C:\\Program Files\\示例\\图标.ico',
      appUserModelId: 'Sample.App_abc123!App',
    });
    expect(execFileCalls).toHaveLength(1);
    expect(execFileCalls[0]?.file).toBe('powershell.exe');
    expect(execFileCalls[0]?.options).toEqual({
      windowsHide: true,
      timeout: 12_345,
      encoding: 'utf8',
    });
    expect(execFileCalls[0]?.args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
    ]);
    expect(execFileCalls[0]?.args).toHaveLength(6);
    const encodedCommand = execFileCalls[0]?.args[5];
    expect(encodedCommand).toEqual(expect.any(String));

    const commandScript = Buffer.from(encodedCommand ?? '', 'base64').toString('utf16le');
    expect(commandScript).toContain(
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    );
    expect(commandScript).toContain('[System.Convert]::FromBase64String(');
    const embeddedPath = commandScript.match(/FromBase64String\('([^']+)'\)/)?.[1];
    expect(embeddedPath).toEqual(expect.any(String));
    expect(Buffer.from(embeddedPath ?? '', 'base64').toString('utf8')).toBe(shortcutPath);
    expect(commandScript).toContain('$shell.CreateShortcut($ShortcutPath)');
    expect(commandScript).toContain('$folder.GetDetailsOf($item, 204)');
    expect(commandScript).not.toContain(shortcutPath);
    expect(commandScript).not.toContain('$args[0]');
  });

  it('reports default resolver timeouts as shortcut scan failures', async () => {
    const scanner = createWindowsStartMenuScanner({
      appsFolderScanner: emptyAppsFolderScanner,
      startMenuDirectories: ['C:\\StartMenu'],
      fileSystem: createFileSystem({
        'C:\\StartMenu': [{ name: 'Slow App.lnk', kind: 'file' }],
      }),
      shortcutResolver: createWindowsShortcutResolver({
        platform: 'win32',
        timeoutMs: 25,
        execFile: async () => {
          throw Object.assign(new Error('operation timed out'), {
            killed: true,
            signal: 'SIGTERM',
          });
        },
      }),
    });

    await expect(scanner.scan()).resolves.toEqual({
      shortcuts: [],
      failures: [
        {
          shortcutPath: 'C:\\StartMenu\\Slow App.lnk',
          message: 'Shortcut resolution timed out after 25 ms.',
        },
      ],
    });
  });

  it('recursively scans configured start menu directories for shortcut entries', async () => {
    const resolvedShortcutPaths: string[] = [];
    const scanner = createWindowsStartMenuScanner({
      appsFolderScanner: emptyAppsFolderScanner,
      startMenuDirectories: ['C:\\Users\\Ada\\Start Menu\\Programs'],
      fileSystem: createFileSystem({
        'C:\\Users\\Ada\\Start Menu\\Programs': [
          { name: 'Tools', kind: 'directory' },
          { name: 'Calculator.lnk', kind: 'file' },
        ],
        'C:\\Users\\Ada\\Start Menu\\Programs\\Tools': [
          { name: 'Paint.lnk', kind: 'file' },
          { name: 'readme.txt', kind: 'file' },
        ],
      }),
      shortcutResolver: {
        resolve: async (shortcutPath) => {
          resolvedShortcutPaths.push(shortcutPath);
          return {
            targetPath: shortcutPath.endsWith('Paint.lnk')
              ? 'C:\\Windows\\System32\\mspaint.exe'
              : 'C:\\Windows\\System32\\calc.exe',
          };
        },
      },
    });

    const result = await scanner.scan();

    expect(resolvedShortcutPaths).toEqual([
      'C:\\Users\\Ada\\Start Menu\\Programs\\Tools\\Paint.lnk',
      'C:\\Users\\Ada\\Start Menu\\Programs\\Calculator.lnk',
    ]);
    expect(result.shortcuts).toEqual([
      {
        name: 'Paint',
        shortcutPath: 'C:\\Users\\Ada\\Start Menu\\Programs\\Tools\\Paint.lnk',
        targetPath: 'C:\\Windows\\System32\\mspaint.exe',
      },
      {
        name: 'Calculator',
        shortcutPath: 'C:\\Users\\Ada\\Start Menu\\Programs\\Calculator.lnk',
        targetPath: 'C:\\Windows\\System32\\calc.exe',
      },
    ]);
    expect(result.failures).toEqual([]);
  });

  it('includes AppsFolder entries that do not have traditional shortcut files', async () => {
    const scanner = createWindowsStartMenuScanner({
      startMenuDirectories: ['C:\\StartMenu'],
      fileSystem: createFileSystem({
        'C:\\StartMenu': [],
      }),
      appsFolderScanner: {
        scan: async () => ({
          apps: [
            {
              name: '1Password',
              appUserModelId: 'DC5C6510.2032887045529_2v019pwa6amcg!Agilebits.OnePassword',
            },
          ],
          failures: [],
        }),
      },
    });

    await expect(scanner.scan()).resolves.toEqual({
      shortcuts: [
        {
          name: '1Password',
          appUserModelId: 'DC5C6510.2032887045529_2v019pwa6amcg!Agilebits.OnePassword',
          opensApplication: true,
          shortcutPath:
            'shell:AppsFolder\\DC5C6510.2032887045529_2v019pwa6amcg!Agilebits.OnePassword',
        },
      ],
      failures: [],
    });
  });

  it('scans configured desktop directories without recursing and keeps unresolved desktop shortcuts', async () => {
    const resolvedShortcutPaths: string[] = [];
    const scanner = createWindowsStartMenuScanner({
      appsFolderScanner: emptyAppsFolderScanner,
      desktopDirectories: ['C:\\Users\\Ada\\Desktop'],
      startMenuDirectories: ['C:\\StartMenu'],
      fileSystem: createFileSystem({
        'C:\\StartMenu': [{ name: 'Notepad.lnk', kind: 'file' }],
        'C:\\Users\\Ada\\Desktop': [
          { name: 'Codex.lnk', kind: 'file' },
          { name: 'Nested', kind: 'directory' },
        ],
        'C:\\Users\\Ada\\Desktop\\Nested': [{ name: 'Hidden.lnk', kind: 'file' }],
      }),
      shortcutResolver: {
        resolve: async (shortcutPath) => {
          resolvedShortcutPaths.push(shortcutPath);

          if (shortcutPath.endsWith('Codex.lnk')) {
            throw new Error('cannot parse shortcut');
          }

          return { targetPath: 'C:\\Windows\\System32\\notepad.exe' };
        },
      },
    });

    const result = await scanner.scan();

    expect(resolvedShortcutPaths).toEqual([
      'C:\\StartMenu\\Notepad.lnk',
      'C:\\Users\\Ada\\Desktop\\Codex.lnk',
    ]);
    expect(result.shortcuts).toEqual([
      {
        name: 'Notepad',
        shortcutPath: 'C:\\StartMenu\\Notepad.lnk',
        targetPath: 'C:\\Windows\\System32\\notepad.exe',
      },
      {
        name: 'Codex',
        opensApplication: true,
        shortcutPath: 'C:\\Users\\Ada\\Desktop\\Codex.lnk',
      },
    ]);
    expect(result.failures).toEqual([
      {
        shortcutPath: 'C:\\Users\\Ada\\Desktop\\Codex.lnk',
        message: 'cannot parse shortcut',
      },
    ]);
  });

  it('ignores non-lnk files and entries that are neither files nor directories', async () => {
    const resolvedShortcutPaths: string[] = [];
    const scanner = createWindowsStartMenuScanner({
      appsFolderScanner: emptyAppsFolderScanner,
      startMenuDirectories: ['C:\\StartMenu'],
      fileSystem: createFileSystem({
        'C:\\StartMenu': [
          { name: 'notes.url', kind: 'file' },
          { name: 'broken', kind: 'other' },
          { name: 'Terminal.LNK', kind: 'file' },
        ],
      }),
      shortcutResolver: {
        resolve: async (shortcutPath) => {
          resolvedShortcutPaths.push(shortcutPath);
          return { targetPath: 'C:\\Users\\Ada\\AppData\\Local\\Terminal\\wt.exe' };
        },
      },
    });

    const result = await scanner.scan();

    expect(resolvedShortcutPaths).toEqual(['C:\\StartMenu\\Terminal.LNK']);
    expect(result.shortcuts).toHaveLength(1);
    expect(result.shortcuts[0]).toMatchObject({
      name: 'Terminal',
      shortcutPath: 'C:\\StartMenu\\Terminal.LNK',
    });
  });

  it('records resolver failures and continues scanning other shortcuts', async () => {
    const resolver: ShortcutResolver = {
      resolve: async (shortcutPath) => {
        if (shortcutPath.endsWith('Broken.lnk')) {
          throw new Error('cannot parse shortcut');
        }

        return { targetPath: 'C:\\Windows\\System32\\notepad.exe' };
      },
    };
    const scanner = createWindowsStartMenuScanner({
      appsFolderScanner: emptyAppsFolderScanner,
      startMenuDirectories: ['C:\\StartMenu'],
      fileSystem: createFileSystem({
        'C:\\StartMenu': [
          { name: 'Broken.lnk', kind: 'file' },
          { name: 'Notepad.lnk', kind: 'file' },
        ],
      }),
      shortcutResolver: resolver,
    });

    const result = await scanner.scan();

    expect(result.shortcuts).toEqual([
      {
        name: 'Notepad',
        shortcutPath: 'C:\\StartMenu\\Notepad.lnk',
        targetPath: 'C:\\Windows\\System32\\notepad.exe',
      },
    ]);
    expect(result.failures).toEqual([
      {
        shortcutPath: 'C:\\StartMenu\\Broken.lnk',
        message: 'cannot parse shortcut',
      },
    ]);
  });
});
