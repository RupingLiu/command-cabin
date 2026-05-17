type SecondInstanceListener = () => void;

export interface SingleInstanceApp {
  on: (eventName: 'second-instance', listener: SecondInstanceListener) => unknown;
  quit: () => void;
  requestSingleInstanceLock: () => boolean;
}

export interface ConfigureSingleInstanceOptions {
  app: SingleInstanceApp;
  logger?: Pick<Console, 'error'>;
  showExistingWindow: () => Promise<void> | void;
}

export function configureSingleInstance({
  app,
  logger = console,
  showExistingWindow,
}: ConfigureSingleInstanceOptions): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }

  app.on('second-instance', () => {
    Promise.resolve(showExistingWindow()).catch((error: unknown) => {
      logger.error('Failed to show the existing CommandCabin instance.', error);
    });
  });

  return true;
}
