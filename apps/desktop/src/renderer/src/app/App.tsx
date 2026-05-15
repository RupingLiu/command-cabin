import './App.css';

const fallbackAppInfo = {
  name: 'CommandCabin',
  versions: {
    chrome: 'Chromium',
    electron: 'Electron',
    node: 'Node',
  },
};

const starterCommands = [
  {
    accent: 'blue',
    title: 'Open Applications',
    meta: 'Apps',
  },
  {
    accent: 'gold',
    title: 'Search Files',
    meta: 'Files',
  },
  {
    accent: 'coral',
    title: 'Run Command',
    meta: 'System',
  },
] as const;

function readAppInfo() {
  if ('desktopApi' in window) {
    return window.desktopApi.getAppInfo();
  }

  return fallbackAppInfo;
}

export function App() {
  const appInfo = readAppInfo();

  return (
    <main className="launcher-shell">
      <section className="launcher-frame" aria-label={`${appInfo.name} launcher`}>
        <header className="launcher-titlebar">
          <div>
            <p className="launcher-kicker">Desktop Launcher</p>
            <h1>{appInfo.name}</h1>
          </div>
          <p className="runtime-pill">Electron {appInfo.versions.electron}</p>
        </header>

        <label className="search-box">
          <span>Search</span>
          <input autoFocus placeholder="Type to launch" />
        </label>

        <div className="command-list" aria-label="Starter commands">
          {starterCommands.map((command) => (
            <article className="command-row" data-accent={command.accent} key={command.title}>
              <span className="command-mark" aria-hidden="true" />
              <div>
                <h2>{command.title}</h2>
                <p>{command.meta}</p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
