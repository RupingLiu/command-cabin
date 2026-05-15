import type { KeyboardEventHandler, Ref } from 'react';

interface SearchInputProps {
  activeDescendantId: string | undefined;
  inputRef: Ref<HTMLInputElement>;
  isBusy: boolean;
  isExpanded: boolean;
  listboxId: string;
  onKeyDown: KeyboardEventHandler<HTMLInputElement>;
  onQueryChange: (query: string) => void;
  query: string;
  searchInputId: string;
}

export function SearchInput({
  activeDescendantId,
  inputRef,
  isBusy,
  isExpanded,
  listboxId,
  onKeyDown,
  onQueryChange,
  query,
  searchInputId,
}: SearchInputProps) {
  return (
    <label className="search-box">
      <span>Search</span>
      <div className="search-field-wrap" data-busy={isBusy}>
        <input
          aria-activedescendant={activeDescendantId}
          aria-busy={isBusy}
          aria-controls={listboxId}
          aria-expanded={isExpanded}
          autoComplete="off"
          autoCorrect="off"
          autoFocus
          id={searchInputId}
          onChange={(event) => {
            onQueryChange(event.currentTarget.value);
          }}
          onKeyDown={onKeyDown}
          placeholder="Type a command"
          ref={inputRef}
          role="combobox"
          spellCheck={false}
          type="search"
          value={query}
        />
      </div>
    </label>
  );
}
