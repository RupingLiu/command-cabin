import type { KeyboardEventHandler, Ref } from 'react';

interface SearchInputProps {
  activeDescendantId: string | undefined;
  inputRef: Ref<HTMLInputElement>;
  isBusy: boolean;
  isExpanded: boolean;
  label: string;
  listboxId: string;
  onKeyDown: KeyboardEventHandler<HTMLInputElement>;
  onQueryChange: (query: string) => void;
  placeholder: string;
  query: string;
  searchInputId: string;
}

export function SearchInput({
  activeDescendantId,
  inputRef,
  isBusy,
  isExpanded,
  label,
  listboxId,
  onKeyDown,
  onQueryChange,
  placeholder,
  query,
  searchInputId,
}: SearchInputProps) {
  return (
    <label className="search-box">
      <span>{label}</span>
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
          placeholder={placeholder}
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
