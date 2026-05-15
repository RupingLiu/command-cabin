import { ResultList } from './ResultList.js';
import { SearchInput } from './SearchInput.js';
import { useLauncherController } from './useLauncherController.js';

export function LauncherPage() {
  const {
    activeDescendantId,
    appInfo,
    executeSelectedCommand,
    handleKeyDown,
    inputRef,
    isExecutionDisabled,
    isExpanded,
    resultListboxId,
    searchInputId,
    selectResult,
    setQuery,
    state,
  } = useLauncherController();
  const isBusy = state.status === 'loading' || state.status === 'executing';

  return (
    <main className="launcher-shell">
      <section className="launcher-frame" aria-label={`${appInfo.name} launcher`}>
        <header className="launcher-titlebar">
          <div className="launcher-title">
            <p className="launcher-kicker">Desktop Launcher</p>
            <h1>{appInfo.name}</h1>
          </div>
          <p className="runtime-pill">Electron {appInfo.versions.electron}</p>
        </header>

        <SearchInput
          activeDescendantId={activeDescendantId}
          inputRef={inputRef}
          isBusy={isBusy}
          isExpanded={isExpanded}
          listboxId={resultListboxId}
          onKeyDown={handleKeyDown}
          onQueryChange={setQuery}
          query={state.query}
          searchInputId={searchInputId}
        />

        <ResultList
          errorMessage={state.errorMessage}
          isExecutionDisabled={isExecutionDisabled}
          listboxId={resultListboxId}
          onExecute={executeSelectedCommand}
          onSelect={selectResult}
          query={state.query}
          results={state.results}
          selectedIndex={state.selectedIndex}
          status={state.status}
        />
      </section>
    </main>
  );
}
