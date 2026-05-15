export interface PluginCommand {
  readonly id: string;
  readonly title: string;
  readonly keywords?: readonly string[];
}

export interface CommandCabinPluginContext {
  readonly appId: 'com.commandcabin.app';
  registerCommand(command: PluginCommand): void;
}

export interface CommandCabinPlugin {
  readonly id: string;
  activate(context: CommandCabinPluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
