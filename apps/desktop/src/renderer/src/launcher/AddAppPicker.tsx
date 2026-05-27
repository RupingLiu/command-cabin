import type { CommandCabinLanguage } from '@command-cabin/core';
import type { AppCandidate } from '../../../shared/appCandidatesApi.js';
import type { FavoriteListRecord } from '../../../shared/favoritesApi.js';
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getUiStrings } from '../i18n.js';

type AddAppPickerStatus = 'loading' | 'ready' | 'empty' | 'error';

interface AddAppPickerApi {
  addPinnedApp: () => Promise<FavoriteListRecord | undefined>;
  addPinnedAppCandidate: (candidate: AppCandidate) => Promise<FavoriteListRecord>;
  listAppCandidates: (query?: string | undefined) => Promise<AppCandidate[]>;
}

export interface AddAppPickerProps {
  language?: CommandCabinLanguage | undefined;
  onClose: () => void;
  onPinnedAppAdded: () => void;
}

interface AddAppPickerViewProps extends AddAppPickerProps {
  candidates: AppCandidate[];
  errorMessage?: string | undefined;
  isAdding: boolean;
  onAddCandidate: (candidate: AppCandidate) => void;
  onBrowseLocalFile: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onQueryChange: (query: string) => void;
  query: string;
  selectedIndex: number;
  status: AddAppPickerStatus;
}

const fallbackApi: AddAppPickerApi = {
  addPinnedApp: async () => undefined,
  addPinnedAppCandidate: async (candidate) => ({
    createdAt: new Date(0).toISOString(),
    id: `fallback.${candidate.id}`,
    kind: 'file',
    keywords: [candidate.title],
    metadata: {
      launcherPinnedApp: true,
    },
    path: candidate.shortcutPath,
    title: candidate.title,
    updatedAt: new Date(0).toISOString(),
  }),
  listAppCandidates: async () => [],
};

function getDesktopApi(): AddAppPickerApi {
  if (typeof window !== 'undefined' && 'desktopApi' in window) {
    return window.desktopApi;
  }

  return fallbackApi;
}

function getInitialGlyph(title: string): string {
  return title.trim().charAt(0).toUpperCase() || '?';
}

function isImageDataUrl(icon: string | undefined): icon is string {
  return typeof icon === 'string' && icon.startsWith('data:image/');
}

export type RenderableAppCandidateIcon =
  | {
      kind: 'glyph';
      value: string;
    }
  | {
      kind: 'image';
      src: string;
    };

export function getRenderableAppCandidateIcon(
  candidate: AppCandidate,
  failedImageIcon?: string | undefined,
): RenderableAppCandidateIcon {
  if (isImageDataUrl(candidate.icon) && candidate.icon !== failedImageIcon) {
    return {
      kind: 'image',
      src: candidate.icon,
    };
  }

  return {
    kind: 'glyph',
    value: getInitialGlyph(candidate.title),
  };
}

function AddAppCandidateIcon({ candidate }: { candidate: AppCandidate }) {
  const [failedImageIcon, setFailedImageIcon] = useState<string | undefined>(undefined);
  const renderableIcon = getRenderableAppCandidateIcon(candidate, failedImageIcon);

  return (
    <span className="add-app-candidate__icon" aria-hidden="true">
      {renderableIcon.kind === 'image' ? (
        <img
          alt=""
          src={renderableIcon.src}
          onError={() => {
            setFailedImageIcon(renderableIcon.src);
          }}
        />
      ) : (
        renderableIcon.value
      )}
    </span>
  );
}

function formatUnknownError(error: unknown, fallbackMessage: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }

  return fallbackMessage;
}

function getSelectableCandidateIndex(
  candidates: readonly AppCandidate[],
  selectedIndex: number,
  direction: 'next' | 'previous',
): number {
  if (candidates.length === 0) {
    return -1;
  }

  const delta = direction === 'next' ? 1 : -1;
  const baseIndex = selectedIndex < 0 ? 0 : selectedIndex;

  return (baseIndex + delta + candidates.length) % candidates.length;
}

