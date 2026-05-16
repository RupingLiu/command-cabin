import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App.js';
import { bootstrapPersistedTheme } from './settings/themeStartup.js';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('CommandCabin renderer root element is missing.');
}

const desktopApi = 'desktopApi' in window ? window.desktopApi : undefined;

void bootstrapPersistedTheme(desktopApi, document.documentElement);

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
