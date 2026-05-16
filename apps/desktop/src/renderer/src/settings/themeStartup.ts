import type { CommandCabinTheme } from '@command-cabin/core';

import { applyThemePreferenceToRoot, type ThemeRoot } from './ThemeSettings.js';

export interface ThemeStartupApi {
  getSettings: () => Promise<{
    theme: CommandCabinTheme;
  }>;
}

export async function bootstrapPersistedTheme(
  api: ThemeStartupApi | undefined,
  root: ThemeRoot,
  prefersLight?: () => boolean,
): Promise<void> {
  if (!api) {
    applyThemePreferenceToRoot('system', root, prefersLight);
    return;
  }

  try {
    const settings = await api.getSettings();
    applyThemePreferenceToRoot(settings.theme, root, prefersLight);
  } catch {
    applyThemePreferenceToRoot('system', root, prefersLight);
  }
}