export function AddAppPickerView({
  candidates,
  errorMessage,
  isAdding,
  language,
  onAddCandidate,
  onBrowseLocalFile,
  onClose,
  onKeyDown,
  onQueryChange,
  query,
  selectedIndex,
  status,
}: AddAppPickerViewProps) {
  const strings = getUiStrings(language);
  const pickerStrings = strings.launcher.appPicker;

  return (
    <div className="add-app-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-label={pickerStrings.ariaLabel}
        aria-modal="true"
        className="add-app-picker"
        role="dialog"
        onKeyDown={onKeyDown}
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
      >
        <header className="add-app-picker__header">
          <div>
            <h2>{pickerStrings.title}</h2>
            <p>{pickerStrings.searchPlaceholder}</p>
          </div>
          <button
            aria-label={strings.common.cancel}
            className="add-app-picker__close"
            type="button"
            onClick={onClose}
          >
            x
          </button>
        </header>

        <label className="add-app-picker__search">
          <span>{pickerStrings.searchLabel}</span>
          <input
            autoFocus
            placeholder={pickerStrings.searchPlaceholder}
            type="search"
            value={query}
            onChange={(event) => {
              onQueryChange(event.currentTarget.value);
            }}
          />
        </label>

        <div className="add-app-picker__body">
          {status === 'loading' ? (
            <div className="add-app-picker__state" role="status">
              {pickerStrings.loading}
            </div>
          ) : null}
          {status === 'error' ? (
            <div className="add-app-picker__state" data-tone="error" role="alert">
              {errorMessage}
            </div>
          ) : null}
          {status === 'empty' ? (
            <div className="add-app-picker__state" role="status">
              <strong>{pickerStrings.emptyTitle}</strong>
              <span>{pickerStrings.emptyDetail}</span>
            </div>
          ) : null}
          {status === 'ready' ? (
            <ul className="add-app-candidates">
              {candidates.map((candidate, index) => (
                <li
                  className="add-app-candidate"
                  data-selected={index === selectedIndex}
                  key={candidate.id}
                >
                  <AddAppCandidateIcon candidate={candidate} />
                  <span className="add-app-candidate__copy">
                    <span className="add-app-candidate__title">{candidate.title}</span>
                    <span className="add-app-candidate__detail">
                      {pickerStrings.sources[candidate.source]} ·{' '}
                      {candidate.resolutionStatus === 'unresolved-shortcut'
                        ? pickerStrings.unresolvedShortcut
                        : candidate.subtitle}
                    </span>
                  </span>
                  <button
                    disabled={candidate.alreadyPinned || isAdding}
                    type="button"
                    onClick={() => {
                      onAddCandidate(candidate);
                    }}
                  >
                    {candidate.alreadyPinned ? pickerStrings.added : pickerStrings.add}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <footer className="add-app-picker__footer">
          <button type="button" onClick={onBrowseLocalFile}>
            {pickerStrings.browseLocalFile}
          </button>
        </footer>
      </section>
    </div>
  );
}

export function AddAppPicker({ language, onClose, onPinnedAppAdded }: AddAppPickerProps) {
  const desktopApi = useMemo(getDesktopApi, []);
  const [candidates, setCandidates] = useState<AppCandidate[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [isAdding, setIsAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [status, setStatus] = useState<AddAppPickerStatus>('loading');
  const lastQueryRef = useRef<string | undefined>(undefined);
  const isMountedRef = useRef(false);
  const nextRequestIdRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const normalizedQuery = query.trim();

    if (lastQueryRef.current === normalizedQuery) {
      return;
    }

    lastQueryRef.current = normalizedQuery;
    const requestId = nextRequestIdRef.current + 1;
    nextRequestIdRef.current = requestId;
    setStatus('loading');
    setErrorMessage(undefined);

    desktopApi
      .listAppCandidates(normalizedQuery)
      .then((nextCandidates) => {
        if (!isMountedRef.current || nextRequestIdRef.current !== requestId) {
          return;
        }

        setCandidates(nextCandidates);
        setSelectedIndex(nextCandidates.length > 0 ? 0 : -1);
        setStatus(nextCandidates.length > 0 ? 'ready' : 'empty');
      })
      .catch((error: unknown) => {
        if (!isMountedRef.current || nextRequestIdRef.current !== requestId) {
          return;
        }

        setCandidates([]);
        setSelectedIndex(-1);
        setErrorMessage(formatUnknownError(error, 'Could not load application candidates.'));
        setStatus('error');
      });
  }, [desktopApi, query]);

  const addCandidate = useCallback(
    async (candidate: AppCandidate) => {
      if (candidate.alreadyPinned || isAdding) {
        return;
      }

      setIsAdding(true);
      setErrorMessage(undefined);

      try {
        await desktopApi.addPinnedAppCandidate(candidate);
        onPinnedAppAdded();
        onClose();
      } catch (error) {
        setErrorMessage(formatUnknownError(error, 'Could not add application.'));
        setStatus('error');
      } finally {
        setIsAdding(false);
      }
    },
    [desktopApi, isAdding, onClose, onPinnedAppAdded],
  );

  const browseLocalFile = useCallback(async () => {
    setIsAdding(true);
    setErrorMessage(undefined);

    try {
      const favorite = await desktopApi.addPinnedApp();

      if (favorite !== undefined) {
        onPinnedAppAdded();
        onClose();
      }
    } catch (error) {
      setErrorMessage(formatUnknownError(error, 'Could not add application.'));
      setStatus('error');
    } finally {
      setIsAdding(false);
    }
  }, [desktopApi, onClose, onPinnedAppAdded]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedIndex((currentIndex) =>
          getSelectableCandidateIndex(
            candidates,
            currentIndex,
            event.key === 'ArrowDown' ? 'next' : 'previous',
          ),
        );
        return;
      }

      if (event.key === 'Enter' && selectedIndex >= 0) {
        event.preventDefault();
        void addCandidate(candidates[selectedIndex]!);
      }
    },
    [addCandidate, candidates, onClose, selectedIndex],
  );

  return (
    <AddAppPickerView
      candidates={candidates}
      errorMessage={errorMessage}
      isAdding={isAdding}
      language={language}
      query={query}
      selectedIndex={selectedIndex}
      status={status}
      onAddCandidate={(candidate) => {
        void addCandidate(candidate);
      }}
      onBrowseLocalFile={() => {
        void browseLocalFile();
      }}
      onClose={onClose}
      onKeyDown={handleKeyDown}
      onQueryChange={setQuery}
      onPinnedAppAdded={onPinnedAppAdded}
    />
  );
}
