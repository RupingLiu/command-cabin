import { contextBridge, ipcRenderer } from 'electron';

import { installPluginBridge } from '../renderer/src/plugin-host/pluginBridge.js';

installPluginBridge(contextBridge, ipcRenderer);
